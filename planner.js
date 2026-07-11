// planner.js — Advanced Automation queue planner (fork addition).
//
// A generic planner that builds the action queue each loop by:
//   1. reading persistent state + probing unlock thresholds (perturbation on
//      the pure visible()/unlocked() closures) and canStart resource needs,
//   2. refreshing an empirical knowledge table (per-action yields measured by
//      micro-evals of the real engine, rolled back via save/restore) —
//      optionally cross-checked against the Koviko predictor's effect model
//      (predictor-vs-engine divergence is recorded, never trusted blind),
//   3. generating candidate queues from generic generators (economy core,
//      grind variants along frontier dimensions, investment, purchase
//      insertion, travel push variants) — no hand-scripted phase chain,
//   4. screening candidates with the Koviko predictor (cheap, approximate),
//   5. confirming the top candidates with the chunked real engine (ground
//      truth, rolled back), scoring them against a weighted objectives model,
//   6. handing the winner to the caller (the standalone driver commits it;
//      the live game installs it into actions.next and plays it for real).
//
// This file must load in three contexts:
//   - planner-worker.js (Web Worker: importScripts after the 11 sim files) —
//     where all rolled-back evaluation happens in live play, on the worker's
//     OWN copy of the game state; the real game is never rolled back;
//   - a Node vm context (test/harness.mjs, the stats harness) for headless
//     deterministic runs;
//   - the main page (index.html) — inert; only the parameter definitions and
//     the AdvancedAutomation controller (automation.js) touch it.
//
// Provenance: direct port of the proven queue-planner v0 experiment
// (500 loops / 5,432,753 ticks to Forest Path vs the 646-loop scripted
// baseline, deterministic). The algorithm is transliterated, not rewritten;
// engine gotchas it encodes: positional prerequisites (a canStart-failing
// action is skipped for the REST of the loop), travel tail-pinning in
// addAction, per-loop gold/rep evaporation, goodTemp harvests before checks,
// purchases whose price lives outside goldCost() (Buy Supplies), vacuous
// converter execs, solo micro-evals starving without injected mana.

// eslint-disable-next-line no-unused-vars
const IdlePlanner = (() => {
"use strict";

// ---------------------------------------------------------------------------
// Story-function shims: these live in views/main.view.js (not loaded in
// workers / headless contexts), but action story()/finish() hooks call them.
// Guarded so the real definitions win on the main page.
// ---------------------------------------------------------------------------
if (typeof globalThis.setStoryFlag === "undefined") {
    globalThis.setStoryFlag = function setStoryFlag(name) { storyFlags[name] = true; };
    globalThis.unlockStory = globalThis.setStoryFlag;
    globalThis.increaseStoryVarTo = function increaseStoryVarTo(name, value) { if (storyVars[name] < value) storyVars[name] = value; };
    globalThis.unlockGlobalStory = function unlockGlobalStory(num) { if (num > storyMax) storyMax = num; };
}

// ---------------------------------------------------------------------------
// Objective weights (every one surfaced in the Options UI).
// ---------------------------------------------------------------------------
const DEFAULT_WEIGHTS = {
    town: 1e12,        // unlocking a town wins the loop outright
    unlockAction: 1000, // an action newly unlocked
    visibleAction: 300, // an action newly visible
    frontier: 4000,    // sum of exp-fraction progress toward probed unlock thresholds
    mana: 800,         // log-growth of realized per-loop mana capacity
    bank: 30,          // measured mana-equivalent value of newly banked good items (a bank pays out EVERY future loop)
    bankPot: 15,       // newly DISCOVERED items (total pool growth = future banks)
    talent: 0.01,      // total talent exp (long-horizon tie-break)
};

// RNG snapshot hooks: headless harnesses install get/set over their seeded
// PRNG so candidate evaluation rolls the RNG stream back too. In the browser
// the stream can't be rolled back — harmless on RNG-free routes (all of
// town 0), and planning is advisory elsewhere.
let rngHooks = { get: () => null, set: () => {} };
function setRngHooks(hooks) { rngHooks = hooks; }

// ---------------------------------------------------------------------------
// Sim-state helpers (ported from the experiments' sim-boot shims; same JSON
// boundaries as v0 for bit-faithful behavior).
// ---------------------------------------------------------------------------
function plSetQueue(entries) {
    actions.clearActions();
    for (const [name, loops] of entries) actions.addAction(name, loops);
}
// The queue as the engine actually ordered it (travel tail-pinning may
// relocate entries relative to what plSetQueue appended).
function plGetQueue() {
    return JSON.stringify(actions.next.map(a => [a.name, a.loops]));
}

// Estimated mana cost of one completion at CURRENT stat levels
// (mirrors setAdjustedTicks in actions.js).
function plAdjCost(name) {
    const proto = getActionPrototype(name);
    let m = 0;
    for (const s in proto.stats) m += proto.stats[s] * stats[s].manaMultiplier;
    return Math.max(1, Math.ceil(proto.manaCost() * m));
}

// ---- generic full-state readout ----------------------------------------
function plReadState() {
    const skillsOut = {};
    for (const s in skills) skillsOut[s] = { exp: skills[s].exp ?? 0, level: getSkillLevel(s) };
    const townsOut = [];
    for (const town of towns) {
        const progress = {}, limited = {};
        for (const a of town.totalActionList) {
            if (a.type === "progress") progress[a.varName] = {
                exp: town["exp" + a.varName] ?? 0, level: town.getLevel(a.varName),
            };
            else if (a.type === "limited") limited[a.varName] = {
                good: town["good" + a.varName] ?? 0,
                checked: town["checked" + a.varName] ?? 0,
                total: town["total" + a.varName] ?? 0,
            };
        }
        townsOut.push({ index: town.index, progress, limited, suppliesCost: town.suppliesCost });
    }
    const actionsOut = [];
    for (const town of towns) {
        if (!townsUnlocked.includes(town.index)) continue;
        for (const a of town.totalActionList) {
            let visible = false, unlocked = false, allowed = null, goldCost = 0;
            try { visible = !!a.visible(); } catch (e) {}
            try { unlocked = !!a.unlocked(); } catch (e) {}
            try { allowed = a.allowed ? a.allowed() : null; } catch (e) {}
            try { goldCost = a.goldCost ? a.goldCost() : 0; } catch (e) {}
            actionsOut.push({
                name: a.name, townNum: a.townNum, type: a.type, varName: a.varName ?? null,
                travelNum: getTravelNum(a.name), expMult: a.expMult ?? 1,
                visible, unlocked, allowed, goldCost,
                cost: plAdjCost(a.name),
                skillsGained: a.skills ? Object.keys(a.skills) : [],
                statsUsed: a.stats ? Object.keys(a.stats) : [],
            });
        }
    }
    return JSON.stringify({
        loops: totals.loops, townsUnlocked: townsUnlocked.slice(),
        skills: skillsOut, towns: townsOut, actions: actionsOut,
        talentTotal: totalTalent,
        baseMana: timeNeededInitial,
    });
}

// ---- snapshot / restore -------------------------------------------------
// Snapshot = the game's own doSave() (it enumerates exactly what the game
// considers persistent; per-loop state is reset by restart()).
function plSaveClone() {
    return JSON.stringify(doSave());
}

// doLoad-lite: the sim-relevant subset of saving.js doLoad(), minus every
// view/options/DOM touch. Restores persistent state only; callers must
// restart() afterwards (which they do anyway to install a queue).
function plRestoreSave(json) {
    const toLoad = JSON.parse(json);
    for (const p of Object.getOwnPropertyNames(toLoad.stats ?? {})) if (p in stats) stats[p].load(toLoad.stats[p]);
    for (const p of Object.getOwnPropertyNames(toLoad.skills ?? {})) if (p in skills) skills[p].load(toLoad.skills[p]);
    for (const p in toLoad.buffs) if (toLoad.buffs.hasOwnProperty(p)) buffs[p].amt = Math.min(toLoad.buffs[p].amt, buffHardCaps[p]);
    if (toLoad.buffCaps !== undefined)
        for (const p in buffCaps) if (toLoad.buffCaps.hasOwnProperty(p)) buffCaps[p] = toLoad.buffCaps[p];
    if (toLoad.prestigeValues !== undefined) Object.assign(prestigeValues, toLoad.prestigeValues);
    for (const p in storyFlags) storyFlags[p] = toLoad.storyReqs?.[p] ?? false;
    for (const p in storyVars) storyVars[p] = toLoad.storyVars?.hasOwnProperty(p) ? toLoad.storyVars[p] : -1;
    storyMax = toLoad.storyMax ?? 0;
    totalTalent = toLoad.totalTalent ?? 0;
    townsUnlocked = (toLoad.townsUnlocked ?? [0]).slice();
    completedActions = (toLoad.completedActions ?? []).slice();
    trainingLimits = 10 + getBuffLevel("Imbuement");
    goldInvested = toLoad.goldInvested ?? 0;
    stonesUsed = toLoad.stonesUsed ?? {1:0, 3:0, 5:0, 6:0};

    // dungeons/trials: same structure fixups as doLoad
    dungeons = [[], [], []];
    const level = { ssChance: 1, completed: 0 };
    for (let i = 0; i < dungeons.length; i++)
        for (let j = 0; j < dungeonFloors[i]; j++) {
            dungeons[i][j] = toLoad.dungeons?.[i]?.[j] ? {...toLoad.dungeons[i][j]} : {...level};
            dungeons[i][j].lastStat = "NA";
        }
    trials = [[], [], [], [], []];
    for (let i = 0; i < trials.length; i++) {
        trials[i].highestFloor = 0;
        for (let j = 0; j < trialFloors[i]; j++) {
            trials[i][j] = toLoad.trials?.[i]?.[j] ? {...toLoad.trials[i][j]} : { completed: 0 };
            if (trials[i][j].completed > 0) trials[i].highestFloor = j;
        }
    }

    // town vars (exp/total/checked/good/goodTemp) + hiddenVars
    const hiddenVarNames = toLoad.hiddenVars?.slice() ?? [];
    for (const town of towns) {
        const hv = hiddenVarNames.shift() ?? [];
        town.hiddenVars.clear();
        for (const v of hv) town.hiddenVars.add(v);
        // NOTE: assign-or-delete, not "?? 0" — several town vars are created
        // lazily; doSave() drops undefined keys, and creating them as 0 on
        // restore would diverge from a live context that never touched them.
        const setOrDelete = (k) => {
            if (toLoad[k] !== undefined) town[k] = toLoad[k];
            else delete town[k];
        };
        for (const a of town.totalActionList) {
            if (a.type === "progress") setOrDelete("exp" + a.varName);
            else if (a.type === "multipart") setOrDelete("total" + a.varName);
            else if (a.type === "limited") {
                const v = a.varName;
                setOrDelete("total" + v);
                setOrDelete("checked" + v);
                if (toLoad["good" + v] !== undefined) {
                    town["good" + v] = toLoad["good" + v];
                    town["goodTemp" + v] = toLoad["good" + v];
                } else { delete town["good" + v]; delete town["goodTemp" + v]; }
            }
        }
    }

    actions.clearActions();
    if (toLoad.nextList)
        for (const a of toLoad.nextList)
            if (totalActionList.some(x => x.name === a.name))
                actions.addActionRecord({...a}, -1, false);

    if (toLoad.totals !== undefined) {
        totals.time = toLoad.totals.time ?? 0;
        totals.effectiveTime = toLoad.totals.effectiveTime ?? 0;
        totals.borrowedTime = toLoad.totals.borrowedTime ?? 0;
        totals.loops = toLoad.totals.loops ?? 0;
        totals.actions = toLoad.totals.actions ?? 0;
    }
    currentLoop = totals.loops;
    adjustAll();
}

// ---- unlock-threshold probing -------------------------------------------
// visible()/unlocked() are pure functions of town progress exp, skill levels,
// resources and story flags, so thresholds can be discovered by perturbing
// one dimension at a time and re-evaluating. Two passes per locked action:
//   A) others at CURRENT values -> minimal level of dim d that unlocks now
//      (captures sum-clauses like Combat+Magic>=35 and the last missing dim)
//   B) all dims maxed except d probed -> per-dim floor in conjunctions
// Leaves the full-state snapshot bit-identical (verified by selftest).
function plProbeThresholds(maxSkillLevel) {
    maxSkillLevel = maxSkillLevel ?? 500;
    const MAXP = 100;
    const dims = [];
    for (const ti of townsUnlocked) {
        const town = towns[ti];
        const seen = new Set();
        for (const a of town.totalActionList) {
            if (a.type !== "progress" || seen.has(a.varName)) continue;
            seen.add(a.varName);
            dims.push({ kind: "p", town: ti, v: a.varName });
        }
    }
    for (const s in skills) dims.push({ kind: "s", v: s });

    const expOfProgressLevel = (town, v, L) =>
        towns[town].progressScaling[v] === "linear" ? 5050 * L : 100 * L * (L + 1) / 2;
    const levelOfSavedExp = (d, exp) =>
        towns[d.town].progressScaling[d.v] === "linear" ? Math.floor(exp / 5050) : getLevelFromExp(exp);
    const getDim = (d) => d.kind === "p" ? towns[d.town].getLevel(d.v) : getSkillLevel(d.v);
    const saved = dims.map(d => d.kind === "p" ? towns[d.town]["exp" + d.v] : skills[d.v].levelExp.level);
    const setDim = (d, L) => {
        if (d.kind === "p") towns[d.town]["exp" + d.v] = expOfProgressLevel(d.town, d.v, L);
        else skills[d.v].levelExp.level = L;
    };
    const restoreAll = () => dims.forEach((d, i) => {
        if (d.kind === "p") towns[d.town]["exp" + d.v] = saved[i];
        else skills[d.v].levelExp.level = saved[i];
    });
    const maxOf = (d) => d.kind === "p" ? MAXP : maxSkillLevel;

    const out = {};
    try {
        const targets = [];
        for (const ti of townsUnlocked)
            for (const a of towns[ti].totalActionList) {
                let ok = false;
                try { ok = !!(a.visible() && a.unlocked()); } catch (e) {}
                if (!ok) targets.push(a);
            }
        for (const a of targets) {
            const test = () => { try { return !!(a.visible() && a.unlocked()); } catch (e) { return false; } };
            const requires = [];
            // pass A: single-dim raise from current
            for (const d of dims) {
                const cur = getDim(d);
                setDim(d, maxOf(d));
                const flips = test();
                if (flips) {
                    let lo = cur, hi = maxOf(d);   // minimal L in (cur, hi] that passes
                    while (lo + 1 < hi) {
                        const mid = Math.floor((lo + hi) / 2);
                        setDim(d, mid);
                        if (test()) hi = mid; else lo = mid;
                    }
                    requires.push({ kind: d.kind, town: d.town, v: d.v, need: hi, cur, pass: "A" });
                }
                setDim(d, maxOf(d)); restoreAll();
            }
            // pass B: conjunctions — floors with everything else maxed
            let probeable = requires.length > 0;
            if (!requires.length) {
                dims.forEach(d => setDim(d, maxOf(d)));
                if (test()) {
                    probeable = true;
                    for (const d of dims) {
                        const cur0 = saved[dims.indexOf(d)];
                        const cur = d.kind === "p" ? levelOfSavedExp(d, cur0) : cur0;
                        setDim(d, cur);
                        if (!test()) {
                            let lo = cur, hi = maxOf(d);
                            while (lo + 1 < hi) {
                                const mid = Math.floor((lo + hi) / 2);
                                setDim(d, mid);
                                if (test()) hi = mid; else lo = mid;
                            }
                            if (hi > cur) requires.push({ kind: d.kind, town: d.town, v: d.v, need: hi, cur, pass: "B" });
                        }
                        setDim(d, maxOf(d));
                    }
                }
                restoreAll();
            }
            out[a.name] = { probeable, requires };
        }
    } finally {
        restoreAll();
    }
    return JSON.stringify(out);
}

// ---- canStart resource-requirement probing --------------------------------
function plProbeCanStartNeeds(name) {
    const a = towns.flatMap(t => t.totalActionList).find(x => x.name === name);
    if (!a || !a.canStart) return "[]";
    const saved = JSON.parse(JSON.stringify(resources));
    const needs = [];
    try {
        if (a.canStart()) return "[]";
        for (const k in resources) {
            const v = resources[k];
            resources[k] = (typeof v === "boolean") ? true : 1e9;
            let ok = false;
            try { ok = !!a.canStart(); } catch (e) {}
            if (ok) needs.push(k);
            resources[k] = v;
        }
        if (!needs.length) {
            // conjunction of resources: raise cumulatively
            for (const k in resources) {
                resources[k] = (typeof resources[k] === "boolean") ? true : 1e9;
                let ok = false;
                try { ok = !!a.canStart(); } catch (e) {}
                needs.push(k);
                if (ok) break;
            }
        }
    } finally {
        Object.assign(resources, saved);
    }
    return JSON.stringify(needs);
}

// ---- loop driver (chunked; the game's real executeGameTicks core) ---------
function plGoldCosts() {
    const out = {};
    for (const ti of townsUnlocked)
        for (const a of towns[ti].totalActionList) {
            if (!a.goldCost) continue;
            try { if (a.visible()) out[a.name] = a.goldCost(); } catch (e) {}
        }
    return out;
}
function plRunOneLoopChunk(maxIters) {
    const startLoops = totals.loops;
    let iters = 0, spent = 0, maxGold = 0;
    let lastResources = null, lastTimeNeeded = timeNeeded, lastExec = null, lastCurTown = 0, lastGoldCosts = null;
    while (totals.loops === startLoops && iters < maxIters) {
        if (resources.gold > maxGold) maxGold = resources.gold;
        let manaAvailable = timeNeeded - timer;
        if (shouldRestart) manaAvailable = Math.min(manaAvailable, 1);
        const manaSpent = Mana.ceil(actions.tick(manaAvailable), timer / 1e15);
        timer += manaSpent;
        timeCounter += manaSpent / baseManaPerSecond;
        effectiveTime += manaSpent / baseManaPerSecond;
        refreshDungeons(manaSpent);
        spent += manaSpent;
        iters++;
        if (shouldRestart || timer >= timeNeeded) {
            // capture end-of-loop state BEFORE restart wipes per-loop data
            lastResources = JSON.parse(JSON.stringify(resources));
            lastTimeNeeded = timeNeeded;
            lastCurTown = curTown;
            lastGoldCosts = plGoldCosts();
            lastExec = actions.current.map(a => ({ name: a.name, loops: a.loops, loopsLeft: a.loopsLeft, manaUsed: a.manaUsed }));
            // real prepareRestart(), exactly as v0 (getNextValidAction inside
            // it mutates action state, so a "headless" shortcut would diverge).
            // Planning contexts must keep options.pauseBeforeRestart/
            // pauseOnFailedLoop at their false defaults or the pause path
            // would stall the chunk driver (the worker forces them off).
            loopEnd(); prepareRestart();
            // Degenerate loop: nothing could start, 0 mana spent -> loopEnd()
            // skips the totals.loops bump (effectiveTime === 0 guard) and the
            // game would silently restart forever. Surface it instead.
            if (totals.loops === startLoops && spent === 0)
                return JSON.stringify({ ticks: 0, iters, lastResources, lastTimeNeeded,
                                        lastCurTown, lastExec, lastGoldCosts, ended: true, degenerate: true });
        }
        else if (manaSpent === 0) throw new Error("chunk driver stalled: 0 mana spent, no restart");
    }
    return JSON.stringify({
        ticks: spent, iters, maxGold,
        lastResources, lastTimeNeeded, lastCurTown, lastExec, lastGoldCosts,
        ended: totals.loops !== startLoops, degenerate: false,
    });
}
// Measurement-only helper: inject resources/mana into the CURRENT loop
// (call between restart() and the loop driver). Rolled back by the caller's
// restore, so it never leaks into committed play.
function plInjectResources(json) {
    const inj = JSON.parse(json);
    for (const [k, v] of Object.entries(inj)) {
        if (k === "mana") { addMana(v); }
        else resources[k] = (typeof resources[k] === "boolean") ? !!v : (resources[k] ?? 0) + v;
    }
}

// Full-state snapshot for determinism/fidelity hashes (byte-compatible with
// the v0 experiments harness, so the 500-loop result is directly comparable).
function plSnapshot() {
    const townDump = towns.map(t => {
        const o = {};
        for (const v of t.allVarNames) {
            for (const p of ["exp", "checked", "good", "total"]) {
                const k = p + v;
                if (typeof t[k] === "number") o[k] = Math.round(t[k] * 1e6) / 1e6;
            }
        }
        return o;
    });
    return JSON.stringify({
        timer, timeNeeded,
        effectiveTime: Math.round(effectiveTime * 1000),
        totals, resources, townsUnlocked,
        townDump,
        skillExp: Object.fromEntries(Object.entries(skills).map(([k, v]) => [k, Math.round((v.exp ?? 0) * 1e6)])),
        statTalentExp: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round((v.talentLevelExp?.exp ?? 0) * 1e6)])),
        storyFlagsOn: Object.keys(storyFlags).filter(k => storyFlags[k]),
        storyMax,
    });
}

// ---- predictor as headless queue scorer -----------------------------------
let plPredictor = null;
function plInitPredictor() {
    plPredictor = Koviko.initWorkerPredictor();     // isWorker=true -> no DOM constructor
    plPredictor.setOptions(options);
    options.predictorBackgroundThread = false;      // worker getter throws in-worker
    Koviko.trackedStats = { Rsoul: { type: "R", name: "soul", display_name: "SS Equi %" } };
    plPredictor.statisticDisplay = { style: {}, innerHTML: "" };
    plPredictor.totalDisplay = { style: {}, innerHTML: "", parentElement: { classList: { add() {}, remove() {} } } };
}
async function plPredictQueue(entries) {
    if (!plPredictor) plInitPredictor();
    try {
        const runData = await plPredictor.update(entries.map(([name, loops]) => ({ name, loops })), null, false);
        return JSON.stringify({
            ok: true,
            totalMana: runData.total,
            isValid: runData.isValid,
            resources: runData.state?.resources ?? null,
        });
    } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
    }
}

// ---------------------------------------------------------------------------
// Session: same surface as the v0 experiments harness (JSON boundaries kept).
// ---------------------------------------------------------------------------
class Session {
    read() { return JSON.parse(plReadState()); }
    probe() { return JSON.parse(plProbeThresholds(500)); }
    needs(name) { return JSON.parse(plProbeCanStartNeeds(name)); }
    save() { return { save: plSaveClone(), rng: rngHooks.get() }; }
    restore(snap) { plRestoreSave(snap.save); rngHooks.set(snap.rng); }
    setQueue(q) { plSetQueue(q); }
    getQueue() { return JSON.parse(plGetQueue()); }
    restart() { restart(); }
    runLoop(maxIters = 500_000) {
        const r = JSON.parse(plRunOneLoopChunk(maxIters));
        if (!r.ended) throw new Error(`loop did not end within ${maxIters} iters`);
        return r;
    }
    async predict(q) { return JSON.parse(await plPredictQueue(q)); }
    snapshot() { return plSnapshot(); }
}

// ---------------------------------------------------------------------------
// Knowledge table: per-action empirical profiles from engine micro-evals.
// ---------------------------------------------------------------------------
function emptyProfile() {
    return {
        measuredAtLoop: -1, bankAtMeasure: 0, exec: 0, ticksPerExec: 0, manaPerExec: 0,
        goldPerExec: 0, repPerExec: 0, grants: {}, costReductions: {}, discovers: {},
        gatedOn: [], manaPerGold: 0,
    };
}

// Run one rolled-back engine loop with the given queue; return run record + post state.
// `inject` (measurement only): resources/mana granted right after restart.
function evalLoop(sess, snap, queue, inject = null) {
    sess.restore(snap);
    sess.setQueue(queue);
    sess.restart();
    if (inject) plInjectResources(JSON.stringify(inject));
    const r = sess.runLoop();
    const post = sess.read();
    return { r, post };
}

function execCountOf(r, name) {
    let n = 0;
    for (const e of r.lastExec ?? []) if (e.name === name) n += e.loops - e.loopsLeft;
    return n;
}

// Next-loop capacity probe: from a candidate's post-loop snapshot, run one
// harvest-everything (+ convert) loop and return its realized mana capacity.
// This is what makes investment (checking items -> banked goods) visible to
// the otherwise one-loop-greedy objective: banked pots/quests only pay off in
// the NEXT loop's budget.
function probeCapacity(sess, postSnap, post, know) {
    const q = [];
    const pools = [];
    for (const a of post.actions) {
        if (!(a.visible && a.unlocked) || a.type !== "limited") continue;
        const lim = post.towns[a.townNum]?.limited[a.varName];
        if (lim?.good > 0) pools.push({ a, good: lim.good, manaPer: know.get(a.name)?.manaPerExec ?? 0 });
    }
    pools.sort((x, y) => y.manaPer - x.manaPer);
    for (const p of pools) q.push([p.a.name, p.good]);
    const conv = converterOf(post, know);
    if (conv && pools.length) q.push([conv.name, 1]);
    if (!q.length) return null;
    sess.restore(postSnap);
    sess.setQueue(q);
    sess.restart();
    const r = sess.runLoop();
    return r.degenerate ? null : r.lastTimeNeeded;
}

// Measure a single action in an injected-resource sandbox loop: a large mana
// budget (so nothing starves) plus any canStart-gating resources (so
// converters, purchases and reducers are measurable long before they are
// affordable in play).
const MEASURE_MANA = 25_000;
function measureAction(sess, snap, state, know, a, needs = []) {
    const lim = a.type === "limited" ? state.towns[a.townNum]?.limited[a.varName] : null;
    const bank = lim?.good ?? 0;
    // limited: pure-harvest profile when a bank exists (checks are valued via
    // the ledger ratio in scoring); otherwise a few checks (checks can yield
    // gold too)
    const n = a.type === "limited"
        ? (bank > 0 ? bank : Math.min(Math.max(1, (lim?.total ?? 0) - (lim?.checked ?? 0)), 5))
        : 12;
    const loops = a.allowed != null ? Math.min(a.allowed, n) : n;
    const inject = { mana: MEASURE_MANA };
    for (const res of needs) if (res !== "mana") inject[res] = 1000;
    if ((a.goldCost ?? 0) > 0 && inject.gold === undefined) inject.gold = 1000 + a.goldCost;
    const { r, post } = evalLoop(sess, snap, [[a.name, Math.max(1, loops)]], inject);
    const exec = execCountOf(r, a.name);
    const p = know.get(a.name) ?? emptyProfile();
    p.measuredAtLoop = state.loops;
    p.bankAtMeasure = bank;
    p.exec = exec;
    if (exec > 0) {
        const base = {
            mana: state.baseMana + MEASURE_MANA,
            gold: inject.gold ?? 0,
            rep: inject.reputation ?? 0,
            resources: inject,
            goldCosts: Object.fromEntries(state.actions.filter(x => x.goldCost > 0).map(x => [x.name, x.goldCost])),
        };
        let manaUsed = 0;
        for (const e of r.lastExec ?? []) if (e.name === a.name) manaUsed += e.manaUsed;
        p.ticksPerExec = manaUsed / exec || 1;
        p.manaPerExec = (r.lastTimeNeeded - base.mana) / exec;
        p.goldPerExec = ((r.lastResources?.gold ?? 0) - base.gold) / exec;
        p.repPerExec = ((r.lastResources?.reputation ?? 0) - base.rep) / exec;
        // granted resources beyond the standard trio
        p.grants = {};
        for (const [k, v] of Object.entries(r.lastResources ?? {})) {
            if (["gold", "reputation", "mana"].includes(k)) continue;
            const bv = base.resources?.[k] ?? 0;
            const num = typeof v === "boolean" ? (v ? 1 : 0) : v;
            const bnum = typeof bv === "boolean" ? (bv ? 1 : 0) : bv;
            if (num > bnum) p.grants[k] = (num - bnum) / exec;
        }
        // gold-cost reductions on purchase actions (e.g. Haggle -> Buy
        // Supplies); preserve pair-probe-discovered reductions (they'd be
        // invisible here)
        const pairKept = {};
        for (const [k, v] of Object.entries(p.pairProbed ?? {})) if (v > 0) pairKept[k] = v;
        p.costReductions = { ...pairKept };
        for (const [pname, cost] of Object.entries(r.lastGoldCosts ?? {})) {
            const bcost = base.goldCosts?.[pname];
            if (bcost !== undefined && cost < bcost) p.costReductions[pname] = (bcost - cost) / exec;
        }
        // item discovery: running this action grows some limited var's total
        // pool (e.g. Wander levels -> more pots/locks exist). This is the
        // future bank.
        p.discovers = {};
        const preTown = state.towns[a.townNum], postTown = post.towns[a.townNum];
        if (preTown && postTown) {
            for (const [v, lim2] of Object.entries(postTown.limited)) {
                const d = lim2.total - (preTown.limited[v]?.total ?? 0);
                if (d > 0 && v !== a.varName) p.discovers[v] = d / exec;
            }
        }
        // skill/talent training rates (also feeds vacuous-execution detection)
        let dSkill = 0;
        for (const [sName, sv] of Object.entries(post.skills)) dSkill += (sv.exp ?? 0) - (state.skills[sName]?.exp ?? 0);
        p.skillExpPerExec = dSkill / exec;
        p.talentPerExec = ((post.talentTotal ?? 0) - (state.talentTotal ?? 0)) / exec;
        let dProg = 0;
        if (preTown && postTown) {
            for (const [v, pv] of Object.entries(postTown.progress)) dProg += (pv.exp ?? 0) - (preTown.progress[v]?.exp ?? 0);
        }
        p.progressExpPerExec = dProg / exec;
    }
    know.set(a.name, p);
    return p;
}

// Predictor-model priors (Stage-1 info-boundary relaxation, RULED
// 2026-07-10): the Koviko predictor ships a hand-maintained per-action
// effect model for all 9 towns — a fork feature legitimately reads its own
// game's data. Operationally we run the predictor on a single-action queue
// and record the projected mana/resource deltas as a PRIOR on the profile.
// Empirical measurement stays authoritative for planning; predictor-vs-
// engine divergence is RECORDED (the "third oracle": it flags predictor
// model bugs, engine changes, and — later — AP-randomized data the
// compile-time model can't know about).
async function seedPredictorPrior(sess, snap, know, a) {
    const p = know.get(a.name) ?? emptyProfile();
    if (p.predictorPrior) return;
    sess.restore(snap);
    const pr = await sess.predict([[a.name, 1]]);
    if (pr.ok) {
        p.predictorPrior = {
            totalMana: pr.totalMana ?? null,
            gold: pr.resources?.gold ?? 0,
            reputation: pr.resources?.reputation ?? 0,
            mana: pr.resources?.mana ?? null,
        };
    } else {
        p.predictorPrior = { error: pr.error };
    }
    know.set(a.name, p);
}
function recordDivergence(divergenceLog, state, a, p) {
    const prior = p.predictorPrior;
    if (!prior || prior.error || p.exec <= 0) return;
    // Compare the engine-measured per-exec gold/rep deltas against the
    // predictor's single-exec projection. Coarse tolerance: this is a smoke
    // alarm, not a spec.
    const checks = [
        ["gold", p.goldPerExec, prior.gold],
        ["reputation", p.repPerExec, prior.reputation],
    ];
    for (const [field, measured, predicted] of checks) {
        if (Math.abs((measured ?? 0) - (predicted ?? 0)) > Math.max(1, Math.abs(predicted ?? 0) * 0.5)) {
            divergenceLog.push({
                loop: state.loops, action: a.name, field,
                measured: measured ?? 0, predicted: predicted ?? 0,
            });
            if (divergenceLog.length > 200) divergenceLog.shift();
        }
    }
}

async function refreshKnowledge(sess, snap, state, know, opts = {}) {
    const staleAfter = opts.staleAfter ?? 40;
    const unlocked = state.actions.filter(x => x.visible && x.unlocked && x.travelNum === 0);
    const needsMeasure = unlocked.filter(a => {
        const p = know.get(a.name);
        if (!p) return true;
        if (state.loops - p.measuredAtLoop >= staleAfter) return true;
        if (p.exec === 0 && state.loops - p.measuredAtLoop >= 10) return true;
        // limited actions: harvest yield depends on the bank, so re-measure
        // when the bank materially changed since measurement (esp. 0 -> nonzero)
        if (a.type === "limited") {
            const bank = state.towns[a.townNum]?.limited[a.varName]?.good ?? 0;
            const then = p.bankAtMeasure ?? 0;
            if ((then === 0) !== (bank === 0) || Math.abs(bank - then) >= 3) return true;
        }
        return false;
    });
    if (!needsMeasure.length) return;

    // "vacuous" ignoring talent noise (every exec trains talent a little)
    const isVacuous = (p) => p.exec > 0
        && Math.abs(p.manaPerExec) < 0.01 && Math.abs(p.goldPerExec) < 0.01
        && Math.abs(p.repPerExec) < 0.01 && (p.skillExpPerExec ?? 0) < 0.01
        && (p.progressExpPerExec ?? 0) < 0.01
        && !Object.keys(p.grants).length && !Object.keys(p.discovers ?? {}).length
        && !Object.keys(p.costReductions ?? {}).length;

    for (const a of needsMeasure) {
        sess.restore(snap);
        const needs = sess.needs(a.name);
        if (opts.seedFromPredictor) await seedPredictorPrior(sess, snap, know, a);
        const p = measureAction(sess, snap, state, know, a, needs);
        p.gatedOn = needs;
        // still gated or vacuous: retry with the universal consumable injected
        if (p.exec === 0 || isVacuous(p)) {
            const p2 = measureAction(sess, snap, state, know, a, [...needs, "gold", "reputation"]);
            p2.gatedOn = needs;
        }
        const pf = know.get(a.name);
        // converter detection: consumed gold, produced mana
        if (pf.exec > 0 && pf.manaPerExec > 0 && pf.goldPerExec < 0) {
            pf.manaPerGold = pf.manaPerExec / (-pf.goldPerExec);
        }
        if (opts.seedFromPredictor && opts.divergenceLog) recordDivergence(opts.divergenceLog, state, a, pf);
    }

    // Price-reducer discovery: some purchases (e.g. Buy Supplies) have no
    // goldCost() method, so cost reductions are invisible to the goldCosts
    // capture. Pair-probe suspicious "no-yield consumers" (e.g. Haggle)
    // against measured purchases and compare the purchase's actual gold spend.
    const purchases = unlocked.filter(x => {
        const p = know.get(x.name);
        return p && p.exec > 0 && (p.goldPerExec ?? 0) < -10 && !(p.manaPerGold > 0);
    });
    const suspects = unlocked.filter(x => {
        const p = know.get(x.name);
        if (!p || p.exec === 0) return false;
        return Math.abs(p.manaPerExec) < 0.01 && Math.abs(p.goldPerExec ?? 0) < 0.01
            && (p.skillExpPerExec ?? 0) < 0.01 && (p.progressExpPerExec ?? 0) < 0.01
            && !Object.keys(p.grants).length && !Object.keys(p.discovers ?? {}).length;
    });
    for (const s of suspects) {
        const ps = know.get(s.name);
        ps.pairProbed = ps.pairProbed ?? {};
        for (const g of purchases) {
            if (ps.pairProbed[g.name] !== undefined) continue;
            const baseCost = -know.get(g.name).goldPerExec;
            const k = 8;
            const inject = { mana: MEASURE_MANA, gold: 1000 + baseCost };
            for (const res of ps.gatedOn ?? []) if (res !== "gold" && res !== "mana") inject[res] = 1000;
            const { r } = evalLoop(sess, snap, [[s.name, k], [g.name, 1]], inject);
            const sExec = execCountOf(r, s.name), gExec = execCountOf(r, g.name);
            ps.pairProbed[g.name] = 0;
            if (sExec > 0 && gExec > 0) {
                // net out any gold the suspect itself earns/spends
                const suspectGold = sExec * (know.get(s.name)?.goldPerExec ?? 0);
                const goldSpent = inject.gold + suspectGold - (r.lastResources?.gold ?? 0);
                const red = (baseCost * gExec - goldSpent) / sExec;
                if (red > 0.5) { ps.costReductions[g.name] = red; ps.pairProbed[g.name] = red; }
            }
        }
    }
    sess.restore(snap);
}

// ---------------------------------------------------------------------------
// Candidate generators (all generic: driven by state metadata + measured
// knowledge).
// ---------------------------------------------------------------------------
const MARGIN = 150;

function unlockedOf(state) {
    return state.actions.filter(a => a.visible && a.unlocked);
}
function limitedPools(state, know) {
    // unlocked limited actions with a bank, annotated with measured yields
    const pools = [];
    for (const a of unlockedOf(state)) {
        if (a.type !== "limited") continue;
        const lim = state.towns[a.townNum]?.limited[a.varName];
        if (!lim) continue;
        const p = know.get(a.name);
        if (!p || p.exec === 0) continue;
        pools.push({
            a, name: a.name, good: lim.good, unchecked: lim.total - lim.checked,
            ticks: Math.max(1, p.ticksPerExec), manaPer: p.manaPerExec, goldPer: p.goldPerExec,
            repPer: p.repPerExec,
        });
    }
    return pools;
}
function converterOf(state, know) {
    let best = null;
    for (const a of unlockedOf(state)) {
        const p = know.get(a.name);
        if (p?.manaPerGold > 0 && (!best || p.manaPerGold > best.rate)) {
            best = { name: a.name, rate: p.manaPerGold, ticks: Math.max(1, p.ticksPerExec || 30) };
        }
    }
    return best;
}

// Economy core: harvest mana engines, then harvest gold pools interleaved
// with conversion, keeping `reserveGold`/`reserveRep` unconverted at the
// tail. Returns {q, cushion, tailGold, tailRep} or null if reserve is
// infeasible.
function buildEconomy(state, know, opts = {}) {
    const reserveGold = opts.reserveGold ?? 0;
    const reserveRep = opts.reserveRep ?? 0;
    const cheapPurchases = opts.cheapPurchases ?? false;
    const q = [];
    let cushion = state.baseMana, gold = 0, rep = 0;
    const pools = limitedPools(state, know);

    // 1. mana engines: net-positive mana harvests, full bank, best first
    for (const pool of pools.filter(p => p.good > 0 && p.manaPer > p.ticks).sort((x, y) => (y.manaPer - y.ticks) - (x.manaPer - x.ticks))) {
        q.push([pool.name, pool.good]);
        cushion += pool.good * (pool.manaPer - pool.ticks);
        pool.used = pool.good;
    }

    // cheap lasting-boost purchases (e.g. glasses): inserted as soon as affordable
    const purchases = !cheapPurchases ? [] : unlockedOf(state).filter(a => {
        const p = know.get(a.name);
        return p && p.exec > 0 && a.goldCost > 0 && a.goldCost <= 30 && Object.keys(p.grants).length && !p.manaPerGold;
    });
    const pendingPurchases = [...purchases];

    // 2. gold pools: harvest by gold/mana efficiency, convert when cushion
    //    runs dry — but STOP converting once the remaining (unharvested +
    //    in-hand) gold is down to the requested reserve. The reserve rides
    //    along in the normal interleave instead of a separate re-harvest tail
    //    (which costs thousands of extra ticks). Rep accumulates loop-wide
    //    anyway (converters don't consume it), so rep-yielding pools go first
    //    when rep is needed. With no known converter and no reserve, gold has
    //    no sink (it evaporates at loop end) — skip gold harvesting entirely.
    const convKnown = converterOf(state, know);
    const goldPools = (!convKnown && reserveGold <= 0) ? []
        : pools.filter(p => p.goldPer > 0.5 && !(p.manaPer > p.ticks)).sort((x, y) => y.goldPer / y.ticks - x.goldPer / x.ticks);
    if (reserveRep > 0 || (opts.purchaseInline?.repNeed ?? 0) > 0)
        goldPools.sort((x, y) => (y.repPer > 0.1 ? 1 : 0) - (x.repPer > 0.1 ? 1 : 0));

    // Inline purchase (push mode): the interleave burns gold pools for mana,
    // so to afford a purchase the DENSEST gold-per-tick units are structurally
    // reserved for a dedicated harvest right before the buy. Everything else
    // converts freely (max cushion), the reserved stretch runs unconverted at
    // the end, then the purchase, then a final conversion of any leftover.
    // Only the travel action must be terminal (tail-pinning) — the caller
    // appends it after this queue.
    const inline = opts.purchaseInline ?? null;   // {entries, price, repNeed}
    const reservedList = [];
    if (inline) {
        let need = inline.price;
        for (const pool of [...goldPools].sort((a, b) => a.ticks / a.goldPer - b.ticks / b.goldPer)) {
            if (need <= 0) break;
            const units = Math.min(pool.good, Math.ceil(need / pool.goldPer));
            if (units > 0) { pool.reservedUnits = units; reservedList.push({ pool, units }); need -= units * pool.goldPer; }
        }
        if (need > 0 && !opts.optimisticTail) return null;
    }
    // leave room for the reserved harvest + purchase entries + the caller's
    // tail (travel action) so the loop doesn't starve mid-journey
    const reservedTicks = reservedList.reduce((s, { pool, units }) => s + units * pool.ticks, 0);
    const marginEff = MARGIN + reservedTicks + (opts.extraTailTicks ?? 0);

    const conv = converterOf(state, know);
    const futureGold = () => gold + goldPools.reduce((s, p) => s + (p.good - (p.used ?? 0) - (p.reservedUnits ?? 0)) * p.goldPer, 0);
    let guard = 0;
    while (guard++ < 300) {
        // affordable cheap boost purchase?
        if (pendingPurchases.length && gold >= pendingPurchases[0].goldCost && cushion >= know.get(pendingPurchases[0].name).ticksPerExec + 30) {
            const a = pendingPurchases.shift();
            q.push([a.name, 1]);
            cushion -= know.get(a.name).ticksPerExec;
            gold -= a.goldCost;
            continue;
        }
        let progressed = false;
        for (const pool of goldPools) {
            const left = pool.good - (pool.used ?? 0) - (pool.reservedUnits ?? 0);
            if (left <= 0) continue;
            // plain margin here: conversions REPLENISH the cushion during the
            // interleave, so the tail reservation must not gate the bootstrap
            // — tail feasibility is checked after the interleave completes
            const k = Math.min(left, Math.floor((cushion - MARGIN) / pool.ticks));
            if (k > 0) {
                q.push([pool.name, k]);
                pool.used = (pool.used ?? 0) + k;
                cushion -= k * pool.ticks;
                gold += k * pool.goldPer;
                rep += k * pool.repPer;
                progressed = true;
                break;
            }
        }
        if (progressed) continue;
        // convert freely; hold back only a plain gold reserve if one was requested
        if (conv && gold >= 2 && cushion >= conv.ticks && futureGold() - gold >= reserveGold) {
            q.push([conv.name, 1]);
            cushion += gold * conv.rate - conv.ticks;
            gold = 0;
            continue;
        }
        break;
    }

    let purchased = !inline;
    if (inline) {
        if (cushion < marginEff - MARGIN && !opts.optimisticTail) return null;
        // reserved dense harvest -> purchase -> convert leftovers
        for (const { pool, units } of reservedList) {
            q.push([pool.name, units]);
            cushion -= units * pool.ticks;
            gold += units * pool.goldPer;
            rep += units * pool.repPer;
        }
        if ((gold >= inline.price && rep >= inline.repNeed) || opts.optimisticTail) {
            q.push(...inline.entries);
            gold = Math.max(0, gold - inline.price);
            purchased = true;
        }
        if (conv && gold >= 2) {
            q.push([conv.name, 1]);
            cushion += gold * conv.rate - conv.ticks;
            gold = 0;
        }
    }

    if (!purchased && !opts.optimisticTail) return null;
    if (gold < reserveGold && !opts.optimisticTail) return null;
    if (rep < reserveRep && !opts.optimisticTail) return null;
    return { q, cushion, tailGold: gold, tailRep: rep, purchased };
}

// Investment: spend a share of remaining cushion checking unchecked items,
// weighted by each bank's measured per-item value.
function appendInvest(q, cushion, state, know, share) {
    const pools = limitedPools(state, know).filter(p => p.unchecked > 0);
    if (!pools.length) return cushion;
    const value = (p) => {
        const measured = Math.max(p.manaPer - p.ticks, p.goldPer * (converterOf(state, know)?.rate ?? 50));
        // never-harvested banks have unmeasurable yields: explore optimistically
        const neverHarvested = (know.get(p.name)?.bankAtMeasure ?? 0) === 0;
        return neverHarvested ? Math.max(measured, 100) : Math.max(measured, 1);
    };
    pools.sort((x, y) => value(y) / y.ticks - value(x) / x.ticks);
    let budget = cushion * share;
    for (const pool of pools) {
        // engine semantics: execs consume goodTemp (harvest) BEFORE checking,
        // so add the unharvested bank as an offset or the "checks" are
        // silently harvests of the leftover bank
        const queued = q.filter(([nm]) => nm === pool.name).reduce((s, [, l]) => s + l, 0);
        const offset = Math.max(0, pool.good - queued);
        const nChecks = Math.min(pool.unchecked, Math.floor(budget / pool.ticks) - offset);
        if (nChecks > 0) {
            q.push([pool.name, offset + nChecks]);
            budget -= (offset + nChecks) * pool.ticks;
            cushion -= (offset + nChecks) * pool.ticks;
        }
    }
    return cushion;
}

// Grind: pour a share of the cushion into an action that raises `dim`.
function grindActionFor(state, dim) {
    const cands = unlockedOf(state).filter(a =>
        dim.kind === "p" ? (a.type === "progress" && a.varName === dim.v && a.townNum === dim.town)
                         : a.skillsGained.includes(dim.v));
    cands.sort((x, y) => x.cost - y.cost);
    return cands[0] ?? null;
}

function cheapestProgressBackstop(state) {
    const cands = unlockedOf(state).filter(a => a.type === "progress");
    cands.sort((x, y) => x.cost - y.cost);
    return cands[0] ?? null;
}

// Frontier dims ranked by proximity-weighted demand across locked actions.
function rankFrontierDims(state, thresholds) {
    const dimScore = new Map();
    for (const [name, t] of Object.entries(thresholds)) {
        if (!t.probeable) continue;
        for (const req of t.requires) {
            const frac = reqFraction(state, req);
            if (frac >= 1) continue;
            const key = JSON.stringify({ kind: req.kind, town: req.town ?? null, v: req.v });
            dimScore.set(key, (dimScore.get(key) ?? 0) + 0.2 + frac);
        }
    }
    return [...dimScore.entries()]
        .map(([k, s]) => ({ ...JSON.parse(k), score: s }))
        .sort((x, y) => y.score - x.score);
}

function reqFraction(state, req) {
    if (req.kind === "p") {
        const cur = state.towns[req.town]?.progress[req.v]?.exp ?? 0;
        const needExp = 100 * req.need * (req.need + 1) / 2;
        return needExp > 0 ? Math.min(1, cur / needExp) : 1;
    }
    const cur = state.skills[req.v]?.exp ?? 0;
    const needExp = req.need * (req.need + 1) * 50;
    return needExp > 0 ? Math.min(1, cur / needExp) : 1;
}

// Push candidates: economy with reserve -> price reducers -> resource
// grantors -> travel.
function buildPushes(state, know, sess) {
    const out = [];
    const travels = state.actions.filter(a => a.visible && a.unlocked && a.travelNum > 0 && !state.townsUnlocked.includes(a.travelNum));
    for (const travel of travels) {
        const needs = sess.needs(travel.name).filter(k => k !== "mana");
        // map each needed resource to a measured grantor
        const grantors = [];
        let resolvable = true;
        for (const res of needs) {
            const g = unlockedOf(state)
                .map(a => ({ a, p: know.get(a.name) }))
                .filter(({ p }) => p && p.exec > 0 && (p.grants[res] ?? 0) > 0)
                .sort((x, y) => (x.a.goldCost || 0) - (y.a.goldCost || 0))[0];
            if (!g) { resolvable = false; break; }
            grantors.push(g.a);
        }
        if (needs.length && !resolvable) {
            // grantor unknown: offer exploratory pushes with each unmeasured
            // purchase action
            const candidates = unlockedOf(state).filter(a => a.goldCost > 30 && (know.get(a.name)?.exec ?? 0) === 0);
            for (const p of candidates.slice(0, 2)) {
                const eco = buildEconomy(state, know, { reserveGold: p.goldCost * 1.1 });
                if (eco) out.push({ label: `push-explore:${travel.name}:${p.name}`, q: [...eco.q, [p.name, 1], [travel.name, 1]] });
            }
            continue;
        }
        // grantor gold cost: prefer the measured spend (some purchases, e.g.
        // Buy Supplies, have no goldCost() method — the price lives in
        // canStart/finish)
        const costOf = (g) => Math.max(g.goldCost || 0, -(know.get(g.name)?.goldPerExec ?? 0));
        const totalCost = grantors.reduce((s, g) => s + costOf(g), 0);
        // price reducers measured against any grantor
        const reducers = unlockedOf(state)
            .map(a => ({ a, p: know.get(a.name) }))
            .filter(({ a, p }) => p && grantors.some(g => (p.costReductions[g.name] ?? 0) > 0));
        // reducer count capped by what the rep-yielding banks can actually
        // fund (each Haggle-like exec consumes rep; rep comes from harvesting
        // e.g. LQs)
        const repCapacity = limitedPools(state, know)
            .filter(p => p.repPer > 0.1 && p.good > 0)
            .reduce((s, p) => s + Math.floor(p.good * p.repPer), 0);
        const hVariants = new Set([0]);
        for (const { a, p } of reducers) {
            const red = Math.max(...grantors.map(g => p.costReductions[g.name] ?? 0));
            const repPerUse = Math.max(0.01, -(p.repPerExec ?? -1));
            const hMax = Math.min(15, Math.ceil(totalCost / red), Math.floor(repCapacity / repPerUse));
            if (hMax >= 1) { hVariants.add(Math.max(1, Math.floor(hMax / 2))); hVariants.add(hMax); }
        }
        for (const h of hVariants) {
            let price = totalCost, repNeed = 0;
            const reducerEntries = [];
            if (h > 0 && reducers.length) {
                const { a, p } = reducers[0];
                const red = Math.max(...grantors.map(g => p.costReductions[g.name] ?? 0));
                price = Math.max(0, totalCost - h * red);
                repNeed = h * Math.max(0, -p.repPerExec);
                reducerEntries.push([a.name, h]);
            }
            const entries = [...reducerEntries, ...grantors.map(g => [g.name, 1])];
            const entryTicks = entries.reduce((s, [n, l]) => s + l * (know.get(n)?.ticksPerExec || 150), 0);
            const eco = buildEconomy(state, know, {
                purchaseInline: { entries, price, repNeed },
                extraTailTicks: entryTicks + travel.cost + 300,
                optimisticTail: true,
            });
            if (!eco) continue;
            out.push({ label: `push:${travel.name}:h${h}`, q: [...eco.q, [travel.name, 1]] });
        }
    }
    return out;
}

function generateCandidates(state, know, thresholds, sess, lastCommitted) {
    const cands = [];
    const add = (label, q) => { if (q && q.length) cands.push({ label, q }); };

    // only dims we can actually grind right now (an unlocked action raises them)
    const dims = rankFrontierDims(state, thresholds).filter(d => grindActionFor(state, d));
    const backstop = cheapestProgressBackstop(state);

    // grind candidates along the top frontier dims
    for (const [di, dim] of dims.slice(0, 4).entries()) {
        const target = grindActionFor(state, dim);
        if (!target) continue;
        for (const share of di < 2 ? [0.5, 1.0] : [1.0]) {
            const eco = buildEconomy(state, know, { cheapPurchases: true });
            if (!eco) continue;
            const q = [...eco.q];
            let cushion = eco.cushion;
            const n = Math.floor(cushion * share / target.cost);
            if (n < 1) continue;   // don't queue entries the cushion can't cover
            q.push([target.name, Math.min(n, target.allowed ?? n)]);
            cushion -= n * target.cost;
            appendInvest(q, Math.max(0, cushion), state, know, 0.9);
            if (backstop) q.push([backstop.name, 99]);
            add(`grind:${dim.v}:${share}`, q);
        }
    }
    // split grind across the top two dims
    if (dims.length >= 2) {
        const t1 = grindActionFor(state, dims[0]), t2 = grindActionFor(state, dims[1]);
        if (t1 && t2) {
            const eco = buildEconomy(state, know, { cheapPurchases: true });
            if (eco) {
                const q = [...eco.q];
                let cushion = eco.cushion;
                const n1 = Math.max(1, Math.floor(cushion * 0.4 / t1.cost));
                const n2 = Math.max(1, Math.floor(cushion * 0.4 / t2.cost));
                q.push([t1.name, n1], [t2.name, n2]);
                cushion -= n1 * t1.cost + n2 * t2.cost;
                appendInvest(q, Math.max(0, cushion), state, know, 0.9);
                if (backstop) q.push([backstop.name, 99]);
                add(`grind2:${dims[0].v}+${dims[1].v}`, q);
            }
        }
    }
    // investment-heavy candidates
    for (const share of [0.6, 1.0]) {
        const eco = buildEconomy(state, know, { cheapPurchases: true });
        if (eco) {
            const q = [...eco.q];
            appendInvest(q, eco.cushion, state, know, share);
            if (backstop) q.push([backstop.name, 99]);
            add(`invest:${share}`, q);
        }
    }
    // discovery grind: actions measured to grow limited-item pools (future banks)
    {
        const discoverers = unlockedOf(state)
            .map(a => ({ a, p: know.get(a.name) }))
            .filter(({ p }) => p && p.exec > 0 && Object.values(p.discovers ?? {}).some(x => x > 0))
            .sort((x, y) => {
                const rate = ({ a, p }) => Object.values(p.discovers).reduce((s, d) => s + d, 0) / Math.max(1, p.ticksPerExec);
                return rate(y) - rate(x);
            });
        for (const { a } of discoverers.slice(0, 2)) {
            const eco = buildEconomy(state, know, { cheapPurchases: true });
            if (!eco) continue;
            const q = [...eco.q];
            let cushion = eco.cushion;
            const n = Math.floor(cushion * 0.7 / Math.max(1, a.cost));
            if (n < 1) continue;
            q.push([a.name, Math.min(n, a.allowed ?? n)]);
            cushion -= n * a.cost;
            appendInvest(q, Math.max(0, cushion), state, know, 0.9);
            if (backstop) q.push([backstop.name, 99]);
            add(`discover:${a.name}`, q);
        }
    }
    // pure backstop grind (early game: no banks, no knowledge)
    if (backstop) add(`bare:${backstop.name}`, [[backstop.name, 99]]);

    // repeat last committed queue
    if (lastCommitted) add("repeat", lastCommitted);

    // travel pushes
    for (const p of buildPushes(state, know, sess)) add(p.label, p.q);

    // dedupe by queue content
    const seen = new Set();
    return cands.filter(c => {
        const k = JSON.stringify(c.q);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

// ---------------------------------------------------------------------------
// Objective scoring (engine ground truth): pre vs post persistent state.
// ---------------------------------------------------------------------------
function scoreOutcome(pre, post, thresholds, r, prevCapacity, know, W, capacity) {
    let s = 0;
    const parts = {};
    parts.town = W.town * (post.townsUnlocked.length - pre.townsUnlocked.length);

    const preAvail = new Map(pre.actions.map(a => [a.name, a.visible ? (a.unlocked ? 2 : 1) : 0]));
    let newUnlocked = 0, newVisible = 0;
    for (const a of post.actions) {
        const before = preAvail.get(a.name) ?? 0;
        const now = a.visible ? (a.unlocked ? 2 : 1) : 0;
        if (now >= 2 && before < 2) newUnlocked++;
        else if (now >= 1 && before < 1) newVisible++;
    }
    parts.unlocks = W.unlockAction * newUnlocked + W.visibleAction * newVisible;

    let frontier = 0;
    for (const [, t] of Object.entries(thresholds)) {
        if (!t.probeable) continue;
        for (const req of t.requires) frontier += (reqFraction(post, req) - reqFraction(pre, req)) / Math.max(1, t.requires.length);
    }
    parts.frontier = W.frontier * frontier;

    parts.mana = W.mana * Math.log(Math.max(capacity, pre.baseMana) / Math.max(1, prevCapacity));

    const valueOfVar = (v) => {
        // per-item mana-equivalent value from knowledge (best of mana or
        // gold*converter); never-harvested banks get an optimistic
        // exploration value
        for (const [name, p] of know) {
            const proto = post.actions.find(x => x.name === name);
            if (proto?.varName === v && proto.type === "limited" && p.exec > 0) {
                const measured = Math.max(p.manaPerExec ?? 0, (p.goldPerExec ?? 0) * 50);
                return (p.bankAtMeasure ?? 0) === 0 ? Math.max(measured, 100) : Math.max(measured, 50);
            }
        }
        return 100;
    };
    let bank = 0;
    for (const town of post.towns) {
        const preTown = pre.towns[town.index];
        for (const [v, lim] of Object.entries(town.limited)) {
            const dGood = lim.good - (preTown?.limited[v]?.good ?? 0);
            if (dGood) bank += dGood * valueOfVar(v);
            // checking has deterministic expected bank value: every ~Nth check
            // banks a good item (ratio measurable from the ledger itself)
            const dChecked = lim.checked - (preTown?.limited[v]?.checked ?? 0);
            if (dChecked > 0) {
                const ratio = lim.checked > 10 ? lim.good / lim.checked : 0.1;
                bank += dChecked * ratio * valueOfVar(v);
            }
        }
    }
    // Pool discovery: use EXPECTED discovery (measured per-exec rates × execs)
    // — realized Δtotal only spikes on level-up loops, which makes the
    // discovery grind lose ties on every non-spike loop and crawl. Saturated
    // pools measure a 0 rate on refresh, so the expectation self-corrects.
    let bankPot = 0;
    for (const e of r.lastExec ?? []) {
        const execs = e.loops - e.loopsLeft;
        if (execs <= 0) continue;
        const p = know.get(e.name);
        if (!p?.discovers) continue;
        for (const [v, rate] of Object.entries(p.discovers)) {
            if (rate > 0) bankPot += execs * rate * valueOfVar(v);
        }
    }
    parts.bank = W.bank * bank / 10;
    parts.bankPot = W.bankPot * bankPot / 100;

    parts.talent = W.talent * ((post.talentTotal ?? 0) - (pre.talentTotal ?? 0));

    for (const v of Object.values(parts)) s += v;
    return { score: s, parts };
}

// ---------------------------------------------------------------------------
// Predictor screen: rank candidates cheaply; keep top K for engine
// confirmation.
// ---------------------------------------------------------------------------
async function screenCandidates(sess, snap, cands, K) {
    sess.restore(snap);
    const scored = [];
    for (const c of cands) {
        let s = 0, ok = true;
        try {
            const p = await sess.predict(c.q);
            if (p.ok) {
                // productive-mana proxy: mana spent within budget
                const overdraft = Math.max(0, -(p.resources?.mana ?? 0));
                s = (p.totalMana ?? 0) - overdraft;
                c.pred = { totalMana: p.totalMana, isValid: p.isValid };
            } else ok = false;
        } catch { ok = false; }
        scored.push({ ...c, screen: ok ? s : -1 });
    }
    scored.sort((x, y) => y.screen - x.screen);
    // always keep pushes and repeat (cheap insurance against predictor model gaps)
    const keep = new Set(scored.slice(0, K).map(c => c.label));
    for (const c of scored) if (c.label.startsWith("push") || c.label === "repeat") keep.add(c.label);
    return scored.filter(c => keep.has(c.label));
}

// ---------------------------------------------------------------------------
// One planning round: from the CURRENT sim state, produce the best queue for
// the next loop. `P` is the persistent planning state (knowledge, thresholds,
// last committed queue, ...) owned by the caller (worker or standalone run).
// ---------------------------------------------------------------------------
async function planRound(sess, P) {
    P.loop = (P.loop ?? 0) + 1;
    const pre = P.pre ?? sess.read();
    if (P.prevTimeNeeded == null) P.prevTimeNeeded = pre.baseMana;
    const snap = sess.save();
    if ((P.loop - 1) % (P.probeEvery ?? 1) === 0) P.thresholds = sess.probe();
    await refreshKnowledge(sess, snap, pre, P.know, {
        seedFromPredictor: P.seedFromPredictor, divergenceLog: P.divergenceLog,
    });
    sess.restore(snap);

    const cands = generateCandidates(pre, P.know, P.thresholds, sess, P.lastCommitted);
    if (!cands.length) throw new Error(`loop ${P.loop}: no candidates`);
    sess.restore(snap);
    const screened = await screenCandidates(sess, snap, cands, P.screenK ?? 8);

    let best = null;
    const evals = [];
    for (const c of screened) {
        const { r, post } = evalLoop(sess, snap, c.q);
        if (r.degenerate) { evals.push({ label: c.label, score: null }); continue; }
        const postSnap = sess.save();
        const capacity = probeCapacity(sess, postSnap, post, P.know) ?? Math.max(post.baseMana, r.lastTimeNeeded);
        const { score, parts } = scoreOutcome(pre, post, P.thresholds, r, P.prevTimeNeeded, P.know, P.weights, capacity);
        evals.push({ label: c.label, score: Math.round(score * 10) / 10, capacity });
        const rec = { c, r, post, score, parts, postSnap, capacity };
        if (!best || score > best.score) best = rec;
    }
    if (!best) throw new Error(`loop ${P.loop}: all candidates degenerate`);
    // restore the pre-round state; the CALLER decides how to commit (the
    // standalone driver restores best.postSnap; the live game plays the queue)
    sess.restore(snap);
    return { best, snap, pre, nCands: cands.length, nScreened: screened.length, evals };
}

function newPlanningState(opts = {}) {
    return {
        know: new Map(),
        lastCommitted: null,
        prevTimeNeeded: null,
        thresholds: {},
        pre: null,
        loop: 0,
        weights: opts.weights ?? { ...DEFAULT_WEIGHTS },
        screenK: opts.screenK ?? 8,
        probeEvery: opts.probeEvery ?? 1,
        seedFromPredictor: opts.seedFromPredictor ?? false,
        divergenceLog: [],
    };
}

// ---------------------------------------------------------------------------
// Standalone driver: plays the whole game headlessly (stats harness / tests).
// Same commit semantics as the v0 experiments harness (restore the winner's
// post-loop snapshot) so results are directly comparable.
// ---------------------------------------------------------------------------
async function runStandalone({ maxLoops = 1200, weights, screenK = 8, probeEvery = 1,
                               seedFromPredictor = false, targetTown = 1, verbose = false,
                               onLoop = null } = {}) {
    const t0 = Date.now();
    const sess = new Session();
    const P = newPlanningState({ weights, screenK, probeEvery, seedFromPredictor });
    const trace = [];
    const milestones = {};
    let cumTicks = 0;
    P.pre = sess.read();

    while (P.loop < maxLoops) {
        const { best, pre } = await planRound(sess, P);

        // commit the winner
        sess.restore(best.postSnap);
        cumTicks += best.r.ticks;
        P.prevTimeNeeded = best.capacity;
        P.lastCommitted = best.c.q;

        // milestones: newly unlocked/visible actions + towns
        const preAvail = new Map(pre.actions.map(a => [a.name, a.visible ? (a.unlocked ? 2 : 1) : 0]));
        for (const a of best.post.actions) {
            const before = preAvail.get(a.name) ?? 0;
            const now = a.visible ? (a.unlocked ? 2 : 1) : 0;
            if (now > before) {
                const key = `${a.name}:${now === 2 ? "unlocked" : "visible"}`;
                if (!(key in milestones)) milestones[key] = { loop: P.loop, cumTicks };
            }
        }
        for (const t of best.post.townsUnlocked) {
            if (!pre.townsUnlocked.includes(t)) milestones[`town${t}`] = { loop: P.loop, cumTicks };
        }

        trace.push({
            loop: P.loop, ticks: best.r.ticks, cumTicks,
            label: best.c.label, score: Math.round(best.score),
            parts: Object.fromEntries(Object.entries(best.parts).map(([k, v]) => [k, Math.round(v * 10) / 10])),
            mana: best.r.lastTimeNeeded,
            nCands: best.nCands, nScreened: best.nScreened,
            queue: best.c.q.map(([n, l]) => `${n} x${l}`).join(", "),
        });
        if (verbose && (P.loop % 25 === 0 || P.loop <= 3 || best.post.townsUnlocked.length > pre.townsUnlocked.length))
            console.log(`  L${String(P.loop).padStart(4)} [${best.c.label}] ticks=${best.r.ticks} mana=${best.r.lastTimeNeeded} score=${Math.round(best.score)}`);
        if (onLoop) onLoop(trace[trace.length - 1]);

        P.pre = best.post;
        if (P.pre.townsUnlocked.includes(targetTown)) break;
    }

    return {
        weights: P.weights, loopsRun: trace.length, cumTicks,
        finished: P.pre.townsUnlocked.includes(targetTown),
        milestones, trace,
        divergences: P.divergenceLog,
        finalSnapshot: plSnapshot(),
        wallSeconds: (Date.now() - t0) / 1000,
    };
}

return {
    DEFAULT_WEIGHTS, MEASURE_MANA,
    Session, newPlanningState, planRound, runStandalone,
    setRngHooks,
    // exposed for tests and the automation controller
    emptyProfile, measureAction, refreshKnowledge, generateCandidates,
    buildEconomy, limitedPools, rankFrontierDims, grindActionFor,
    scoreOutcome, probeCapacity, screenCandidates,
    _internals: { plReadState, plProbeThresholds, plProbeCanStartNeeds, plSaveClone,
                  plRestoreSave, plRunOneLoopChunk, plInjectResources, plSnapshot,
                  plSetQueue, plGetQueue, plPredictQueue },
};
})();
