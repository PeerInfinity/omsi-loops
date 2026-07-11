// automation.js — Advanced Automation controller (fork addition).
//
// Player-facing surface for the IdlePlanner queue planner (planner.js /
// planner-worker.js). Conventions (mirroring the JtA fork's
// advanced_automation precedent):
//   - EVERYTHING defaults off: one master gate (`advancedAutomation` in the
//     Extras menu) reveals the controls; the planner itself only acts when
//     `plannerMode` is set to "suggest" or "auto".
//   - Every parameter the planner uses is surfaced as an option (objective
//     weights, screen K, probe cadence, predictor seeding, pause behavior).
//   - Manual queue editing always wins: in Auto mode, a hand-edited queue is
//     detected at the loop boundary and the planner disengages to Suggest.
//
// Modes:
//   off      — planner idle.
//   suggest  — a plan is computed each loop boundary (and on Plan Now) but
//              only displayed; Apply Suggestion installs it.
//   auto     — the planner owns the queue: with Pause While Planning on
//              (default), the game pauses at each loop boundary until the
//              plan for the next loop arrives (the planner plays exactly the
//              loop it planned — the headless-verified configuration); with
//              it off, planning is fire-and-forget and installs one loop
//              behind.
//
// All heavy work (probing, measurement, candidate evaluation) happens in
// planner-worker.js on a PRIVATE copy of the game state; the live game is
// never rolled back.

// eslint-disable-next-line no-unused-vars
const AdvancedAutomation = (() => {
"use strict";

let worker = null;
let reqId = 0;
let awaitingPlan = false;
let pausedByPlanner = false;
let suggestion = null;          // last worker result (queue not yet installed unless auto)
let installedQueueJSON = null;  // what auto mode last installed (manual-edit detection)
let lastError = null;

const isEnabled = () => !!options.advancedAutomation && options.plannerMode !== "off";

function currentWeights() {
    return {
        town: options.plannerWeightTown,
        unlockAction: options.plannerWeightUnlockAction,
        visibleAction: options.plannerWeightVisibleAction,
        frontier: options.plannerWeightFrontier,
        mana: options.plannerWeightMana,
        bank: options.plannerWeightBank,
        bankPot: options.plannerWeightBankPot,
        talent: options.plannerWeightTalent,
        travelRelief: options.plannerWeightTravelRelief,
        headroom: options.plannerWeightHeadroom,
    };
}

function setStatus(text) {
    const el = document.getElementById("plannerStatus");
    if (el) el.textContent = text;
}

function currentQueuePairs() {
    return actions.next.map(a => [a.name, a.loops]);
}

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker("planner-worker.js");
    worker.onmessage = (e) => {
        const msg = e.data;
        if (!msg?.type) return;
        if (msg.type === "result") onResult(msg);
        else if (msg.type === "error") onError(msg);
    };
    worker.onerror = (e) => onError({ message: e.message ?? "worker error" });
    return worker;
}

function shutdownWorker() {
    if (worker) { worker.terminate(); worker = null; }
    awaitingPlan = false;
    resumeIfPlannerPaused();
}

function resumeIfPlannerPaused() {
    if (pausedByPlanner) {
        pausedByPlanner = false;
        if (gameIsStopped) pauseGame();   // toggle back to running (auto-restarts at a boundary)
    }
}

function requestPlan(reason) {
    if (!isEnabled() || awaitingPlan) return;
    ensureWorker();
    awaitingPlan = true;
    lastError = null;
    worker.postMessage({
        type: "plan",
        reqId: ++reqId,
        save: doSave(),
        params: {
            weights: currentWeights(),
            screenK: options.plannerScreenK,
            probeEvery: options.plannerProbeEvery,
            seedFromPredictor: options.plannerSeedFromPredictor,
            multiTown: options.plannerMultiTown,
            // game-sim option, not planner state: the worker's engine copy
            // must gain exp at the live game's rate or measured profiles
            // diverge from committed play
            expGainMultiplier: options.expGainMultiplier ?? 1,
        },
        actualQueue: currentQueuePairs(),
    });
    setStatus(`planning (${reason})…`);
}

function installQueue(q) {
    actions.clearActions();
    for (const [name, loops] of q) actions.addAction(name, loops);
    installedQueueJSON = JSON.stringify(currentQueuePairs());
    view.requestUpdate("updateNextActions");
}

function onResult(msg) {
    awaitingPlan = false;
    suggestion = msg;
    const div = msg.divergenceCount ? `, ${msg.divergenceCount} predictor divergence${msg.divergenceCount === 1 ? "" : "s"}` : "";
    setStatus(`plan: ${msg.label} (score ${Math.round(msg.score)}, ${(msg.wallMs / 1000).toFixed(1)}s${div})`);
    if (options.advancedAutomation && options.plannerMode === "auto") {
        installQueue(msg.queue);
        resumeIfPlannerPaused();
    }
}

function onError(msg) {
    awaitingPlan = false;
    lastError = msg.message;
    setStatus(`planner error: ${msg.message}`);
    // never leave the game soft-locked behind a failed plan
    resumeIfPlannerPaused();
}

// Called from prepareRestart() with the already-fetched curAction; returns
// true when the automation takes over the restart (game stays stopped until
// the plan arrives).
function interceptPrepareRestart(curAction) {
    if (!isEnabled()) return false;

    // Manual queue editing always wins: if the queue at this boundary is not
    // the one auto mode installed, the player edited it — disengage to
    // Suggest and let the player's queue run.
    if (options.plannerMode === "auto" && installedQueueJSON !== null
        && JSON.stringify(currentQueuePairs()) !== installedQueueJSON) {
        setOption("plannerMode", "suggest", true);
        setStatus("manual queue edit detected — switched to Suggest mode");
        requestPlan("loop boundary");
        return false;
    }

    if (options.plannerMode === "auto" && options.plannerPauseWhilePlanning) {
        // Mirror the original pause path's bookkeeping, then hold the game
        // stopped until the plan for the next loop arrives.
        if (curAction) {
            actions.completedTicks += curAction.ticks;
            view.requestUpdate("updateTotalTicks", null);
        }
        for (let i = 0; i < actions.current.length; i++) {
            view.requestUpdate("updateCurrentActionBar", i);
        }
        if (!gameIsStopped) stopGame();
        pausedByPlanner = true;
        requestPlan("loop boundary");
        return true;
    }

    // suggest mode / auto-without-pause: fire-and-forget; the current queue
    // restarts normally and the result lands as a suggestion (or installs
    // one loop behind in auto mode).
    requestPlan("loop boundary");
    return false;
}

function planNow() {
    if (!options.advancedAutomation) return;
    if (options.plannerMode === "off") {
        setStatus("set a planner mode (Suggest/Auto) first");
        return;
    }
    requestPlan("manual");
}

function applySuggestion() {
    if (!options.advancedAutomation) return;
    if (!suggestion) { setStatus("no suggestion yet — use Plan Now"); return; }
    installQueue(suggestion.queue);
    setStatus(`applied: ${suggestion.label}`);
}

function showDivergences() {
    if (!suggestion?.recentDivergences?.length) {
        setStatus("no predictor-vs-engine divergences recorded");
        return;
    }
    const lines = suggestion.recentDivergences.map(d =>
        `${d.action} ${d.field}: measured ${d.measured.toFixed(2)} vs predictor ${d.predicted.toFixed(2)} (loop ${d.loop})`);
    alert(`Predictor-vs-engine divergences (verifier; latest ${lines.length} of ${suggestion.divergenceCount}):\n\n${lines.join("\n")}`);
}

function refreshSectionVisibility() {
    const el = document.getElementById("advancedAutomationSettings");
    if (el) el.style.display = options.advancedAutomation ? "" : "none";
}

// ---- option handlers (registered here so saving.js stays untouched beyond
// the option declarations) --------------------------------------------------
optionValueHandlers.advancedAutomation = (value, init) => {
    refreshSectionVisibility();
    if (!value) { shutdownWorker(); suggestion = null; installedQueueJSON = null; if (!init) setStatus("off"); }
};
optionValueHandlers.plannerMode = (value, init) => {
    if (value === "off") { shutdownWorker(); installedQueueJSON = null; if (!init) setStatus("off"); }
    else if (value === "auto") { installedQueueJSON = null; }   // adopt whatever queue comes next
};

return {
    interceptPrepareRestart,
    planNow,
    applySuggestion,
    showDivergences,
    refreshSectionVisibility,
    isEnabled,
    _debug: { getSuggestion: () => suggestion, getLastError: () => lastError },
};
})();
