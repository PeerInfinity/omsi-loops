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
// completion; a truthy stub would change search-toggle semantics.
self.document = {
    title: "", getElementById: () => null, dispatchEvent: () => true,
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
    "driver.js",
    "stats.js",
    "actions.js",
    "town.js",
    "prestige.js",
    "saving.js",
    "predictor.js",
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
        case "plan": {
            const t0 = Date.now();
            try {
                if (data.params) {
                    P.weights = data.params.weights ?? P.weights;
                    P.screenK = data.params.screenK ?? P.screenK;
                    P.probeEvery = data.params.probeEvery ?? P.probeEvery;
                    P.seedFromPredictor = data.params.seedFromPredictor ?? P.seedFromPredictor;
                    P.multiTown = data.params.multiTown ?? P.multiTown;
                    // sim option (plRestoreSave never loads options): keep the
                    // worker's engine gaining exp at the live game's rate
                    if (data.params.expGainMultiplier !== undefined) options.expGainMultiplier = data.params.expGainMultiplier;
                }
                if (data.actualQueue) P.lastCommitted = data.actualQueue;
                IdlePlanner._internals.plRestoreSave(
                    typeof data.save === "string" ? data.save : JSON.stringify(data.save));
                P.pre = null;   // always re-read from the restored live state
                const { best, evals, nCands, nScreened } = await IdlePlanner.planRound(sess, P);
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
