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
// §11.7 Design B — live no-pause pipelining (auto mode only). The game keeps
// playing the current committed queue while the worker plans from the PREDICTED
// boundary; the fresh plan waits in pipePending until the next install boundary,
// and installs only if its boundary hash still matches the live state.
let pipePending = null;         // { queue, hash } from a pipelined plan, awaiting install
let pipeWindowLeft = 0;         // committed loops left before the next intended install
// §11.6 ladder — Buy Mana / zone-1 economy optimiser (assist; independent of
// the planner master gate). Runs on the SAME headless worker.
let optimizeSuggestion = null;  // last {queue, report} from the worker
let optimizeInputQueue = null;  // the queue we sent to optimise (the "before" side)
let awaitingOptimize = false;
let pendingApplyAfterOptimize = false;  // Apply pressed with no proposal -> install the fresh one

// Each automation tier has TWO flags: SHOWN (Extras "Show …", controls the
// Automation-view section + radio visibility) and ENABLED (in-section
// "Enable …", controls whether the features run). A tier acts only when it is
// BOTH shown and enabled — so nothing runs while its UI is hidden.
const basicOn = () => !!options.basicAutomation && !!options.basicAutomationEnabled;
const advancedOn = () => !!options.advancedAutomation && !!options.advancedAutomationEnabled;
const isEnabled = () => advancedOn() && options.plannerMode !== "off";
// §11.7 Design B is an AUTO-mode boundary behavior; it supersedes
// plannerPauseWhilePlanning while on.
const pipelineOn = () => advancedOn() && options.plannerMode === "auto" && !!options.plannerPipeline;
const replanEvery = () => Math.max(1, options.plannerReplanEvery | 0);

// Late-plan policy when a pipelined plan is not ready (or is stale) at an
// install boundary. "auto" (the default) pauses when we re-plan every loop
// (replanEvery==1 — a repeat would run a stale loop we didn't want) but repeats
// when we deliberately reuse a plan across a window (replanEvery>1 — we are
// reusing anyway). Explicit "repeat"/"pause" force one policy.
function latePolicy() {
    const p = options.plannerLatePlan;
    if (p === "repeat" || p === "pause") return p;
    return replanEvery() > 1 ? "repeat" : "pause";
}

function resetPipeline() { pipePending = null; pipeWindowLeft = 0; }

// Hash of the live game's persistent boundary state (post-loop, pre-restart),
// computed with the same function the worker used on its simulate-ahead — so
// the two agree bit-for-bit when the committed window ran the same queue with
// no reward-path RNG divergence.
function liveBoundaryHash() {
    return IdlePlanner.boundaryHash(IdlePlanner._internals.plReadState());
}

// Begin a reuse window: play the just-installed queue for replanEvery loops,
// and kick off the pipeline plan (look replanEvery loops ahead) so it is ready
// by the next install boundary.
function startPipelineWindow() {
    pipeWindowLeft = replanEvery();
    pipePending = null;
    requestPlan("pipeline", { pipeline: true });
}

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
        else if (msg.type === "optimizeResult") onOptimizeResult(msg);
        else if (msg.type === "dumpResult") onDump(msg);
        else if (msg.type === "error") onError(msg);
    };
    worker.onerror = (e) => onError({ message: e.message ?? "worker error" });
    return worker;
}

function shutdownWorker() {
    if (worker) { worker.terminate(); worker = null; }
    awaitingPlan = false;
    resetPipeline();
    resumeIfPlannerPaused();
}

function resumeIfPlannerPaused() {
    if (pausedByPlanner) {
        pausedByPlanner = false;
        if (gameIsStopped) pauseGame();   // toggle back to running (auto-restarts at a boundary)
    }
}

// "Lootable first" (searchToggler) checkboxes are DOM-only state the worker
// cannot see; the engine defaults to check-first with them unchecked but to
// loot-first when they're absent (the worker's case). Keeping plan and play
// consistent therefore needs one of two things, per the
// plannerControlLootFirst option: OWN the checkboxes (set them to the
// planner's loot-first model), or FORWARD their states so the worker's sim
// honors them.
function lootFirstVars() {
    const vars = new Set();
    for (const t of townsUnlocked) {
        for (const a of towns[t].totalActionList) {
            if (a.type === "limited") vars.add(a.varName);
        }
    }
    return vars;
}
function applyLootFirstControl() {
    for (const v of lootFirstVars()) {
        const el = inputElement(`searchToggler${v}`, false, false);
        if (el && !el.checked) el.checked = true;
    }
}
function collectLootFirstStates() {
    const states = {};
    for (const v of lootFirstVars()) {
        const el = inputElement(`searchToggler${v}`, false, false);
        if (el) states[v] = el.checked;
    }
    return states;
}

// Parse the stored priority list (a JSON string option) into goal specs.
// Malformed input degrades to an empty list — targeted mode then just falls
// through to the heuristic scorer (ruling 1's full fallback), never a crash.
function parsePlannerTargets() {
    try {
        const arr = JSON.parse(options.plannerTargets || "[]");
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function requestPlan(reason, { pipeline = false } = {}) {
    if (!isEnabled() || awaitingPlan) return;
    ensureWorker();
    awaitingPlan = true;
    lastError = null;
    if (options.plannerControlLootFirst) applyLootFirstControl();
    worker.postMessage({
        type: "plan",
        reqId: ++reqId,
        // §11.7 Design B: when pipelining, the worker simulates the committed
        // queue (actualQueue) replanEvery loops forward and plans from that
        // predicted boundary, returning a boundaryHash for the stale-plan guard.
        pipeline,
        replanEvery: replanEvery(),
        save: doSave(),
        // null = worker keeps its native loot-first model (matches the
        // checkboxes we just set); otherwise the worker honors these states
        lootFirst: options.plannerControlLootFirst ? null : collectLootFirstStates(),
        params: {
            weights: currentWeights(),
            screenK: options.plannerScreenK,
            probeEvery: options.plannerProbeEvery,
            seedFromPredictor: options.plannerSeedFromPredictor,
            multiTown: options.plannerMultiTown,
            vocabulary: options.plannerVocabulary,
            // §11.10 targeted mode: the generator (heuristic|targeted), the
            // parsed priority list, and the auto-rank toggle. Parse defensively
            // — a malformed plannerTargets string degrades to an empty list
            // (the strategy then falls straight through to the heuristic).
            strategy: options.plannerStrategy,
            targets: parsePlannerTargets(),
            autoRankTargets: options.plannerAutoRankTargets,
            antiFixation: options.plannerAntiFixation,
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
    if (msg.boundaryHash != null) {
        // §11.7 Design B: a pipelined plan. It does NOT install now — it waits
        // for the next install boundary and only if its predicted hash still
        // matches the live state. The one exception: if we PAUSED at the install
        // boundary waiting for this exact plan (it was still in flight), consume
        // it immediately (its predicted boundary is the frozen live state).
        pipePending = { queue: msg.queue, hash: msg.boundaryHash };
        if (pausedByPlanner && pipeWindowLeft <= 0) {
            if (pipePending.hash === liveBoundaryHash()) {
                installQueue(pipePending.queue); pipePending = null;
                setStatus(`pipeline: installed plan after wait (${msg.label})`);
                startPipelineWindow();
                resumeIfPlannerPaused();
            } else {
                // predicted boundary drifted while we waited (rare — the game is
                // stopped): retarget from the live state, staying paused until
                // the non-pipeline retarget result installs + resumes.
                pipePending = null;
                requestPlan("pipeline retarget", { pipeline: false });
            }
        }
    } else if (advancedOn() && options.plannerMode === "auto") {
        // Non-pipelined auto result: classic install (also the pipeline
        // cold-start / pause-late seed). In pipeline mode, arm the next window.
        installQueue(msg.queue);
        resumeIfPlannerPaused();
        if (pipelineOn()) startPipelineWindow();
    }
    // keep the Stats-panel Automation view live: new plan -> fresh internals
    if (isAutomationViewActive()) { renderLastPlan(); refreshInternals(); }
}

function onError(msg) {
    awaitingPlan = false;
    // a failed optimise must not wedge the optimiser flags (else future
    // Suggest/Apply are blocked and a pending Apply never resolves)
    awaitingOptimize = false;
    pendingApplyAfterOptimize = false;
    lastError = msg.message;
    setStatus(`planner error: ${msg.message}`);
    // never leave the game soft-locked behind a failed plan
    resumeIfPlannerPaused();
}

// Called from prepareRestart() with the already-fetched curAction; returns
// true when the automation takes over the restart (game stays stopped until
// the plan arrives).
function interceptPrepareRestart(curAction) {
    // Basic-automation boundary hooks (gated on the basicAutomation master, NOT
    // the planner gate). Auto-add reps runs BEFORE the Buy Mana optimiser so the
    // optimiser rebalances the topped-up queue; applyRepTopUps itself chains the
    // optimiser when it's enabled, so the economyOptimizerAuto request below is a
    // guarded no-op when both are on. Fire-and-forget: the optimiser proposal
    // installs when the worker responds (next loop); never pauses, so it can't
    // soft-lock the game. Skipped while an optimise request is in flight.
    if (basicOn() && options.autoAddReps && options.autoAddRepsAuto) applyRepTopUps("loop boundary");
    if (basicOn() && options.economyOptimizer && options.economyOptimizerAuto) requestOptimize("loop boundary");
    if (!isEnabled()) return false;

    // Manual queue editing always wins: if the queue at this boundary is not
    // the one auto mode installed, the player edited it — disengage to
    // Suggest and let the player's queue run.
    if (options.plannerMode === "auto" && installedQueueJSON !== null
        && JSON.stringify(currentQueuePairs()) !== installedQueueJSON) {
        resetPipeline();
        setOption("plannerMode", "suggest", true);
        setStatus("manual queue edit detected — switched to Suggest mode");
        requestPlan("loop boundary");
        return false;
    }

    // §11.7 Design B: live no-pause pipelining (auto mode). Supersedes the
    // classic pause / fire-and-forget paths below while enabled.
    if (pipelineOn()) return pipelineBoundary(curAction);

    if (options.plannerMode === "auto" && options.plannerPauseWhilePlanning) {
        // Classic pause path: hold the game stopped until the plan arrives.
        return pauseAndPlan(curAction, {});
    }

    // suggest mode / auto-without-pause: fire-and-forget; the current queue
    // restarts normally and the result lands as a suggestion (or installs
    // one loop behind in auto mode).
    requestPlan("loop boundary");
    return false;
}

// Mirror the original pause path's bookkeeping, then hold the game stopped
// until the requested plan arrives (onResult installs + resumes).
function pauseAndPlan(curAction, opts) {
    if (curAction) {
        actions.completedTicks += curAction.ticks;
        view.requestUpdate("updateTotalTicks", null);
    }
    for (let i = 0; i < actions.current.length; i++) {
        view.requestUpdate("updateCurrentActionBar", i);
    }
    if (!gameIsStopped) stopGame();
    pausedByPlanner = true;
    requestPlan("loop boundary", opts);
    return true;
}

// §11.7 Design B boundary handler (auto + plannerPipeline). Keeps the game
// playing the current committed queue while the worker plans from the predicted
// boundary; swaps in a fresh plan only at a window boundary and only if its
// predicted hash still matches the live state.
function pipelineBoundary(curAction) {
    // Cold start: nothing installed yet. Seed once via the pause path (plan from
    // the current state); onResult installs it and arms the first window.
    if (installedQueueJSON === null) return pauseAndPlan(curAction, { pipeline: false });

    // One committed loop just finished.
    if (--pipeWindowLeft > 0) return false;   // mid-window: keep playing, no swap

    // Install boundary: install the pending plan iff its predicted boundary
    // still matches the live state (determinism ⇒ equal whenever the window ran
    // the same queue with no reward-path RNG divergence).
    if (pipePending && pipePending.hash === liveBoundaryHash()) {
        installQueue(pipePending.queue);
        setStatus(`pipeline: installed plan (window ${replanEvery()})`);
        startPipelineWindow();
        return false;
    }
    // Pending is stale (hash mismatch) — discard it; or still in flight (null).
    const stale = !!pipePending;
    pipePending = null;
    if (latePolicy() === "pause") {
        // Stall at this boundary. If a pipeline plan is still in flight it will
        // land on this frozen boundary (onResult installs + resumes); if it was
        // stale, requestPlan issues a fresh non-pipeline plan for this state.
        return pauseAndPlan(curAction, { pipeline: false });
    }
    // "repeat": leave the current queue running and (re)plan for a fresh
    // boundary. If a plan is already in flight (targeting the boundary we just
    // passed), re-check next loop — it lands, is found stale, and re-plans then;
    // otherwise request a fresh pipeline plan and a full new window. Either way
    // the current queue keeps playing, so forward progress is guaranteed.
    setStatus(`pipeline: plan ${stale ? "stale" : "late"} — repeating queue`);
    if (awaitingPlan) pipeWindowLeft = 1;
    else startPipelineWindow();
    return false;
}

function planNow() {
    if (!options.advancedAutomation) return;
    if (!options.advancedAutomationEnabled) { setStatus("enable advanced automation first"); return; }
    if (options.plannerMode === "off") {
        setStatus("set a planner mode (Suggest/Auto) first");
        return;
    }
    requestPlan("manual");
}

function applySuggestion() {
    if (!advancedOn()) return;
    if (!suggestion) { setStatus("no suggestion yet — use Plan Now"); return; }
    installQueue(suggestion.queue);
    setStatus(`applied: ${suggestion.label}`);
}

// ---- Buy Mana / zone-1 economy optimiser (assist tool) --------------------
// Rebalances the CURRENT queue on the worker's private sim copy: batches gold
// before each Buy Mana, drops redundant conversions, splits a harvest to insert
// an intermediate conversion when the budget would starve, and reserves gold
// for downstream purchases. Suggest-first; auto-apply behind its own toggle.
function requestOptimize(reason) {
    if (awaitingOptimize) return;
    const queue = currentQueuePairs();
    if (!queue.length) { setStatus("optimise: queue is empty"); return; }
    ensureWorker();
    awaitingOptimize = true;
    optimizeInputQueue = queue;   // remember the "before" queue for the proposal tables
    worker.postMessage({ type: "optimize", reqId: ++reqId, save: doSave(), queue });
    setStatus(`optimising Buy Mana (${reason})…`);
}

function onOptimizeResult(msg) {
    awaitingOptimize = false;
    msg.inputQueue = optimizeInputQueue;   // the "before" queue this proposal was computed from
    optimizeSuggestion = msg;
    const before = msg.report?.before, after = msg.report?.after;
    const changed = JSON.stringify(msg.queue) !== JSON.stringify(currentQueuePairs());
    setStatus(changed
        ? `Buy Mana: ${msg.report?.moves} change(s) — buyMana ${before?.convExecs}→${after?.convExecs}, gold ${before?.unconvGold}→${after?.unconvGold}`
        : "Buy Mana: already optimal");
    // Install when either an Apply is pending (Apply pressed with no proposal) or
    // auto-apply-at-boundary is on. Re-check the feature is still on (it could
    // have been disabled while the worker ran); skip a no-op install when unchanged.
    const applyNow = pendingApplyAfterOptimize;
    pendingApplyAfterOptimize = false;
    const featureOn = basicOn() && options.economyOptimizer;
    if (featureOn && (applyNow || options.economyOptimizerAuto) && changed) {
        installQueue(msg.queue);
        setStatus(`Buy Mana: ${applyNow ? "applied" : "auto-applied"} (${msg.report?.moves} change(s))`);
    } else if (applyNow && featureOn) {
        setStatus("Buy Mana: already optimal — nothing to apply");
    }
    if (isAutomationViewActive()) renderOptimize();
}

// When auto-add reps is enabled, top up the live queue so the optimiser (and the
// before/after tables) reflect the full unlocked reps. Idempotent (a second call
// finds no gap). Scoped to the Suggest/Apply buttons — the loop-boundary path
// already sequences auto-add via its own auto-apply toggle.
function topUpForOptimise() {
    if (options.autoAddReps && basicOn()) {
        const ups = Koviko.applyRepTopUps(actions.next);
        if (ups.length) view.requestUpdate("updateNextActions");
    }
}

// "Suggest" button: compute a proposal now and show it — does NOT install the
// economy rebalance (but it DOES top up reps first when auto-add is enabled).
function optimizeBuyMana() {
    if (!basicOn() || !options.economyOptimizer) { setStatus("enable the Buy Mana optimiser first"); return; }
    topUpForOptimise();
    requestOptimize("suggest");
}

// "Apply" button: install a proposal. Uses the one already shown if there is
// one; otherwise computes a fresh one first, then installs it when it arrives.
function applyOptimize() {
    if (!basicOn() || !options.economyOptimizer) { setStatus("enable the Buy Mana optimiser first"); return; }
    if (optimizeSuggestion) {
        installQueue(optimizeSuggestion.queue);
        setStatus(`Buy Mana: applied (${optimizeSuggestion.report?.moves} change(s))`);
        if (isAutomationViewActive()) renderOptimize();
        return;
    }
    topUpForOptimise();
    pendingApplyAfterOptimize = true;
    requestOptimize("apply");
}

// ---- Auto-add reps (assist tool, §11.6 ladder rung 2) ---------------------
// Tops up the live queue IN PLACE for every under-queued action (queued reps <
// what the current state can execute next loop — the "+N" case the rep-gap
// badges surface). Pure UI-thread: bumps actions.next[i].loops, no worker, no
// engine rollout. When the Buy Mana optimiser is ALSO enabled it then chains
// requestOptimize to rebalance the topped-up queue (reuses that feature's
// logic instead of duplicating placement; the optimiser respects its own
// suggest/auto setting for installation). Suggest-first — the rung-1 rep-gap
// badges are the display surface; over-queued/multipart/one-shot actions are
// left untouched (Koviko.applyRepTopUps).
function applyRepTopUps(reason = "manual") {
    if (!basicOn() || !options.autoAddReps) { setStatus("enable auto-add reps first"); return; }
    const ups = Koviko.applyRepTopUps(actions.next);
    if (!ups.length) { setStatus("rep top-ups: nothing to add"); return; }
    view.requestUpdate("updateNextActions");
    const total = ups.reduce((s, r) => s + r.gap, 0);
    setStatus(`rep top-ups (${reason}): added ${total} rep${total === 1 ? "" : "s"} across ${ups.length} action${ups.length === 1 ? "" : "s"}`);
    // chain the Buy Mana optimiser when it's ALSO on (rebalance the top-up)
    if (options.economyOptimizer) requestOptimize("after rep top-up");
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
    const anyAuto = options.basicAutomation || options.advancedAutomation;
    // Extras-menu note divs each mirror their master checkbox.
    const basicNote = document.getElementById("basicAutomationSettings");
    if (basicNote) basicNote.style.display = options.basicAutomation ? "" : "none";
    const advNote = document.getElementById("advancedAutomationSettings");
    if (advNote) advNote.style.display = options.advancedAutomation ? "" : "none";
    // Automation-view sections show/hide separately: the Basic section on the
    // basic master, the Advanced settings + internals on the advanced master.
    const basicSec = document.getElementById("autoViewBasicSettings");
    if (basicSec) basicSec.style.display = options.basicAutomation ? "" : "none";
    for (const id of ["autoViewSettings", "autoViewInternals"]) {
        const sec = document.getElementById(id);
        if (sec) sec.style.display = options.advancedAutomation ? "" : "none";
    }
    // The Automation-view radio exists while EITHER master is on; if it was the
    // active view when both flip off, fall back to the Regular view.
    const wrap = document.getElementById("automationStatsWrap");
    if (wrap) wrap.style.display = anyAuto ? "" : "none";
    if (!anyAuto) {
        const radio = document.getElementById("automationStats");
        if (radio?.checked) {
            radio.checked = false;
            document.getElementById("regularStats").checked = true;
            view.changeStatView();
        }
    }
}

// ---- Stats-panel Automation view (compact stats + settings + internals) ----
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => typeof n === "number" ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : String(n ?? "");
const objStr = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}:${fmt(v)}`).join(" ");

function isAutomationViewActive() {
    return document.getElementById("statsWindow")?.dataset.view === "automation";
}

// Buy Mana optimiser proposal (Automation view), collapsible (<details>). Two
// before->after->delta tables: the waste metrics (top) and the per-action reps
// (bottom). The delta is signed and colour-coded — green = value decreased,
// red = increased (lower is better for both waste and Buy Mana reps); the sign
// carries the meaning so it never relies on colour alone.
const OPT_METRICS = [
    { key: "failed", label: "failed reps" },
    { key: "convExecs", label: "Buy Mana execs" },
    { key: "unconvGold", label: "unconverted gold" },
];
function deltaCell(before, after) {
    const delta = (after ?? 0) - (before ?? 0);
    const cls = delta < 0 ? "d-down" : delta > 0 ? "d-up" : "d-zero";
    const txt = delta > 0 ? `+${fmt(delta)}` : fmt(delta);
    return `<td class="bmq-num ${cls}">${txt}</td>`;
}
function aggregateReps(pairs) {
    const m = new Map();
    for (const [name, loops] of (pairs ?? [])) m.set(name, (m.get(name) ?? 0) + loops);
    return m;
}
function renderOptimize() {
    const el = document.getElementById("buyManaOptimizerBody");
    if (!el) return;
    if (!optimizeSuggestion) { el.innerHTML = "No proposal yet — press Suggest."; return; }
    const { queue, report, inputQueue } = optimizeSuggestion;
    const b = report?.before ?? {}, a = report?.after ?? {};
    const moves = report?.moves ?? 0;
    // waste table (one row per metric)
    const wasteRows = OPT_METRICS.map((m) =>
        `<tr><td>${esc(m.label)}</td><td class="bmq-num">${fmt(b[m.key] ?? 0)}</td>` +
        `<td class="bmq-num">${fmt(a[m.key] ?? 0)}</td>${deltaCell(b[m.key], a[m.key])}</tr>`).join("");
    // reps table (one row per action; before = the queue we optimised, after = proposal)
    const beforeReps = aggregateReps(inputQueue), afterReps = aggregateReps(queue);
    const names = [], seen = new Set();
    for (const [n] of queue) if (!seen.has(n)) { seen.add(n); names.push(n); }
    for (const n of beforeReps.keys()) if (!seen.has(n)) { seen.add(n); names.push(n); }
    const repRows = names.map((n) =>
        `<tr><td>${esc(n)}</td><td class="bmq-num">${fmt(beforeReps.get(n) ?? 0)}</td>` +
        `<td class="bmq-num">${fmt(afterReps.get(n) ?? 0)}</td>${deltaCell(beforeReps.get(n), afterReps.get(n))}</tr>`).join("");
    const table = (headA, rows) =>
        `<table class="automation-table"><thead><tr><th>${headA}</th><th>Before</th><th>After</th><th>&Delta;</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>`;
    el.innerHTML =
        `<details class="buyManaProposal" open>` +
        `<summary>Proposal: ${esc(report?.converter ?? "(none)")}, ${moves ? `${moves} change(s)` : "already optimal"}</summary>` +
        table("Metric", wasteRows) + table("Action", repRows) +
        `</details>`;
}

// ---------------------------------------------------------------------------
// §11.10 targeted-mode priority-list EDITOR (replaces the raw JSON textarea).
// A row-based editor over the plannerTargets array (order = fitting priority).
// Each row is a goal: kind "a" (make an action executable this loop) or kind "b"
// (reach value V of a persistent resource). The enable checkbox parks a row
// WITHOUT losing its config — planner.js skips `enabled === false` (keeps its
// position + params in plannerTargets); ↑/↓ reorder = priority. When the
// "Auto-rank targets" option is on the whole manual list is IGNORED by the
// planner, so the editor greys out to match. No engine changes beyond the
// one-line `enabled` filter — the editor only authors valid plannerTargets JSON.
// ---------------------------------------------------------------------------
const TG_TYPES = ["skill", "progress", "buff", "soulstones", "goldInvested"];
const TG_NEEDS_NAME = { skill: true, progress: true, buff: true, soulstones: false, goldInvested: false };
const TG_NEEDS_TOWN = { progress: true };

// Actions eligible as a kind-a goal = currently unlocked (the same set
// generateTargeted resolves against via unlockedOf().find(name)). Names carry
// spaces, matching the goal spec's `action` field.
function tgEligibleActions() {
    const list = (typeof totalActionList !== "undefined" ? totalActionList : []);
    const names = [];
    for (const a of list) { try { if (a.unlocked()) names.push(a.name); } catch { /* skip flaky unlocked() */ } }
    return names.sort();
}
function tgSkills() { return typeof skillList !== "undefined" ? [...skillList] : []; }
function tgBuffs() { return typeof buffList !== "undefined" ? [...buffList] : []; }
function tgReadTargets() {
    const arr = parsePlannerTargets();   // defensive parse (never throws)
    for (const g of arr) if (g && g.kind === "b" && !g.target) g.target = { type: "skill" };
    return Array.isArray(arr) ? arr : [];
}
function tgWrite(goals, rerender = true) {
    setOption("plannerTargets", JSON.stringify(goals));
    if (rerender) renderTargetsEditor();
}
function tgOpts(values, sel) {
    return values.map(v => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(v)}</option>`).join("");
}
function tgDefaultB() {
    return { kind: "b", target: { type: "skill", name: tgSkills()[0] ?? "", town: 0 }, value: 0 };
}
function tgRowHtml(g, i, n) {
    const off = g.enabled === false;
    const en = `<input type="checkbox" data-tg="en" data-i="${i}"${off ? "" : " checked"} title="Enable/disable this goal (disabled stays in the list, skipped by the planner)">`;
    const kind = `<select data-tg="kind" data-i="${i}"><option value="a"${g.kind === "a" ? " selected" : ""}>Action</option>` +
                 `<option value="b"${g.kind === "b" ? " selected" : ""}>Reach&nbsp;value</option></select>`;
    let body;
    if (g.kind === "a") {
        const names = tgEligibleActions();
        if (g.action && !names.includes(g.action)) names.unshift(g.action);   // keep the current selection even if now locked
        body = `<select data-tg="action" data-i="${i}" class="tg-action" title="Make this action executable this loop">${tgOpts(names, g.action ?? "")}</select>`;
    } else {
        const t = g.target ?? { type: "skill" };
        const typeSel = `<select data-tg="type" data-i="${i}">${tgOpts(TG_TYPES, t.type ?? "skill")}</select>`;
        let nameSel = "";
        if (t.type === "skill") nameSel = `<select data-tg="name" data-i="${i}">${tgOpts(tgSkills(), t.name ?? "")}</select>`;
        else if (t.type === "buff") nameSel = `<select data-tg="name" data-i="${i}">${tgOpts(tgBuffs(), t.name ?? "")}</select>`;
        else if (t.type === "progress") nameSel = `<input type="text" data-tg="name" data-i="${i}" class="tg-name" value="${esc(t.name ?? "")}" placeholder="progress name">`;
        const town = TG_NEEDS_TOWN[t.type] ? `<label class="tg-lbl">town<input type="number" data-tg="town" data-i="${i}" class="tg-town" min="0" max="8" value="${Number(t.town ?? 0)}"></label>` : "";
        const val = `<label class="tg-lbl" title="stop condition (tracked across rounds)">&ge;<input type="number" data-tg="value" data-i="${i}" class="tg-val" value="${Number(g.value ?? 0)}"></label>`;
        const bud = `<label class="tg-lbl" title="fraction of the loop's fill this goal may use (0–1); blank = greedy">bud<input type="number" data-tg="budget" data-i="${i}" class="tg-budget" step="0.05" min="0" max="1" value="${g.budget ?? ""}"></label>`;
        body = typeSel + nameSel + town + val + bud;
    }
    const up = `<button type="button" class="tg-btn" data-tg="up" data-i="${i}"${i === 0 ? " disabled" : ""} title="raise priority">&uarr;</button>`;
    const dn = `<button type="button" class="tg-btn" data-tg="dn" data-i="${i}"${i === n - 1 ? " disabled" : ""} title="lower priority">&darr;</button>`;
    const rm = `<button type="button" class="tg-btn" data-tg="rm" data-i="${i}" title="remove">&times;</button>`;
    return `<div class="tg-row${off ? " tg-off" : ""}">${en}${kind}${body}${up}${dn}${rm}</div>`;
}
function renderTargetsEditor() {
    const el = document.getElementById("plannerTargetsEditor");
    if (!el) return;
    tgEnsureStyle();
    tgEnsureWired(el);
    const goals = tgReadTargets();
    const locked = !!options.plannerAutoRankTargets;
    el.classList.toggle("tg-locked", locked);
    const note = locked
        ? `<div class="tg-note">Auto-rank is on — this manual list is ignored. Uncheck “Auto-rank targets” to use it.</div>`
        : "";
    const rows = goals.map((g, i) => tgRowHtml(g, i, goals.length)).join("")
        || `<div class="tg-empty">No goals. Add one below — an empty list makes targeted mode fall back to the heuristic scorer.</div>`;
    const add = `<div class="tg-add">`
        + `<button type="button" class="tg-btn tg-addbtn" data-tg="add-a">+ Action goal</button>`
        + `<button type="button" class="tg-btn tg-addbtn" data-tg="add-b">+ Reach-value goal</button></div>`;
    el.innerHTML = note + `<div class="tg-rows">${rows}</div>` + add;
}
let tgWired = false;
function tgEnsureWired(el) {
    if (tgWired) return;
    tgWired = true;
    const handle = (target) => {
        const act = target.getAttribute("data-tg");
        const goals = tgReadTargets();
        if (act === "add-a") { goals.push({ kind: "a", action: tgEligibleActions()[0] ?? "" }); return tgWrite(goals); }
        if (act === "add-b") { goals.push(tgDefaultB()); return tgWrite(goals); }
        const i = Number(target.getAttribute("data-i"));
        if (!Number.isInteger(i) || i < 0 || i >= goals.length) return;
        const g = goals[i];
        const keepEnabled = g.enabled === false ? { enabled: false } : {};
        switch (act) {
            case "rm": goals.splice(i, 1); return tgWrite(goals);
            case "up": if (i > 0) [goals[i - 1], goals[i]] = [goals[i], goals[i - 1]]; return tgWrite(goals);
            case "dn": if (i < goals.length - 1) [goals[i + 1], goals[i]] = [goals[i], goals[i + 1]]; return tgWrite(goals);
            case "en": if (target.checked) delete g.enabled; else g.enabled = false; return tgWrite(goals);
            case "kind":
                if (target.value === "a") goals[i] = { kind: "a", action: tgEligibleActions()[0] ?? "", ...keepEnabled };
                else goals[i] = { ...tgDefaultB(), ...keepEnabled };
                return tgWrite(goals);
            case "type": {
                const type = target.value;
                const name = TG_NEEDS_NAME[type] ? (type === "skill" ? tgSkills()[0] ?? "" : type === "buff" ? tgBuffs()[0] ?? "" : "") : undefined;
                g.target = { type, ...(name !== undefined ? { name } : {}), ...(TG_NEEDS_TOWN[type] ? { town: 0 } : {}) };
                return tgWrite(goals);
            }
            // edit boxes: write WITHOUT a re-render so focus/caret survive.
            case "action": g.action = target.value; return tgWrite(goals, false);
            case "name": (g.target ??= { type: "skill" }).name = target.value; return tgWrite(goals, false);
            case "town": (g.target ??= { type: "progress" }).town = Number(target.value) || 0; return tgWrite(goals, false);
            case "value": g.value = Number(target.value) || 0; return tgWrite(goals, false);
            case "budget": if (target.value === "") delete g.budget; else g.budget = Number(target.value); return tgWrite(goals, false);
        }
    };
    el.addEventListener("click", (ev) => { const t = ev.target.closest("button[data-tg]"); if (t) handle(t); });
    el.addEventListener("change", (ev) => { const t = ev.target.closest("[data-tg]"); if (t && t.tagName !== "BUTTON") handle(t); });
}
function tgEnsureStyle() {
    if (document.getElementById("tg-editor-style")) return;
    const s = document.createElement("style");
    s.id = "tg-editor-style";
    s.textContent =
        `#plannerTargetsEditor{font-size:11px;margin:2px 0 4px}` +
        `#plannerTargetsEditor .tg-row{display:flex;align-items:center;gap:3px;margin:2px 0;flex-wrap:wrap}` +
        `#plannerTargetsEditor select,#plannerTargetsEditor input[type=number],#plannerTargetsEditor input[type=text]{font-size:11px;padding:0 2px}` +
        `#plannerTargetsEditor .tg-val{width:60px}#plannerTargetsEditor .tg-budget{width:48px}#plannerTargetsEditor .tg-town{width:40px}#plannerTargetsEditor .tg-name{width:96px}` +
        `#plannerTargetsEditor .tg-lbl{display:inline-flex;align-items:center;gap:2px}` +
        `#plannerTargetsEditor .tg-btn{cursor:pointer;padding:0 5px}` +
        `#plannerTargetsEditor .tg-off{opacity:.45}` +
        `#plannerTargetsEditor.tg-locked .tg-rows,#plannerTargetsEditor.tg-locked .tg-add{opacity:.5;pointer-events:none}` +
        `#plannerTargetsEditor .tg-note{color:#c80;margin-bottom:3px}` +
        `#plannerTargetsEditor .tg-empty{color:#888;margin:2px 0}` +
        `#plannerTargetsEditor .tg-add{margin-top:3px}`;
    document.head.appendChild(s);
}

let statsRefreshTimer = null;
function onViewShown() {
    renderCompactStats();
    renderLastPlan();
    renderPools();
    renderOptimize();
    renderTargetsEditor();
    refreshInternals();
    if (!statsRefreshTimer) {
        statsRefreshTimer = setInterval(() => {
            if (isAutomationViewActive()) renderCompactStats();
            else { clearInterval(statsRefreshTimer); statsRefreshTimer = null; }
        }, 1000);
    }
}

function renderCompactStats() {
    const body = document.getElementById("autoStatsBody");
    if (!body) return;
    const rows = [];
    let totalLevel = 0;
    for (const s of statList) {
        const st = stats[s];
        totalLevel += st.statLevelExp.level;
        rows.push(`<tr><td>${esc(s)}</td><td>${st.statLevelExp.level}</td>` +
            `<td>${st.talentLevelExp.level}</td><td>${fmt(st.soulstone ?? 0)}</td></tr>`);
    }
    rows.push(`<tr style="font-weight:bold"><td>Total</td><td>${totalLevel}</td>` +
        `<td>${fmt(Math.floor(totalTalent))}</td><td></td></tr>`);
    body.innerHTML = rows.join("");
}

function renderLastPlan() {
    const el = document.getElementById("autoIntLastPlanBody");
    if (!el) return;
    if (!suggestion) { el.innerHTML = "No plan computed yet."; return; }
    const head = `<div>loop ${suggestion.loop}: <b>${esc(suggestion.label)}</b> score ${fmt(suggestion.score)}, ` +
        `${suggestion.nCands} candidates &rarr; ${suggestion.nScreened} confirmed, ${(suggestion.wallMs / 1000).toFixed(1)}s</div>` +
        `<div>queue: ${esc(suggestion.queue.map(([n, l]) => `${n} x${l}`).join(", "))}</div>`;
    const evalRows = (suggestion.evals ?? []).map(e =>
        `<tr><td>${esc(e.label)}</td><td>${fmt(e.score)}</td><td>${fmt(e.capacity ?? "-")}</td><td>${fmt(e.probeTicks ?? "-")}</td></tr>` +
        (e.parts ? `<tr><td colspan="4" style="text-align:left;opacity:0.75">&nbsp;&nbsp;${esc(objStr(Object.fromEntries(Object.entries(e.parts).filter(([, v]) => v !== 0).map(([k, v]) => [k, Math.round(v * 10) / 10]))))}</td></tr>` : "")
    ).join("");
    el.innerHTML = head + (evalRows
        ? `<div class="auto-scroll"><table class="automation-table"><thead><tr><th>candidate</th><th>score</th><th>capacity</th><th>pump</th></tr></thead><tbody>${evalRows}</tbody></table></div>`
        : "<div>(no per-candidate evals in this result)</div>");
}

let lastDumpKnow = null;
function renderPools() {
    const el = document.getElementById("autoIntPoolsBody");
    if (!el) return;
    // discovery rates come from the worker's measured knowledge (if dumped)
    const discoverers = new Map();
    for (const [name, k] of lastDumpKnow ?? []) {
        for (const [v, r] of Object.entries(k.discovers ?? {})) {
            const key = `${k.townNum ?? 0}:${v}`;
            discoverers.set(key, (discoverers.get(key) ?? []).concat(`${name} ${fmt(r)}/exec`));
        }
    }
    const rows = [];
    for (const t of townsUnlocked) {
        const seen = new Set();
        for (const a of towns[t].totalActionList) {
            if (a.type !== "limited" || seen.has(a.varName)) continue;
            seen.add(a.varName);
            const v = a.varName;
            const total = towns[t][`total${v}`] ?? 0, checked = towns[t][`checked${v}`] ?? 0, good = towns[t][`good${v}`] ?? 0;
            const lf = document.getElementById(`searchToggler${v}`)?.checked ? "on" : "off";
            const disc = discoverers.get(`${t}:${v}`);
            rows.push(`<tr><td>${t}: ${esc(v)}</td><td>${good}</td><td>${checked}</td><td>${total}</td>` +
                `<td>${total - checked}</td><td>${lf}</td></tr>` +
                (disc ? `<tr><td colspan="6" style="text-align:left;opacity:0.75">&nbsp;&nbsp;discovered by ${esc(disc.join(", "))}</td></tr>` : ""));
        }
    }
    el.innerHTML = rows.length
        ? `<div class="auto-scroll"><table class="automation-table"><thead><tr>` +
          `<th>pool</th><th>good</th><th>checked</th><th>total</th><th>unchecked</th><th>LF</th>` +
          `</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
        : "No limited-item pools discovered yet.";
}

// Persistent-state channels from the read state (planner.js plReadState,
// census 2.2). Read-only observability — nothing scores these at defaults.
function renderResources(pre) {
    const el = document.getElementById("autoIntResourcesBody");
    if (!el) return;
    if (!pre) { el.innerHTML = "No read state yet — run a plan first."; return; }
    const nz = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v));
    const blocks = [];
    const buffsNz = nz(pre.buffs);
    if (Object.keys(buffsNz).length) blocks.push(`<div><b>buffs</b> ${esc(objStr(buffsNz))}</div>`);
    if (pre.soulstones) {
        const perStat = nz(pre.soulstones.perStat);
        blocks.push(`<div><b>soulstones</b> total ${fmt(pre.soulstones.total ?? 0)}` +
            (Object.keys(perStat).length ? ` (${esc(objStr(perStat))})` : "") + `</div>`);
    }
    const scalars = { goldInvested: pre.goldInvested, trainingLimits: pre.trainingLimits, effectiveTime: pre.effectiveTime };
    blocks.push(`<div><b>scalars</b> ${esc(objStr(scalars))}</div>`);
    const stonesNz = nz(pre.stonesUsed);
    if (Object.keys(stonesNz).length) blocks.push(`<div><b>stones used</b> ${esc(objStr(stonesNz))}</div>`);
    // dungeon/trial progression: only show entries with any progress
    const dRows = (pre.dungeons ?? []).map((d, i) => {
        const cleared = d.filter(f => f.completed >= 100).length;
        const touched = d.some(f => f.completed > 0);
        return touched ? `dungeon${i}: ${cleared}/${d.length} floors cleared` : null;
    }).filter(Boolean);
    const tRows = (pre.trials ?? []).map((t, i) =>
        (t.completedTotal > 0 || t.highestFloor > 0)
            ? `trial${i}: floor ${t.highestFloor} (${fmt(t.completedTotal)} completed)` : null).filter(Boolean);
    const prog = dRows.concat(tRows);
    if (prog.length) blocks.push(`<div><b>dungeons/trials</b> ${esc(prog.join("; "))}</div>`);
    el.innerHTML = blocks.join("");
}

function requestDump() {
    if (!worker) return false;
    worker.postMessage({ type: "dump" });
    return true;
}

function refreshInternals() {
    const status = document.getElementById("autoInternalsStatus");
    renderLastPlan();
    if (!requestDump() && status) {
        status.textContent = "Planner worker not running — pick a mode (Suggest/Auto) or press Plan Now first.";
    }
}

function onDump(msg) {
    const p = msg.planning ?? {};
    lastDumpKnow = p.know ?? lastDumpKnow;
    renderPools();
    const status = document.getElementById("autoInternalsStatus");
    if (status) {
        const lc = (p.lastCommitted ?? []).map(([n, l]) => `${n} x${l}`).join(", ");
        status.innerHTML =
            `worker planning round ${p.loop ?? 0}; capacity ${fmt(p.prevTimeNeeded ?? "-")}` +
            `${p.prevProbeTicks != null ? `, pump ${fmt(p.prevProbeTicks)}, headroom ${fmt((p.prevTimeNeeded ?? 0) - p.prevProbeTicks)}` : ""}; ` +
            `knowledge: ${(p.know ?? []).length} actions<br>last committed: ${esc(lc || "(none)")}`;
    }
    const kb = document.getElementById("autoIntKnowledgeBody");
    if (kb) {
        const rows = (p.know ?? []).map(([name, k]) => {
            const extras = [];
            if (Object.keys(k.grants ?? {}).length) extras.push("grants " + objStr(k.grants));
            if (Object.keys(k.costReductions ?? {}).length) extras.push("reduces " + objStr(k.costReductions));
            if (Object.keys(k.discovers ?? {}).length) extras.push("discovers " + objStr(k.discovers));
            if (k.manaPerGold > 0) extras.push(`converter ${fmt(k.manaPerGold)}/g`);
            return `<tr><td>${esc(name)}</td><td>${k.townNum ?? 0}</td><td>${k.exec}</td><td>${fmt(k.ticksPerExec)}</td>` +
                `<td>${fmt(k.manaPerExec)}</td><td>${fmt(k.goldPerExec)}</td><td>${fmt(k.repPerExec)}</td><td>${k.measuredAtLoop}</td></tr>` +
                (extras.length ? `<tr><td colspan="8" style="text-align:left;opacity:0.75">&nbsp;&nbsp;${esc(extras.join("; "))}</td></tr>` : "");
        }).join("");
        kb.innerHTML = rows
            ? `<div class="auto-scroll"><table class="automation-table"><thead><tr><th>action</th><th>town</th><th>exec</th><th>ticks</th><th>mana</th><th>gold</th><th>rep</th><th>@loop</th></tr></thead><tbody>${rows}</tbody></table></div>`
            : "Knowledge table empty (no measurement round yet).";
    }
    const tb = document.getElementById("autoIntThresholdsBody");
    if (tb) {
        const reqStr = (r) => `${r.kind === "p" ? `town${r.town} ${r.v}` : r.v} &ge; ${r.need} (now ${r.cur})`;
        const rows = Object.entries(p.thresholds ?? {}).map(([name, t]) =>
            `<div><b>${esc(name)}</b>: ${t.probeable ? (t.requires ?? []).map(reqStr).join(", ") || "reachable now" : "unprobeable (story-gated)"}</div>`).join("");
        tb.innerHTML = rows ? `<div class="auto-scroll">${rows}</div>` : "Nothing locked (or no probe round yet).";
    }
    renderResources(p.pre);
    const db = document.getElementById("autoIntDivergencesBody");
    if (db) {
        const rows = (msg.divergences ?? []).slice(-25).map(d =>
            `<div>L${d.loop} ${esc(d.action)} ${esc(d.field)}: measured ${fmt(d.measured)} vs predicted ${fmt(d.predicted)}</div>`).join("");
        db.innerHTML = rows || "None recorded.";
    }
}

// ---- option handlers (registered here so saving.js stays untouched beyond
// the option declarations) --------------------------------------------------
// basicAutomation = SHOWN: drives the Basic section + radio visibility.
optionValueHandlers.basicAutomation = (value, init) => {
    refreshSectionVisibility();
    // rep-gap badges depend on shown — repaint the predictor list
    if (!init && options.predictor) view.requestUpdate("updateNextActions");
    if (!value) optimizeSuggestion = null;
};
// basicAutomationEnabled = ENABLED: whether the basic features run. Does NOT
// touch visibility — only repaints the badges (their gate includes it) and
// drops a stale Buy Mana proposal when paused.
optionValueHandlers.basicAutomationEnabled = (value, init) => {
    if (!init && options.predictor) view.requestUpdate("updateNextActions");
    if (!value) optimizeSuggestion = null;
};
// advancedAutomation = SHOWN: drives the Advanced settings/internals + radio.
optionValueHandlers.advancedAutomation = (value, init) => {
    refreshSectionVisibility();
    if (!value) { shutdownWorker(); suggestion = null; installedQueueJSON = null; if (!init) setStatus("off"); }
};
// advancedAutomationEnabled = ENABLED: whether the planner acts. Off disengages
// it (unpause the game if it was holding a boundary, forget the installed queue)
// without hiding anything; isEnabled() gates the rest.
optionValueHandlers.advancedAutomationEnabled = (value, init) => {
    if (!value) { resetPipeline(); resumeIfPlannerPaused(); installedQueueJSON = null; if (!init) setStatus("advanced automation disabled"); }
};
optionValueHandlers.plannerMode = (value, init) => {
    resetPipeline();   // any mode change abandons an in-progress pipeline window
    if (value === "off") { shutdownWorker(); installedQueueJSON = null; if (!init) setStatus("off"); }
    else if (value === "auto") { installedQueueJSON = null; }   // adopt whatever queue comes next
};
// §11.7 Design B controls. Changing any of them abandons the current window so
// the next boundary re-seeds cleanly under the new settings.
optionValueHandlers.plannerPipeline = (value, init) => {
    resetPipeline();
    const sec = document.getElementById("plannerPipelineSection");
    if (sec) sec.style.display = value ? "" : "none";
};
optionValueHandlers.plannerReplanEvery = (value, init) => { resetPipeline(); };
optionValueHandlers.plannerLatePlan = (value, init) => { resetPipeline(); };
optionValueHandlers.economyOptimizer = (value, init) => {
    const sec = document.getElementById("buyManaOptimizerSection");
    if (sec) sec.style.display = value ? "" : "none";
    if (!value) optimizeSuggestion = null;
};
optionValueHandlers.autoAddReps = (value, init) => {
    const sec = document.getElementById("autoAddRepsSection");
    if (sec) sec.style.display = value ? "" : "none";
};
// §11.10 targeted mode: the priority-list editor reflects plannerTargets on
// load / external change, and greys out when Auto-rank overrides the list.
optionValueHandlers.plannerTargets = (value, init) => { renderTargetsEditor(); };
optionValueHandlers.plannerAutoRankTargets = (value, init) => { renderTargetsEditor(); };

return {
    interceptPrepareRestart,
    planNow,
    applySuggestion,
    optimizeBuyMana,
    applyOptimize,
    applyRepTopUps,
    showDivergences,
    refreshSectionVisibility,
    onViewShown,
    refreshInternals,
    isEnabled,
    _debug: { getSuggestion: () => suggestion, getLastError: () => lastError,
              getOptimizeSuggestion: () => optimizeSuggestion, requestOptimize,
              // §11.7 pipeline observability (smoke tests / debugging)
              getPipePending: () => pipePending, getPipeWindowLeft: () => pipeWindowLeft,
              isPipelineOn: () => pipelineOn() },
};
})();
