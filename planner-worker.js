// planner-worker.js — Advanced Automation planning host (fork addition).
//
// Runs the full sim + IdlePlanner in a Web Worker (modeled on
// predictor-worker.js, extended with the headless stub recipe from the
// substrate experiments: unlike the predictor, the planner drives real
// restart()/loop cycles on its own copy of the game, so it needs the same
// ~40 lines of DOM/View stubs a Node harness does).
//
// All rolled-back evaluation (threshold probing, micro-eval measurement,
// candidate confirmation) happens HERE, on the worker's private copy of the
// game state restored from the main thread's doSave() snapshot. The live
// game is never rolled back; it only ever receives the winning queue.

// ---- headless stubs: must precede importScripts (View flips selfIsGame) ----
const noopProxy = () => new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) });
self.View = class { constructor() { return noopProxy(); } };
self.ActionLog = class { constructor() { return noopProxy(); } };
self.GoogleCloud = class { constructor() { return noopProxy(); } };
self.HTMLInputElement = class {};
self.HTMLTextAreaElement = class {};
self.HTMLSelectElement = class {};
self.HTMLElement = class {};
// getElementById -> null is load-bearing: Town.finishRegular probes
// searchToggler inputs with throwIfMissing=false on every limited-action
// completion, and a null there means LOOT-FIRST (the planner's native
// model). The one exception: when the main thread forwards the live
// "Lootable first" checkbox states (plannerControlLootFirst OFF), the sim
// must honor them — getElement type-checks with instanceof, so the shim
// returns real HTMLInputElement stub instances. Boot-time behavior is
// unchanged (lootFirstStates stays null until a plan message sets it).
let lootFirstStates = null;
self.document = {
    title: "",
    getElementById: (id) => {
        if (lootFirstStates && typeof id === "string" && id.startsWith("searchToggler")) {
            const v = id.slice("searchToggler".length);
            if (Object.prototype.hasOwnProperty.call(lootFirstStates, v)) {
                const el = new self.HTMLInputElement();
                el.checked = lootFirstStates[v];
                return el;
            }
        }
        return null;
    },
    dispatchEvent: () => true,
    documentElement: { style: { setProperty() {}, getPropertyValue: () => "" }, classList: { toggle() {}, add() {}, remove() {} } },
};
self.requestAnimationFrame = () => 0;
self.shiftDown = false;
self.controlDown = false;
self.altDown = false;
self.localStorage = new (class {
    #m = new Map();
    getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
    setItem(k, v) { this.#m.set(k, String(v)); }
    removeItem(k) { this.#m.delete(k); }
})();
self.$ = Object.assign(() => ({ length: 0, find: () => ({ text: () => "" }), each() {} }), { get() {}, param() {} });

importScripts(
    "data.js",
    "localization.js",
    "helpers.js",
    "actionList.js",
    "xmlLite.js",
    "actionListXml.js",
    "data/actionListXml.data.js",
    "unlocks.js",
    "driver.js",
    "stats.js",
    "actions.js",
    "town.js",
    "prestige.js",
    "saving.js",
    "predictor.js",
    "planner-metadata.js",
    "planner.js"
);

loadDefaults();
stonesUsed = { 1: 0, 3: 0, 5: 0, 6: 0 };   // set in load(), not loadDefaults(); HaulZ* throw without it
if (!townsUnlocked.length) townsUnlocked = [0];   // load() defaults this; loadDefaults() leaves []
// Eval loops drive the real prepareRestart(); the pause path would stall the
// chunk driver, so the worker's copy keeps these hard-off (plRestoreSave
// never loads options, so they cannot come back).
options.pauseBeforeRestart = false;
options.pauseOnFailedLoop = false;
options.pauseOnComplete = false;
// fork: XML-actions option — the worker's options are the defaults (off)
// unless a driver flips it before boot completes; inert by default
if (options.useActionListXml) ActionListXml.applyOverrides();

// fork: P2 transport (cross-game P2-A) — install the world data that rides
// every request BEFORE any sim work. Stateless per request: a null/absent
// worldConfig clears a previously installed one, so a mid-session schedule
// install or clear self-heals without recreating the worker (same contract as
// lootFirst and setOptions). installWorldConfig mirrors the managed-mode
// option flip; against a clean context a null config is a true no-op.
function installWorldConfig(cfg) {
    if (typeof ActionListXml === "undefined") return;
    if (!ActionListXml.installWorldConfig(cfg ?? null)) {
        console.warn("planner-worker: worldConfig rejected; sim runs the vanilla world");
    }
}

const sess = new IdlePlanner.Session();
let P = IdlePlanner.newPlanningState();

onmessage = async (e) => {
    const data = e.data;
    if (!data?.type) return;
    switch (data.type) {
        case "reset":
            P = IdlePlanner.newPlanningState(data.params ?? {});
            postMessage({ type: "resetDone" });
            break;
        case "dump": {
            // Introspection for the Stats-panel Automation view: everything
            // planRound accumulates (knowledge, thresholds, prev capacity/
            // pump pair, last committed queue) plus the divergence log.
            // §V4 two-tier UI: also derive each goal's READ-ONLY Tier-2
            // prerequisite chain (the DAG findSetupLeaf would walk) so the
            // priority-list editor can render + flatten it. Goals come from the
            // live editor (data.goals) falling back to P.targets; the state is
            // the last-planned loop start (planRound leaves sess restored to
            // snap). deriveTier2Tree never mutates committed state and its only
            // sim call (probePoolCap) restores itself bit-identically ⇒ this is
            // pure introspection, never on the planRound path ⇒ byte-inert.
            let tier2 = [];
            try {
                const goals = data.goals ?? P.targets ?? [];
                if (goals.length) {
                    const pre = sess.read();
                    tier2 = goals.map(g => ({
                        key: IdlePlanner.goalKey(g),
                        tree: IdlePlanner.deriveTier2Tree(pre, P.know, sess, g),
                    }));
                }
            } catch { tier2 = []; }
            postMessage({
                type: "dumpResult",
                planning: IdlePlanner.serializePlanningState(P),
                divergences: P.divergenceLog,
                tier2,
            });
            break;
        }
        case "optimize": {
            // §11.6 ladder — Buy Mana / zone-1 economy optimiser. Rebalances the
            // player's queue on the worker's PRIVATE sim copy (never the live
            // game). Restore -> install the queue -> restart to a clean loop
            // start -> optimise.
            try {
                installWorldConfig(data.worldConfig);
                IdlePlanner._internals.plRestoreSave(
                    typeof data.save === "string" ? data.save : JSON.stringify(data.save));
                const queue = data.queue ?? [];
                sess.setQueue(queue);
                sess.restart();
                const snap = sess.save();
                const res = IdlePlanner.optimizeEconomy(sess, snap, queue);
                postMessage({ type: "optimizeResult", reqId: data.reqId, queue: res.queue, report: res.report });
            } catch (err) {
                postMessage({ type: "error", reqId: data.reqId, message: err?.message ?? String(err) });
            }
            break;
        }
        case "plan": {
            const t0 = Date.now();
            try {
                if (data.params) {
                    P.weights = data.params.weights ?? P.weights;
                    P.screenK = data.params.screenK ?? P.screenK;
                    P.probeEvery = data.params.probeEvery ?? P.probeEvery;
                    P.seedFromPredictor = data.params.seedFromPredictor ?? P.seedFromPredictor;
                    P.multiTown = data.params.multiTown ?? P.multiTown;
                    P.vocabulary = data.params.vocabulary ?? P.vocabulary;
                    // §11.10 targeted mode (generator + priority list + auto-rank)
                    P.strategy = data.params.strategy ?? P.strategy;
                    P.targets = data.params.targets ?? P.targets;
                    P.autoRankTargets = data.params.autoRankTargets ?? P.autoRankTargets;
                    P.antiFixation = data.params.antiFixation ?? P.antiFixation;
                    // sim option (plRestoreSave never loads options): keep the
                    // worker's engine gaining exp at the live game's rate
                    if (data.params.expGainMultiplier !== undefined) options.expGainMultiplier = data.params.expGainMultiplier;
                }
                lootFirstStates = data.lootFirst ?? null;
                installWorldConfig(data.worldConfig);
                if (data.actualQueue) P.lastCommitted = data.actualQueue;
                IdlePlanner._internals.plRestoreSave(
                    typeof data.save === "string" ? data.save : JSON.stringify(data.save));
                P.pre = null;   // always re-read from the restored live state
                // §11.7 Design B: when the main thread asks for a pipelined plan,
                // simulate the committed queue `replanEvery` loops forward and
                // plan from the PREDICTED boundary, returning the hash the live
                // game must still match to install this plan. Falls back to a
                // plain planRound (no look-ahead) when not pipelining or when
                // there is no committed queue to simulate.
                let boundaryHash = null, result;
                if (data.pipeline && data.actualQueue?.length) {
                    result = await IdlePlanner.planPipeline(sess, P, data.actualQueue, data.replanEvery ?? 1);
                    boundaryHash = result.boundaryHash;
                } else {
                    result = await IdlePlanner.planRound(sess, P);
                }
                const { best, evals, nCands, nScreened } = result;
                P.prevTimeNeeded = best.capacity;
                P.prevProbeTicks = best.probeTicks;
                P.lastCommitted = best.c.q;
                postMessage({
                    type: "result", reqId: data.reqId,
                    loop: P.loop,
                    queue: best.c.q,
                    label: best.c.label,
                    score: best.score,
                    projectedTicks: best.r.ticks,
                    projectedMana: best.r.lastTimeNeeded,
                    nCands, nScreened, evals,
                    boundaryHash,
                    divergenceCount: P.divergenceLog.length,
                    recentDivergences: P.divergenceLog.slice(-5),
                    wallMs: Date.now() - t0,
                });
            } catch (err) {
                postMessage({ type: "error", reqId: data.reqId, message: err?.message ?? String(err) });
            }
            break;
        }
    }
};

postMessage({ type: "ready" });
