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
// §11.6 ladder — Buy Mana / zone-1 economy optimiser (assist; independent of
// the planner master gate). Runs on the SAME headless worker.
let optimizeSuggestion = null;  // last {queue, report} from the worker
let awaitingOptimize = false;

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

function requestPlan(reason) {
    if (!isEnabled() || awaitingPlan) return;
    ensureWorker();
    awaitingPlan = true;
    lastError = null;
    if (options.plannerControlLootFirst) applyLootFirstControl();
    worker.postMessage({
        type: "plan",
        reqId: ++reqId,
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
    if (options.advancedAutomation && options.plannerMode === "auto") {
        installQueue(msg.queue);
        resumeIfPlannerPaused();
    }
    // keep the Stats-panel Automation view live: new plan -> fresh internals
    if (isAutomationViewActive()) { renderLastPlan(); refreshInternals(); }
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
    // Buy Mana optimiser auto-apply is INDEPENDENT of the planner master gate:
    // fire-and-forget optimise of the current queue at the boundary; the
    // proposal installs when the worker responds (takes effect next loop). Never
    // pauses, so it can't soft-lock the game. Skipped while a request is in
    // flight (awaitingOptimize).
    if (options.economyOptimizer && options.economyOptimizerAuto) requestOptimize("loop boundary");
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
    worker.postMessage({ type: "optimize", reqId: ++reqId, save: doSave(), queue });
    setStatus(`optimising Buy Mana (${reason})…`);
}

function onOptimizeResult(msg) {
    awaitingOptimize = false;
    optimizeSuggestion = msg;
    const before = msg.report?.before, after = msg.report?.after;
    const changed = JSON.stringify(msg.queue) !== JSON.stringify(currentQueuePairs());
    setStatus(changed
        ? `Buy Mana: ${msg.report?.moves} change(s) — buyMana ${before?.convExecs}→${after?.convExecs}, gold ${before?.unconvGold}→${after?.unconvGold}`
        : "Buy Mana: already optimal");
    // auto-apply (default off): install the proposal for the next loop.
    if (options.economyOptimizer && options.economyOptimizerAuto && changed) {
        installQueue(msg.queue);
        setStatus(`Buy Mana: auto-applied (${msg.report?.moves} change(s))`);
    }
    if (isAutomationViewActive()) renderOptimize();
}

// button: compute a proposal now (suggest-first — does not install).
function optimizeBuyMana() {
    if (!options.economyOptimizer) { setStatus("enable the Buy Mana optimiser first"); return; }
    requestOptimize("manual");
}

// button: install the last proposal.
function applyOptimize() {
    if (!optimizeSuggestion) { setStatus("no Buy Mana proposal yet — press Optimise"); return; }
    installQueue(optimizeSuggestion.queue);
    setStatus(`Buy Mana: applied (${optimizeSuggestion.report?.moves} change(s))`);
    if (isAutomationViewActive()) renderOptimize();
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
    // Stats-panel Automation view: the radio only exists while the master
    // gate is on; if it was active when the gate flips off, fall back to the
    // Regular view.
    const wrap = document.getElementById("automationStatsWrap");
    if (wrap) wrap.style.display = options.advancedAutomation ? "" : "none";
    if (!options.advancedAutomation) {
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

// Buy Mana optimiser proposal + waste delta (Automation view).
function renderOptimize() {
    const el = document.getElementById("buyManaOptimizerBody");
    if (!el) return;
    if (!optimizeSuggestion) { el.innerHTML = "No proposal yet — press Optimise Buy Mana."; return; }
    const { queue, report } = optimizeSuggestion;
    const b = report?.before ?? {}, a = report?.after ?? {};
    const d = (x, y) => `${fmt(x ?? 0)}→${fmt(y ?? 0)}`;
    el.innerHTML =
        `<div>converter: ${esc(report?.converter ?? "(none)")}, ${report?.moves ?? 0} change(s)</div>` +
        `<div>failed reps ${d(b.failed, a.failed)}, Buy Mana execs ${d(b.convExecs, a.convExecs)}, ` +
        `unconverted gold ${d(b.unconvGold, a.unconvGold)}</div>` +
        `<div>proposed: ${esc(queue.map(([n, l]) => `${n} x${l}`).join(", "))}</div>`;
}

let statsRefreshTimer = null;
function onViewShown() {
    renderCompactStats();
    renderLastPlan();
    renderPools();
    renderOptimize();
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
optionValueHandlers.advancedAutomation = (value, init) => {
    refreshSectionVisibility();
    if (!value) { shutdownWorker(); suggestion = null; installedQueueJSON = null; if (!init) setStatus("off"); }
};
optionValueHandlers.plannerMode = (value, init) => {
    if (value === "off") { shutdownWorker(); installedQueueJSON = null; if (!init) setStatus("off"); }
    else if (value === "auto") { installedQueueJSON = null; }   // adopt whatever queue comes next
};
optionValueHandlers.economyOptimizer = (value, init) => {
    const sec = document.getElementById("buyManaOptimizerSection");
    if (sec) sec.style.display = value ? "" : "none";
    if (!value) optimizeSuggestion = null;
};

return {
    interceptPrepareRestart,
    planNow,
    applySuggestion,
    optimizeBuyMana,
    applyOptimize,
    showDivergences,
    refreshSectionVisibility,
    onViewShown,
    refreshInternals,
    isEnabled,
    _debug: { getSuggestion: () => suggestion, getLastError: () => lastError,
              getOptimizeSuggestion: () => optimizeSuggestion, requestOptimize },
};
})();
