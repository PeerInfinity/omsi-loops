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
// (originally 500 loops / 5,432,753 ticks to Forest Path vs the 646-loop
// scripted baseline, deterministic; Part A §11.9 later re-baselined this
// reference to 535 / 5,965,890 / e23f020400162f9a — see AUTOMATION.md §8).
// The algorithm is transliterated, not rewritten;
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
    // §11.5 scoring-horizon terms — both ONLY computed when the PRE state has
    // more than one town unlocked (byte-inert at townsUnlocked=[0], where the
    // planner must reproduce v0 exactly). Both are in mana units, the same
    // scale the Round-6 wall arithmetic used (price 18.6k vs headroom 10.8k):
    travelRelief: 3,   // permanent cheapening of routes to other towns (Old Shortcut -> Continue On); valued per mana like banked items (W.bank/10)
    headroom: 1,       // growth of disposable per-loop mana (capacity minus the capacity probe's pump ticks) vs the last committed loop
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
        const progress = {}, limited = {}, mult = {};
        for (const a of town.totalActionList) {
            if (a.type === "progress") progress[a.varName] = {
                exp: town["exp" + a.varName] ?? 0, level: town.getLevel(a.varName),
            };
            else if (a.type === "limited") limited[a.varName] = {
                good: town["good" + a.varName] ?? 0,
                checked: town["checked" + a.varName] ?? 0,
                total: town["total" + a.varName] ?? 0,
            };
            // multipart persistent ledgers (census 2.2d) — town["total<var>"]
            else if (a.type === "multipart") mult[a.varName] = town["total" + a.varName] ?? 0;
        }
        townsOut.push({ index: town.index, progress, limited, mult, suppliesCost: town.suppliesCost });
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
                // travel DESTINATIONS (getPossibleTravel returns deltas; Face
                // Judgement returns two — its destination is reputation-
                // dependent). travelNum stays for compatibility (the
                // measurement filter keys on it); graph code uses travelDests.
                travelDests: getPossibleTravel(a.name).map(d => d + a.townNum),
                visible, unlocked, allowed, goldCost,
                cost: plAdjCost(a.name),
                skillsGained: a.skills ? Object.keys(a.skills) : [],
                statsUsed: a.stats ? Object.keys(a.stats) : [],
                // structural gate the resource prober can't express (§11.8
                // piece 2); static metadata, consumed by nothing at default
                // vocabulary — feeds informed measurement + §11.10 traversal
                gate: gateFor(a.name),
            });
        }
    }
    // ---- persistent-state channels the vocabulary cannot see (census 2.2) ----
    // All additive + JSON-plain; consumed by nothing at default weights (the
    // byte-gate proves inertness). Observability before scoring.
    const buffsOut = {};
    for (const b of buffList) buffsOut[b] = buffs[b]?.amt ?? 0;
    const ssPerStat = {}; let ssTotal = 0;
    for (const s of statList) { const v = stats[s]?.soulstone ?? 0; ssPerStat[s] = v; ssTotal += v; }
    // dungeon/trial progression (compact — scoring only ever needs deltas):
    // per floor {completed, ssChance}; per trial {highestFloor, completedTotal}.
    const dungeonsOut = dungeons.map(d => d.map(f => ({ completed: f.completed ?? 0, ssChance: f.ssChance ?? 0 })));
    const trialsOut = trials.map(t => {
        let completedTotal = 0;
        for (let j = 0; j < t.length; j++) completedTotal += t[j]?.completed ?? 0;
        return { highestFloor: t.highestFloor ?? 0, completedTotal };
    });
    return JSON.stringify({
        loops: totals.loops, townsUnlocked: townsUnlocked.slice(),
        skills: skillsOut, towns: townsOut, actions: actionsOut,
        talentTotal: totalTalent,
        baseMana: timeNeededInitial,
        // persistent channels (census 2.2) — additive, byte-inert at defaults
        buffs: buffsOut,
        soulstones: { perStat: ssPerStat, total: ssTotal },
        goldInvested, trainingLimits, effectiveTime,
        stonesUsed: { ...stonesUsed },
        dungeons: dungeonsOut, trials: trialsOut,
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
    // deterministic-RNG cursors ride the snapshot so rolled-back cycle-mode
    // probes roll them back too (actionList.js §rngMode). Missing / random-mode
    // saves reset to zero — inert unless rngMode is "cycle".
    if (toLoad.rngCycle) rngCycleState = toLoad.rngCycle; else resetRngCycle();

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

// ---- gate metadata (informed vocabulary; §11.8 piece 2) -------------------
// Declarative per-action gates the resource prober cannot express, defined in
// planner-metadata.js (loaded before this file; typeof-guarded so an unloaded
// table degrades to "no gates"). See ACTION-CENSUS.md §2.4.
function plMetadata() {
    return (typeof PLANNER_METADATA !== "undefined") ? PLANNER_METADATA : { gates: {} };
}
function gateFor(name) {
    return plMetadata().gates?.[name] ?? null;
}
// Layer M accessors (vocabulary plan §2): the effect-edge table (keyed by
// DIMENSION skill:X/buff:X) and per-action context flags. Consumed by the
// informed-mode edge prober (probeEdges) and the coverage report; nothing at
// default vocabulary reads them.
function dimEffectsFor(dim) {
    return plMetadata().dimEffects?.[dim] ?? null;
}
function contextFor(name) {
    return plMetadata().context?.[name] ?? null;
}
// Satisfy the non-resource gates the resource prober can't (informed mode).
// Called AFTER plInjectResources inside the probe loop, so it overrides any
// injected/prefix reputation. v1 handles guild membership and reputation upper
// bounds — both pure state the probe can set without simulating a multi-rank
// guild join. The other declared gates (soulstoneSac / talentFloor /
// buffFloor / combat-trial power bounds / timeMax) are left for §11.10 setup
// chains; an action carrying only those still measures exec=0.
function plApplyGate(g) {
    if (!g) return;
    if (g.guild !== undefined) guild = g.guild;
    if (g.repMax !== undefined) resources.reputation = g.repMax;
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

// ---- §11.7 Design B: boundary-state hash (live no-pause pipelining) --------
// Deterministic 64-bit FNV-1a over a string -> 16 hex chars. No crypto
// dependency, so it runs identically on the browser main thread, the planning
// Worker, and Node — which the stale-plan guard requires (both sides must
// agree bit-for-bit on the digest of the same state).
function fnv1a64(str) {
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n, mask = 0xffffffffffffffffn;
    for (let i = 0; i < str.length; i++) {
        h = ((h ^ BigInt(str.charCodeAt(i))) * prime) & mask;
    }
    return h.toString(16).padStart(16, "0");
}

// A digest of the PERSISTENT, restart-invariant state that defines the next
// loop's planning problem: everything plReadState reports EXCEPT the per-loop
// volatile fields (the derived actions[] closures — allowed()/goldCost() read
// live gold — and each town's suppliesCost, both reset by restart()). Two
// identical boundary states therefore hash equal whether the read is taken on
// the live game after a loop or in the worker's simulate-ahead. Used to reject
// a pipelined plan whose predicted boundary no longer matches the live state
// (manual edit, option flip, or reward-path RNG divergence).
function boundaryHash(readStateJSON) {
    const s = JSON.parse(readStateJSON ?? plReadState());
    delete s.actions;
    // effectiveTime is a cumulative timer, NOT a planning gate: live play banks
    // it from real-time Bonus Seconds while the headless worker advances it by
    // ticks, so it diverges live-vs-worker even when every loop outcome is
    // identical (Bonus Seconds changes real-time speed, not per-loop results).
    // Including it would make the stale-plan guard miss on every install.
    delete s.effectiveTime;
    for (const t of s.towns ?? []) delete t.suppliesCost;
    return fnv1a64(JSON.stringify(s));
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
function evalLoop(sess, snap, queue, inject = null, gate = null) {
    sess.restore(snap);
    sess.setQueue(queue);
    sess.restart();
    if (inject) plInjectResources(JSON.stringify(inject));
    if (gate) plApplyGate(gate);   // informed vocab only; null for every existing caller
    const r = sess.runLoop();
    const post = sess.read();
    return { r, post };
}

function execCountOf(r, name) {
    let n = 0;
    for (const e of r.lastExec ?? []) if (e.name === name) n += e.loops - e.loopsLeft;
    return n;
}

// One candidate's engine confirmation: run its loop from `snap`, then the
// capacity probe from the post-loop state. This bundles everything
// SIM-TOUCHING for one candidate so an external eval pool (setEvalPool) can
// run candidates in parallel sim contexts; scoring stays with the caller
// (pure arithmetic on the returned states — scoreOutcome never touches the
// sim: routeTo runs sess-less there). JSON-safe in and out: `snap` and
// `know` may arrive structured-cloned from another thread.
function confirmCandidate(sess, snap, q, know, multiTown) {
    const { r, post } = evalLoop(sess, snap, q);
    if (r.degenerate) return { degenerate: true };
    const postSnap = sess.save();
    const capOut = {};
    const capacity = probeCapacity(sess, postSnap, post, know, multiTown, capOut)
        ?? Math.max(post.baseMana, r.lastTimeNeeded);
    return { degenerate: false, r, post, postSnap, capacity, probeTicks: capOut.ticks ?? null };
}

// External eval pool: async (jobs) => results, ORDER-PRESERVING. Two job
// kinds, dispatched by `kind`:
//   {kind:"confirm", save, rng, q, know (Map entries array), multiTown}
//     -> confirmCandidate's return shape (worker recreates the Map and
//        calls confirmCandidate in its own context)
//   {kind:"screen", save, rng, q}
//     -> plPredictQueue's parsed shape ({ok, totalMana, isValid,
//        resources}); the worker restores the snapshot then predicts.
// Default null = in-context serial path — the byte-exact reference.
// Injected by harnesses only; nothing in the browser/worker automation
// sets it. Profiling note: the predictor screen is ~80% of round wall
// time early-game, confirms ~14% — pool BOTH or the speedup is Amdahl'd
// away.
let plEvalPool = null;
function setEvalPool(fn) { plEvalPool = fn; }

// Next-loop capacity probe: from a candidate's post-loop snapshot, run one
// harvest-everything (+ convert) loop and return its realized mana capacity.
// This is what makes investment (checking items -> banked goods) visible to
// the otherwise one-loop-greedy objective: banked pots/quests only pay off in
// the NEXT loop's budget.
// Multi-town: the harvest walk visits banked towns in route order (town 0
// first — loops are forward-only), harvesting by manaPer within each town,
// buying the next hop's needs BEFORE the town's own spend-all converter
// runs, and skipping towns whose banked value is below the hop cost. With
// banks only in town 0 this reduces to the v0 queue exactly. Injects
// NOTHING: capacity probes model real next-loop play.
// `out` (optional): out.ticks = the pump's cost — mana consumed by the probe
// queue's ACTIONS (sum of lastExec manaUsed), so (capacity - out.ticks) is
// the loop's disposable headroom. NOT the chunk driver's `spent`: a completed
// loop always consumes its whole budget (idle ticks included), so spent ==
// lastTimeNeeded identically and the difference would be 0 by construction.
// Purely an extra readout; no numeric path changes.
function probeCapacity(sess, postSnap, post, know, multiTown = true, out = {}) {
    const pumpCost = (r) => (r.lastExec ?? []).reduce((s, e) => s + (e.manaUsed ?? 0), 0);
    const byTown = new Map();
    for (const a of post.actions) {
        if (!(a.visible && a.unlocked) || a.type !== "limited") continue;
        const lim = post.towns[a.townNum]?.limited[a.varName];
        if (lim?.good > 0) {
            if (!byTown.has(a.townNum)) byTown.set(a.townNum, []);
            byTown.get(a.townNum).push({ a, good: lim.good, manaPer: know.get(a.name)?.manaPerExec ?? 0 });
        }
    }
    const q = [];
    if (!multiTown) {
        // v0 path: one global harvest list + the single best converter
        const pools = [...byTown.values()].flat();
        pools.sort((x, y) => y.manaPer - x.manaPer);
        for (const p of pools) q.push([p.a.name, p.good]);
        const conv = converterOf(post, know);
        if (conv && pools.length) q.push([conv.name, 1]);
        if (!q.length) return null;
        sess.restore(postSnap);
        sess.setQueue(q);
        sess.restart();
        const r = sess.runLoop();
        if (!r.degenerate) out.ticks = pumpCost(r);
        return r.degenerate ? null : r.lastTimeNeeded;
    }
    // a town's spend-all converter is DEFERRED until the next journey's
    // grantors (Buy Supplies etc.) have bought from the wallet, then flushed
    // before the hop; with no further journey it flushes at the end
    let cur = 0, pendingConv = null;
    for (const t of [...byTown.keys()].sort((x, y) => x - y)) {
        const pools = byTown.get(t);
        pools.sort((x, y) => y.manaPer - x.manaPer);
        if (t !== cur) {
            const route = routeTo(post, sess, t, cur);
            if (!route) continue;
            const banked = pools.reduce((s, p) => s + p.good * Math.max(0, p.manaPer), 0);
            if (banked < route.ticksEst) continue;   // not worth the journey
            const resolved = resolveRouteGrantors(post, know, sess, route.hops, null,
                { startTown: cur, allowCostedAnywhere: true });
            if (!resolved) continue;
            for (const g of resolved.inline) q.push([g.name, 1]);
            if (pendingConv) { q.push([pendingConv.name, 1]); pendingConv = null; }
            q.push(...routeTailEntries(route.hops, resolved.segGrantors));
            cur = t;
        }
        // ALL states harvest gold pools in cushion-sized CHUNKS with
        // conversion between (the committed queues' interleave): an
        // end-loaded spend-all converter starves once banks outgrow the base
        // budget — the probe loop dies mid-harvest with its gold unconverted,
        // understating capacity and reading headroom == 0 by construction
        // (found at 10x L140: probe 5,250 vs realized 21,250). Part A (§11.9)
        // un-gated this at townsUnlocked=[0] too: the town-0 probe was
        // reporting prevTimeNeeded 5,250 while committed loops realize
        // 27k-35k — a ~7x understated capacityHint that mis-sized every
        // economy/push candidate. (The Round-7 `a39bc27` fix deliberately
        // left the [0] path on v0 to preserve the byte-reference; Part A
        // finishes it with the deliberate re-freeze.) The final chunk is
        // deliberately NOT converted: its gold funds the next journey's
        // grantors, and pendingConv flushes it after them (or at the end)
        // exactly as before. The modeled cushion only shapes the queue — the
        // probe run realizes real values.
        const interleave = true;
        const convT = converterOf(post, know, t);
        if (!interleave || !convT) {
            for (const p of pools) q.push([p.a.name, p.good]);
        } else {
            let cushion = post.baseMana;
            for (const p of pools) {
                const kp = know.get(p.a.name);
                const ticks = Math.max(1, kp?.ticksPerExec || 30);
                if (p.manaPer > ticks) {   // self-funding mana engine: whole bank
                    q.push([p.a.name, p.good]);
                    cushion += p.good * (p.manaPer - ticks);
                    continue;
                }
                const goldPer = Math.max(0, kp?.goldPerExec ?? 0);
                let left = p.good;
                while (left > 0) {
                    const fit = Math.max(1, Math.floor((cushion - MARGIN) / ticks));
                    const n = Math.min(left, fit);
                    q.push([p.a.name, n]);
                    left -= n;
                    cushion -= n * ticks;
                    if (left > 0) {
                        q.push([convT.name, 1]);
                        cushion += n * goldPer * convT.rate - convT.ticks;
                    }
                }
            }
        }
        if (convT && pools.length) pendingConv = convT;
    }
    if (pendingConv) q.push([pendingConv.name, 1]);
    if (!q.length) return null;
    sess.restore(postSnap);
    sess.setQueue(q);
    sess.restart();
    const r = sess.runLoop();
    if (!r.degenerate) out.ticks = pumpCost(r);
    return r.degenerate ? null : r.lastTimeNeeded;
}

// Measure a single action in an injected-resource sandbox loop: a large mana
// budget (so nothing starves) plus any canStart-gating resources (so
// converters, purchases and reducers are measurable long before they are
// affordable in play).
//
// Multi-town: every loop starts at town 0, so an out-of-town action is
// unreachable from loop start (the Round-5 wall: town-1 actions measured
// exec=0 forever). Town-N probes get the committed-play route as a queue
// PREFIX and are differenced against a prefix-only BASELINE run under
// identical injections — the subtraction isolates the action's own deltas
// from the prefix's side effects (travel mana cost, hop effects, story
// flags) and makes profiles route-independent by construction. Town-0
// actions take the v0 path verbatim (no route call, no baseline loop).
const MEASURE_MANA = 25_000;
function measureAction(sess, snap, state, know, a, needs = [], opts = {}) {
    const baselineCache = opts.baselineCache ?? null;
    const multiTown = opts.multiTown ?? true;
    const lim = a.type === "limited" ? state.towns[a.townNum]?.limited[a.varName] : null;
    const bank = lim?.good ?? 0;
    // limited: pure-harvest profile when a bank exists (checks are valued via
    // the ledger ratio in scoring); otherwise a few checks (checks can yield
    // gold too)
    const n = a.type === "limited"
        ? (bank > 0 ? bank : Math.min(Math.max(1, (lim?.total ?? 0) - (lim?.checked ?? 0)), 5))
        : 12;
    const loops = a.allowed != null ? Math.min(a.allowed, n) : n;
    // informed vocabulary: satisfy the action's structural gate (guild
    // membership / reputation upper bound) so it becomes measurable — the
    // census 2.4 class that measures exec=0 from a resource-only probe. gate
    // is applied inside evalLoop (after injection) to both baseline and full
    // runs, so the prefix-baseline subtraction stays consistent.
    const gate = opts.vocabulary === "informed" ? gateFor(a.name) : null;
    const inject = { mana: MEASURE_MANA };
    for (const res of needs) {
        if (res === "mana") continue;
        // a repMax gate means reputation must stay <= bound; injecting it
        // would re-block the action (positive injection defeats the clamp)
        if (gate?.repMax !== undefined && res === "reputation") continue;
        inject[res] = 1000;
    }
    if ((a.goldCost ?? 0) > 0 && inject.gold === undefined) inject.gold = 1000 + a.goldCost;

    const p = know.get(a.name) ?? emptyProfile();
    p.measuredAtLoop = state.loops;
    p.bankAtMeasure = bank;
    p.townNum = a.townNum;

    let route = null;
    if (a.townNum !== 0 && multiTown) {
        route = routeTo(state, sess, a.townNum);
        if (!route) {
            // No usable route. Should not happen for an unlocked town (it was
            // reached via a real travel), but degrade to a failed measurement
            // rather than crash a live planning round — the exec-0 staleness
            // retry re-attempts on later rounds.
            p.exec = 0;
            p.routeKey = null;
            know.set(a.name, p);
            return p;
        }
        // hop canStart needs ride along with the standard injections
        for (const res of route.needs) if (res !== "mana" && inject[res] === undefined) inject[res] = 1000;
    }
    p.routeKey = route ? route.entries.map(e => e[0]).join(">") : "";

    // prefix-only baseline, cached per (route, injection-signature) — most
    // same-town probes share {mana} ∪ route.needs, so a refresh wave runs
    // 1-3 baseline loops per town, not one per action
    let baseRun = null;
    if (route) {
        const cacheKey = p.routeKey + "|" + JSON.stringify(inject) + (gate ? "|" + JSON.stringify(gate) : "");
        baseRun = baselineCache?.get(cacheKey);
        if (!baseRun) {
            baseRun = evalLoop(sess, snap, route.entries, inject, gate);
            baselineCache?.set(cacheKey, baseRun);
        }
    }

    const probeQueue = route ? [...route.entries, [a.name, Math.max(1, loops)]] : [[a.name, Math.max(1, loops)]];
    const { r, post } = evalLoop(sess, snap, probeQueue, inject, gate);
    const exec = execCountOf(r, a.name);
    p.exec = exec;
    if (exec > 0) {
        // deltas are taken against `base`/`pre`: for town-0 probes these are
        // the v0 values (injections + pre-round state); for prefixed probes
        // they come from the baseline run (full - baseline = the action's own
        // contribution)
        const base = route ? {
            mana: baseRun.r.lastTimeNeeded,
            gold: baseRun.r.lastResources?.gold ?? 0,
            rep: baseRun.r.lastResources?.reputation ?? 0,
            resources: baseRun.r.lastResources ?? {},
            goldCosts: baseRun.r.lastGoldCosts ?? {},
        } : {
            mana: state.baseMana + MEASURE_MANA,
            gold: inject.gold ?? 0,
            rep: inject.reputation ?? 0,
            resources: inject,
            goldCosts: Object.fromEntries(state.actions.filter(x => x.goldCost > 0).map(x => [x.name, x.goldCost])),
        };
        const pre = route ? baseRun.post : state;
        let manaUsed = 0;
        for (const e of r.lastExec ?? []) if (e.name === a.name) manaUsed += e.manaUsed;
        p.ticksPerExec = manaUsed / exec || 1;
        p.manaPerExec = (r.lastTimeNeeded - base.mana) / exec;
        p.goldPerExec = ((r.lastResources?.gold ?? 0) - base.gold) / exec;
        p.repPerExec = ((r.lastResources?.reputation ?? 0) - base.rep) / exec;
        // granted / consumed resources beyond the standard trio (gold/rep/mana
        // carry their own signed channels). `grants` keeps its increases-only
        // semantics; `consumes` records DECREASES (census 2.3 consumption
        // invisibility — the 33 cost() bodies + finish() deductions) as a
        // SEPARATE additive field, same prefix-baseline `base` subtraction,
        // opposite sign. Read only by informed/coverage code; byte-inert.
        p.grants = {};
        p.consumes = {};
        for (const [k, v] of Object.entries(r.lastResources ?? {})) {
            if (["gold", "reputation", "mana"].includes(k)) continue;
            const bv = base.resources?.[k] ?? 0;
            const num = typeof v === "boolean" ? (v ? 1 : 0) : v;
            const bnum = typeof bv === "boolean" ? (bv ? 1 : 0) : bv;
            if (num > bnum) p.grants[k] = (num - bnum) / exec;
            else if (num < bnum) p.consumes[k] = (bnum - num) / exec;
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
        const preTown = pre.towns[a.townNum], postTown = post.towns[a.townNum];
        if (preTown && postTown) {
            for (const [v, lim2] of Object.entries(postTown.limited)) {
                const d = lim2.total - (preTown.limited[v]?.total ?? 0);
                if (d > 0 && v !== a.varName) p.discovers[v] = d / exec;
            }
        }
        // cross-town effects (census 2.3): the discovers/progress diffs above
        // see only the action's OWN town; some actions write OTHER towns
        // (exchangeMap -> survey exp to a random zone; Build Tower -> stone
        // pools in towns 1/3/5/6; RuinsZ*/Spatiomancy resize pools). Diff every
        // town's progress + limited-total window and record the out-of-town
        // deltas under crossTown[townIdx]. At townsUnlocked=[0] the action
        // touches no other town, so crossTown stays empty and p.crossTown is
        // never set — additive, byte-inert.
        const crossTown = {};
        for (const postT of post.towns) {
            const t = postT.index;
            if (t === a.townNum) continue;
            const preT = pre.towns[t];
            if (!preT) continue;
            const ct = {};
            for (const [v, pv] of Object.entries(postT.progress)) {
                const d = (pv.exp ?? 0) - (preT.progress[v]?.exp ?? 0);
                if (d !== 0) (ct.progress ??= {})[v] = d / exec;
            }
            for (const [v, lim2] of Object.entries(postT.limited)) {
                const d = (lim2.total ?? 0) - (preT.limited[v]?.total ?? 0);
                if (d !== 0) (ct.discovers ??= {})[v] = d / exec;
            }
            if (Object.keys(ct).length) crossTown[t] = ct;
        }
        if (Object.keys(crossTown).length) p.crossTown = crossTown;
        // skill/talent training rates (also feeds vacuous-execution detection)
        let dSkill = 0;
        for (const [sName, sv] of Object.entries(post.skills)) dSkill += (sv.exp ?? 0) - (pre.skills[sName]?.exp ?? 0);
        p.skillExpPerExec = dSkill / exec;
        p.talentPerExec = ((post.talentTotal ?? 0) - (pre.talentTotal ?? 0)) / exec;
        let dProg = 0;
        if (preTown && postTown) {
            for (const [v, pv] of Object.entries(postTown.progress)) dProg += (pv.exp ?? 0) - (preTown.progress[v]?.exp ?? 0);
        }
        p.progressExpPerExec = dProg / exec;
        // §11.10 T2 (§4): persistent-field deltas for target-value goals. Difference
        // the piece-1 persistent read-state fields (buffs / soulstones.total /
        // goldInvested) across the probe — the identical subtraction `grants`
        // does, with the same prefix-baseline `pre`. Byte-inert: an additive
        // profile field read only by targeted-mode kind-b ranking; the heuristic
        // scorer never touches it. Omit zero deltas to keep profiles compact.
        const pd = {};
        const dBuffs = {};
        for (const [b, amt] of Object.entries(post.buffs ?? {})) {
            const d = amt - (pre.buffs?.[b] ?? 0);
            if (d !== 0) dBuffs[b] = d / exec;
        }
        if (Object.keys(dBuffs).length) pd.buffs = dBuffs;
        const dSS = ((post.soulstones?.total ?? 0) - (pre.soulstones?.total ?? 0)) / exec;
        if (dSS !== 0) pd.soulstones = dSS;
        const dGI = ((post.goldInvested ?? 0) - (pre.goldInvested ?? 0)) / exec;
        if (dGI !== 0) pd.goldInvested = dGI;
        // ---- persistentDelta widening (Layer E; census 2.2b,d + class 6) ----
        // per-stat soulstones (the exp-mult currency, stats.js 1+ss^0.8/30),
        // trainingLimits (Imbue Mind), stonesUsed (Haul / Build Tower), dungeon
        // floor completions + ssChance decay drift, trial floors, and per-town
        // multipart total<var> ledgers. Same prefix-baseline `pre` subtraction;
        // all zero at town-0 (the gate's rng:0 proves no dungeon roll fires in
        // any town-0 probe), so pd stays {} and these fields never materialize.
        const dSSStat = {};
        for (const [s, amt] of Object.entries(post.soulstones?.perStat ?? {})) {
            const d = amt - (pre.soulstones?.perStat?.[s] ?? 0);
            if (d !== 0) dSSStat[s] = d / exec;
        }
        if (Object.keys(dSSStat).length) pd.soulstonesPerStat = dSSStat;
        const dTL = ((post.trainingLimits ?? 0) - (pre.trainingLimits ?? 0)) / exec;
        if (dTL !== 0) pd.trainingLimits = dTL;
        const dStones = {};
        for (const [loc, u] of Object.entries(post.stonesUsed ?? {})) {
            const d = u - (pre.stonesUsed?.[loc] ?? 0);
            if (d !== 0) dStones[loc] = d / exec;
        }
        if (Object.keys(dStones).length) pd.stonesUsed = dStones;
        const dDun = {};
        (post.dungeons ?? []).forEach((floors, di) => {
            floors.forEach((f, fi) => {
                // difference floor PROGRESSION; a floor absent in `pre` is a
                // structure-init difference (floors are lazily built on load),
                // not a game effect — skip it. In the live flow `pre` is always
                // floor-initialized, so this never drops a real delta.
                const pf = pre.dungeons?.[di]?.[fi];
                if (!pf) return;
                const dc = (f.completed ?? 0) - (pf.completed ?? 0);
                const dch = (f.ssChance ?? 0) - (pf.ssChance ?? 0);
                if (dc !== 0 || dch !== 0) (dDun[di] ??= {})[fi] = { completed: dc / exec, ssChance: dch / exec };
            });
        });
        if (Object.keys(dDun).length) pd.dungeons = dDun;
        const dTrials = {};
        (post.trials ?? []).forEach((t2, ti) => {
            const pt = pre.trials?.[ti];
            const df = (t2.highestFloor ?? 0) - (pt?.highestFloor ?? 0);
            const dct = (t2.completedTotal ?? 0) - (pt?.completedTotal ?? 0);
            if (df !== 0 || dct !== 0) dTrials[ti] = { highestFloor: df / exec, completedTotal: dct / exec };
        });
        if (Object.keys(dTrials).length) pd.trials = dTrials;
        const dMult = {};
        for (const postT of post.towns) {
            const preT = pre.towns[postT.index];
            if (!preT) continue;
            for (const [v, tot] of Object.entries(postT.mult ?? {})) {
                const d = tot - (preT.mult?.[v] ?? 0);
                if (d !== 0) (dMult[postT.index] ??= {})[v] = d / exec;
            }
        }
        if (Object.keys(dMult).length) pd.mult = dMult;
        p.persistentDelta = pd;
    }
    know.set(a.name, p);
    return p;
}

// Predictor-model priors (Stage-1 info-boundary relaxation, RULED
// 2026-07-10): the Koviko predictor ships a hand-maintained per-action
// effect model for all 9 towns — a fork feature legitimately reads its own
// game's data. The prior is extracted from the entry's effect() applied to
// SYNTHETIC accumulators that mirror measureAction's resource injections
// (a queue-simulation probe from the live state was tried first, but the
// predictor models a fresh loop — gold/rep start at 0 — so every gated or
// costed action projected zero: extraction blind spot, omsi-stats Round 2).
// Effects read live globals (town banks, goldCost(), buffs), so the
// snapshot is restored first. Loop-model entries (multiparts) carry their
// rewards in per-segment handlers, not a flat effect() — marked
// unsupported rather than compared apples-to-oranges.
// Empirical measurement stays authoritative for planning; predictor-vs-
// engine divergence is RECORDED (the "third oracle": it flags predictor
// model bugs, engine changes, and — later — AP-randomized data the
// compile-time model can't know about).
function seedPredictorPrior(sess, snap, know, a, state = null) {
    const p = know.get(a.name) ?? emptyProfile();
    if (p.predictorPrior) return;
    if (!plPredictor) plInitPredictor();
    const pred = plPredictor.predictions?.[a.name];
    if (!pred) {
        p.predictorPrior = { error: "no predictor entry" };
    } else if (pred.loop || typeof pred.effect !== "function") {
        p.predictorPrior = { unsupported: pred.loop ? "loop-model" : "no-effect" };
    } else {
        sess.restore(snap);
        try {
            // same injections as measureAction, so spend-all/gated effects
            // project the deltas the engine measurement realizes
            const goldBase = (a.goldCost ?? 0) > 0 ? 1000 + a.goldCost : 1000;
            const r = { mana: MEASURE_MANA, gold: goldBase, rep: 1000, town: a.townNum, guild: "" };
            // out-of-town probes also inject the route's hop needs — mirror
            // them so priors and measurements stay like-for-like comparable
            if (state && a.townNum !== 0) {
                const route = routeTo(state, sess, a.townNum);
                for (const res of route?.needs ?? []) if (!(res in r)) r[res] = 1000;
            }
            const k = Object.entries(skills).reduce(
                (o, [n, s]) => (o[n.toLowerCase()] = s.exp ?? 0, o), {});
            pred.effect(r, k);
            p.predictorPrior = {
                gold: (r.gold ?? goldBase) - goldBase,
                reputation: (r.rep ?? 1000) - 1000,
                mana: (r.mana ?? MEASURE_MANA) - MEASURE_MANA,
                // converters (Buy Mana) zero the wallet in ONE exec; the
                // engine measurement averages that single spend across its
                // whole batch, so the comparison must be against the total
                goldSpendAll: r.gold === 0 && goldBase > 0,
            };
        } catch (e) {
            p.predictorPrior = { error: e.message };
        }
    }
    know.set(a.name, p);
}
function recordDivergence(divergenceLog, state, a, p) {
    const prior = p.predictorPrior;
    if (!prior || prior.error || prior.unsupported || p.exec <= 0) return;
    // Compare the engine-measured per-exec gold/rep deltas against the
    // predictor's single-exec projection. Coarse tolerance: this is a smoke
    // alarm, not a spec.
    const checks = [
        ["gold", prior.goldSpendAll ? p.goldPerExec * p.exec : p.goldPerExec, prior.gold],
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

// ---- Layer P: edge-directed pair-probes (informed vocabulary; plan §2) ----
// For each measured action A that GRANTS a dimension D (skill/buff), and each
// declared dimEffects edge D -> (target T, channel), MEASURE how A's grant
// shifts T's channel — the generalization of the travelRelief / Haggle pair
// probe from travel edges to the whole skill/buff efficiency web (census 2.2c,
// the #4 high-leverage class). The metadata says WHERE to point; measurement
// stays authoritative for the RATE.
//
// Skill levels are global + persistent but queues run town-forward within a
// loop, so A can't always precede T in the same loop. Two-snapshot method:
// run A x nA from the base snapshot (leveling D; the gain persists through
// doSave), snapshot that boosted state, then measure T from BOTH the boosted
// and base states and difference T's channel. edgeRate is per exec of A
// (signed: manaCost DROPS are negative = cheapening; yields positive).
//
// Informed-only — empirical mode never calls this, so the default reference is
// untouched. RNG-flagged targets (context.rng) are probed only when rngMode is
// "cycle" (plan §6): otherwise the probe would draw un-rollbackable Math.random.
function channelOfProfile(p, channel) {
    switch (channel) {
        case "goldYield":   return p.goldPerExec ?? 0;
        case "manaYield":   return p.manaPerExec ?? 0;
        case "manaCost":    return p.ticksPerExec ?? 0;   // adjusted mana/exec; lower = cheaper
        case "goldCost":    return p.goldPerExec ?? 0;
        case "segmentRate": return p.exec ?? 0;           // completions in the fixed probe budget
        default:            return null;                  // global channel: declared only, not pair-probed
    }
}
// One edge measurement: level D via A from `snap`, snapshot the boosted state,
// measure T's channel there and at baseline, return the per-A-exec delta.
function measureEdge(sess, snap, state, know, A, T, channel, opts = {}) {
    const multiTown = opts.multiTown ?? true;
    // Enough execs of A to move D by SEVERAL levels: some target channels are
    // step functions of the dim level (e.g. floor(base·(1+lvl/100)) gold yields),
    // so a sub-level boost would read a spurious zero. Informed-only — never on
    // the default path, so probe cost doesn't touch the byte reference.
    const nA = opts.nA ?? 60;
    const inject = { mana: Math.min(5_000_000, MEASURE_MANA + Math.ceil(nA * (A.cost || 1000) * 1.2)) };
    let route = null;
    if (A.townNum !== 0 && multiTown) {
        route = routeTo(state, sess, A.townNum);
        if (!route) return null;
        for (const res of route.needs) if (res !== "mana" && inject[res] === undefined) inject[res] = 1000;
    }
    if ((A.goldCost ?? 0) > 0) inject.gold = 1000 + A.goldCost;
    const setupQueue = route ? [...route.entries, [A.name, nA]] : [[A.name, nA]];
    const { r: setupRun } = evalLoop(sess, snap, setupQueue, inject);
    const aExec = execCountOf(setupRun, A.name);
    if (aExec === 0) return null;
    const boostedSnap = sess.save();
    const boostedState = sess.read();
    const Tb = boostedState.actions.find(x => x.name === T.name) ?? T;
    const tNeeds = sess.needs(T.name);
    // base first (restores snap), then boosted (restores boostedSnap)
    const tBase  = measureAction(sess, snap, state, new Map(), T, tNeeds, { multiTown, baselineCache: new Map() });
    const tBoost = measureAction(sess, boostedSnap, boostedState, new Map(), Tb, tNeeds, { multiTown, baselineCache: new Map() });
    if ((tBase.exec ?? 0) === 0 || (tBoost.exec ?? 0) === 0) return null;
    const c0 = channelOfProfile(tBase, channel), cb = channelOfProfile(tBoost, channel);
    if (c0 === null || cb === null) return null;
    return (cb - c0) / aExec;
}
function probeEdges(sess, snap, state, know, opts = {}) {
    const multiTown = opts.multiTown ?? true;
    const cycle = options.rngMode === "cycle";
    const md = plMetadata();
    if (!md.dimEffects) return;
    const byName = new Map(state.actions.map(a => [a.name, a]));
    const unlocked = unlockedOf(state);
    const dimRate = (p, kind, dname) => kind === "skill"
        ? (p.skillExpPerExec ?? 0) : (p.persistentDelta?.buffs?.[dname] ?? 0);
    for (const [dim, edges] of Object.entries(md.dimEffects)) {
        const [kind, dname] = dim.split(":");
        const granters = unlocked.filter(A => {
            const p = know.get(A.name);
            if (!p || p.exec === 0) return false;
            if (kind === "skill") return (A.skillsGained ?? []).includes(dname) && (p.skillExpPerExec ?? 0) > 0;
            if (kind === "buff")  return (p.persistentDelta?.buffs?.[dname] ?? 0) > 0;
            return false;
        });
        if (!granters.length) continue;
        // representative driver: fastest grinder of D (most dim exp per tick)
        granters.sort((x, y) => dimRate(know.get(y.name), kind, dname) / Math.max(1, know.get(y.name).ticksPerExec)
                              - dimRate(know.get(x.name), kind, dname) / Math.max(1, know.get(x.name).ticksPerExec));
        const A = granters[0];
        for (const edge of edges) {
            if (channelOfProfile({}, edge.channel) === null) continue;   // global channel: declared only
            const targets = edge.target ? [byName.get(edge.target)]
                          : edge.targetType === "multipart" ? unlocked.filter(x => x.type === "multipart")
                          : [];
            for (const T of targets) {
                if (!T || !(T.visible && T.unlocked)) continue;
                if (contextFor(T.name)?.rng && !cycle) continue;   // RNG target needs cycle mode
                const rate = measureEdge(sess, snap, state, know, A, T, edge.channel, { multiTown });
                if (rate === null) continue;
                const pA = know.get(A.name);
                (pA.edgeRates ??= {})[T.name] ??= {};
                pA.edgeRates[T.name][edge.channel] = rate;
            }
        }
    }
    sess.restore(snap);
}

async function refreshKnowledge(sess, snap, state, know, opts = {}) {
    const staleAfter = opts.staleAfter ?? 40;
    const multiTown = opts.multiTown ?? true;
    const vocabulary = opts.vocabulary ?? "empirical";
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

    // prefix-baseline cache for this refresh wave (see measureAction)
    const baselineCache = new Map();

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
        if (opts.seedFromPredictor) await seedPredictorPrior(sess, snap, know, a, multiTown ? state : null);
        const p = measureAction(sess, snap, state, know, a, needs, { baselineCache, multiTown, vocabulary });
        p.gatedOn = needs;
        // still gated or vacuous: retry with the universal consumable injected
        if (p.exec === 0 || isVacuous(p)) {
            const p2 = measureAction(sess, snap, state, know, a, [...needs, "gold", "reputation"], { baselineCache, multiTown, vocabulary });
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
            // cross-town pairs (e.g. a town-0 reducer for a town-1 purchase)
            // are deferred in v1; same-town pairs in town N > 0 carry the
            // town's route prefix exactly like single-action probes
            if (s.townNum !== g.townNum) continue;
            let pairPrefix = [];
            const baseCost = -know.get(g.name).goldPerExec;
            const k = 8;
            const inject = { mana: MEASURE_MANA, gold: 1000 + baseCost };
            for (const res of ps.gatedOn ?? []) if (res !== "gold" && res !== "mana") inject[res] = 1000;
            if (s.townNum !== 0) {
                if (!multiTown) continue;
                const route = routeTo(state, sess, s.townNum);
                if (!route) continue;
                pairPrefix = route.entries;
                for (const res of route.needs) if (res !== "mana" && inject[res] === undefined) inject[res] = 1000;
            }
            const { r } = evalLoop(sess, snap, [...pairPrefix, [s.name, k], [g.name, 1]], inject);
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
    // Layer P: edge-directed pair-probes over the declared skill/buff effect
    // web (informed vocabulary only; empirical mode leaves the reference byte-
    // exact). Runs after empirical profiles exist — it needs the granters'
    // measured dim-rates to pick a driver.
    if (vocabulary === "informed") probeEdges(sess, snap, state, know, { multiTown });
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
// Per-town filtered views over the ONE name-keyed knowledge Map: an action
// belongs to exactly one town, so "per-town knowledge" is a townNum filter,
// not a keying change. town = null means all towns (legacy/global view);
// segment builders pass their own town.
function limitedPools(state, know, town = null) {
    // unlocked limited actions with a bank, annotated with measured yields
    const pools = [];
    for (const a of unlockedOf(state)) {
        if (a.type !== "limited") continue;
        if (town != null && a.townNum !== town) continue;
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
// A converter is usable only in the segment of its own town (the queue
// visits towns forward-only within a loop).
function converterOf(state, know, town = null) {
    let best = null;
    for (const a of unlockedOf(state)) {
        if (town != null && a.townNum !== town) continue;
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
    // segment town: pools/converters/purchases are filtered to it, and the
    // cushion STARTS from what previous segments left (v0 semantics = town 0
    // from the loop's base mana)
    const town = opts.town ?? 0;
    const q = [];
    let cushion = opts.startCushion ?? state.baseMana, gold = 0, rep = 0;
    const pools = limitedPools(state, know, town);

    // 1. mana engines: net-positive mana harvests, full bank, best first
    for (const pool of pools.filter(p => p.good > 0 && p.manaPer > p.ticks).sort((x, y) => (y.manaPer - y.ticks) - (x.manaPer - x.ticks))) {
        q.push([pool.name, pool.good]);
        cushion += pool.good * (pool.manaPer - pool.ticks);
        pool.used = pool.good;
    }

    // cheap lasting-boost purchases (e.g. glasses): inserted as soon as affordable
    const purchases = !cheapPurchases ? [] : unlockedOf(state).filter(a => {
        if (a.townNum !== town) return false;
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
    const convKnown = converterOf(state, know, town);
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

    const conv = converterOf(state, know, town);
    const futureGold = () => gold + goldPools.reduce((s, p) => s + (p.good - (p.used ?? 0) - (p.reservedUnits ?? 0)) * p.goldPer, 0);
    // tailReserve: stop the pump once the modeled in-hand cushion covers the
    // caller's tail budget — the economy deliberately UNDERCOMMITS so the
    // realized loop has headroom for out-of-town work. This is the only
    // reservation that actually binds under optimisticTail: extraTailTicks
    // feeds a feasibility check that optimistic candidates skip, and the
    // interleave's own gate is plain MARGIN (the pump must bootstrap from
    // the tiny initial cushion — conversions replenish it). 0 = v0 verbatim.
    const tailReserve = opts.tailReserve ?? 0;
    let guard = 0;
    while (guard++ < 300) {
        if (tailReserve > 0 && cushion >= tailReserve + MARGIN) break;
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
function appendInvest(q, cushion, state, know, share, town = 0) {
    const pools = limitedPools(state, know, town).filter(p => p.unchecked > 0);
    if (!pools.length) return cushion;
    const value = (p) => {
        const measured = Math.max(p.manaPer - p.ticks, p.goldPer * (converterOf(state, know, town)?.rate ?? 50));
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
// Progress dims are town-bound already (dim.town); skill dims may have
// trainers in several towns — `town` picks the segment's own trainer.
function grindActionFor(state, dim, town = null) {
    const cands = unlockedOf(state).filter(a =>
        (town == null || a.townNum === town)
        && (dim.kind === "p" ? (a.type === "progress" && a.varName === dim.v && a.townNum === dim.town)
                             : a.skillsGained.includes(dim.v)));
    cands.sort((x, y) => x.cost - y.cost);
    return cands[0] ?? null;
}

function cheapestProgressBackstop(state, town = null) {
    const cands = unlockedOf(state).filter(a => a.type === "progress" && (town == null || a.townNum === town));
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

// ---------------------------------------------------------------------------
// Travel graph: nodes = towns, edges = travel actions (destination = townNum
// + delta from getPossibleTravel). Pure planning data over the read state —
// no engine writes. Backward edges (Open Portal 6->1) and skip edges (Hitch
// Ride 0->2, Open Rift 0->5, Underworld 2->7) fall out of the representation
// for free. Dynamic edges (Face Judgement: getPossibleTravel returns >1
// delta; destination is reputation-dependent) are flagged and EXCLUDED from
// v1 deterministic routing/pushes — Guru (3->4) and Fall From Grace (4->5)
// cover the same destinations.
// ---------------------------------------------------------------------------
function travelEdges(state) {
    const out = [];
    for (const a of state.actions) {
        const dests = a.travelDests ?? [];
        for (const to of dests) {
            out.push({ action: a, from: a.townNum, to, dynamic: dests.length > 1 });
        }
    }
    return out;
}

// BFS shortest route (by hop count; ties broken by lowest estimated mana
// cost, then lowest hop-name path for stability) from town `from` (default
// 0 = loop start) to `town` over planner-usable edges. Usable = visible &&
// unlocked && !dynamic: committed play must respect the game's own gating
// even though the runtime would not stop a locked travel (it checks only
// townNum + canStart). Pass sess = null to skip needs probing (pure-state
// contexts like scoring).
// Returns { hops, entries, needs, ticksEst } or null when unreachable.
function routeTo(state, sess, town, from = 0) {
    if (town === from) return { hops: [], entries: [], needs: [], ticksEst: 0 };
    const edges = travelEdges(state).filter(e => e.action.visible && e.action.unlocked && !e.dynamic);
    const nameKey = (hops) => hops.map(e => e.action.name).join(">");
    const best = new Map([[from, { hops: [], cost: 0 }]]);
    let frontier = [from];
    while (frontier.length) {
        const next = [];
        for (const t of frontier) {
            const cur = best.get(t);
            for (const e of edges) {
                if (e.from !== t) continue;
                const cand = { hops: [...cur.hops, e], cost: cur.cost + e.action.cost };
                const prev = best.get(e.to);
                if (!prev) { best.set(e.to, cand); next.push(e.to); }
                else if (prev.hops.length === cand.hops.length
                         && (cand.cost < prev.cost
                             || (cand.cost === prev.cost && nameKey(cand.hops) < nameKey(prev.hops)))) {
                    best.set(e.to, cand);
                }
            }
        }
        frontier = next;
    }
    const r = best.get(town);
    if (!r) return null;
    const needs = [];
    if (sess) for (const e of r.hops) needs.push(...sess.needs(e.action.name).filter(k => k !== "mana"));
    return {
        hops: r.hops,
        entries: r.hops.map(e => [e.action.name, 1]),
        needs,
        ticksEst: r.cost,
    };
}

// Resolve each hop's canStart resource needs to measured grantors placeable
// BEFORE that hop (grantors are town-bound; the loop visits route towns
// forward-only). Returns { grantors, inline, segGrantors, needCount } or
// null when some need has no placeable grantor.
//   - inline: grantors of the start town (for pushes: town 0, funded by the
//     economy's inline-purchase machinery);
//   - segGrantors: routeHops index -> entries placed right after that hop
//     (grantors living in mid-route towns);
//   - opts.allowCostedAnywhere: capacity probes model real play and pay from
//     harvested gold, so costed mid-route grantors are fine there; push
//     economics cannot yet fund a costed purchase past their final
//     conversion, so pushes keep costed grantors inline-only.
function resolveRouteGrantors(state, know, sess, routeHops, finalHop = null, opts = {}) {
    const startTown = opts.startTown ?? 0;
    const allowCosted = opts.allowCostedAnywhere ?? false;
    const hops = finalHop ? [...routeHops, finalHop] : routeHops;
    const townsBefore = (i) => [startTown, ...routeHops.slice(0, i).map(e => e.to)];
    const grantors = [], inline = [];
    const segGrantors = new Map();
    let needCount = 0;
    for (let i = 0; i < hops.length; i++) {
        const hopNeeds = sess.needs(hops[i].action.name).filter(k => k !== "mana");
        for (const res of hopNeeds) {
            needCount++;
            const g = unlockedOf(state)
                .map(a => ({ a, p: know.get(a.name) }))
                .filter(({ a, p }) => p && p.exec > 0 && (p.grants[res] ?? 0) > 0
                    && townsBefore(i).includes(a.townNum)
                    && (allowCosted || a.townNum === startTown
                        || (!(a.goldCost > 0) && ((p.goldPerExec ?? 0) > -0.5))))
                .sort((x, y) => (x.a.goldCost || 0) - (y.a.goldCost || 0))[0];
            if (!g) return null;
            grantors.push(g.a);
            if (g.a.townNum === startTown) inline.push(g.a);
            else {
                // latest route hop landing in the grantor's town before hop i
                let at = -1;
                for (let jj = 0; jj < i && jj < routeHops.length; jj++)
                    if (routeHops[jj].to === g.a.townNum) at = jj;
                if (!segGrantors.has(at)) segGrantors.set(at, []);
                segGrantors.get(at).push([g.a.name, 1]);
            }
        }
    }
    return { grantors, inline, segGrantors, needCount };
}

// Assemble route hop entries with mid-route grantors interleaved (each
// grantor right after the hop landing in its town).
function routeTailEntries(routeHops, segGrantors, finalName = null) {
    const tail = [];
    routeHops.forEach((e, jj) => {
        tail.push([e.action.name, 1]);
        for (const entry of segGrantors.get(jj) ?? []) tail.push(entry);
    });
    if (finalName) tail.push([finalName, 1]);
    return tail;
}

// Push candidates: economy with reserve -> price reducers -> resource
// grantors -> route hops -> travel.
function buildPushes(state, know, sess, multiTown = true) {
    const out = [];
    // Destination-aware targets: v0 filtered by the travel DELTA
    // (`!townsUnlocked.includes(a.travelNum)`), which coincides with the
    // destination only for town-0 travels — Continue On (1->2, delta +1)
    // was never generated as a candidate (the Round-5 wall). A target is an
    // edge whose DESTINATION is still locked; multi-hop pushes route to the
    // edge's origin first (empty route for town-0 origins = v0 code path).
    // multiTown=false restores the v0 enumeration verbatim (A/B sweeps).
    const targets = multiTown
        ? travelEdges(state).filter(e =>
            e.action.visible && e.action.unlocked && !e.dynamic && !state.townsUnlocked.includes(e.to))
        : state.actions
            .filter(a => a.visible && a.unlocked && a.travelNum > 0 && !state.townsUnlocked.includes(a.travelNum))
            .map(a => ({ action: a, from: 0, to: a.townNum + a.travelNum, dynamic: false }));
    for (const target of targets) {
        const travel = target.action;
        const route = routeTo(state, sess, target.from);
        if (!route) continue;   // origin town unreachable over usable edges
        const labelHead = route.hops.length
            ? `push2:${route.hops.map(e => e.action.name).join(">")}>` : "push:";
        // canStart resource needs resolved PER HOP (route hops + the final
        // travel), in hop order; a resource needed by two hops appears twice
        // and gets a grantor exec per hop
        const resolved = resolveRouteGrantors(state, know, sess, route.hops, target);
        if (!resolved) {
            // grantor unknown: offer exploratory pushes with each unmeasured
            // purchase action
            const candidates = unlockedOf(state).filter(a => a.goldCost > 30 && (know.get(a.name)?.exec ?? 0) === 0);
            for (const p of candidates.slice(0, 2)) {
                const eco = buildEconomy(state, know, { reserveGold: p.goldCost * 1.1 });
                if (eco) out.push({ label: `push-explore:${travel.name}:${p.name}`, q: [...eco.q, [p.name, 1], ...route.entries, [travel.name, 1]] });
            }
            continue;
        }
        const { grantors, inline, segGrantors } = resolved;
        // grantor gold cost: prefer the measured spend (some purchases, e.g.
        // Buy Supplies, have no goldCost() method — the price lives in
        // canStart/finish)
        const costOf = (g) => Math.max(g.goldCost || 0, -(know.get(g.name)?.goldPerExec ?? 0));
        const totalCost = grantors.reduce((s, g) => s + costOf(g), 0);
        // price reducers measured against any grantor; reducers execute in
        // the town-0 economy segment (v1), so only town-0 reducers qualify
        const reducers = unlockedOf(state)
            .map(a => ({ a, p: know.get(a.name) }))
            .filter(({ a, p }) => a.townNum === 0 && p && grantors.some(g => (p.costReductions[g.name] ?? 0) > 0));
        // reducer count capped by what the rep-yielding banks can actually
        // fund (each Haggle-like exec consumes rep; rep comes from harvesting
        // e.g. LQs). Reducers run in the town-0 economy segment (v1), so
        // only town-0 pools fund them.
        const repCapacity = limitedPools(state, know, 0)
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
            const entries = [...reducerEntries, ...inline.map(g => [g.name, 1])];
            const segEntries = [...segGrantors.values()].flat();
            const entryTicks = [...entries, ...segEntries].reduce((s, [n, l]) => s + l * (know.get(n)?.ticksPerExec || 150), 0);
            const eco = buildEconomy(state, know, {
                purchaseInline: { entries, price, repNeed },
                extraTailTicks: entryTicks + route.ticksEst + travel.cost + 300,
                // multi-hop only: the later hops' mana must survive the
                // economy (single-hop keeps the v0 code path byte-exactly);
                // 2x = drift buffer for the pump's optimistic cushion model
                tailReserve: route.hops.length ? 2 * (entryTicks + route.ticksEst + travel.cost + 300) : 0,
                optimisticTail: true,
            });
            if (!eco) continue;
            out.push({ label: `${labelHead}${travel.name}:h${h}`,
                       q: [...eco.q, ...routeTailEntries(route.hops, segGrantors, travel.name)] });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Targeted mode (§11.10 v1): goal-directed backward regression over the
// already-measured dependency graph — the principled generalization of the ONE
// hand-wired goal chain (buildPushes, which only ever targets the next town's
// travel). Selected by `P.strategy === "targeted"`; byte-INERT at the default
// "heuristic" (none of this code is reached). Guild gates are DEFERRED to v2
// (T0 §8.1: guild membership is a cheap in-loop rep, but a guild goal only
// succeeds deep-game — reach+unlock+skill — so v1 covers route + canStart +
// repMax gates only).
// ---------------------------------------------------------------------------

// Discover an unlocked rep-sink provider (measured repPerExec < 0), reachable
// in the given town (0 = the economy segment in v1). Profile-discovered, never
// hard-coded (§8.2). Returns { a, repPer } (repPer > 0 = rep spent per exec)
// or null.
function repSinkProvider(state, know, town = 0) {
    let best = null;
    for (const a of unlockedOf(state)) {
        if (a.townNum !== town) continue;
        const p = know.get(a.name);
        if (p && p.exec > 0 && (p.repPerExec ?? 0) < -0.001) {
            const repPer = -p.repPerExec;
            if (!best || repPer > best.repPer) best = { a, repPer };
        }
    }
    return best;
}

// regressAction (§3.1): assemble a within-loop queue that makes an
// unlocked-but-blocked action X executable this loop. Reuses routeTo /
// resolveRouteGrantors / buildEconomy / routeTailEntries verbatim. Returns
// { label, q, goal } or null when the goal is unreachable this loop (the
// caller skips to the next priority / falls back to the heuristic scorer).
function regressAction(state, know, sess, X, opts = {}) {
    const gate = X.gate ?? gateFor(X.name);
    // guild gates → v2 (T0 §8.1); other declared-but-unsatisfied gates
    // (soulstoneSac / talent+buff floors / combat-power bounds / timeMax /
    // skillFloor) also v2 setup chains (§11.8 piece 2) — unreachable in v1.
    if (gate && (gate.guild || gate.guildEmpty || gate.soulstoneSac || gate.talentFloor
                 || gate.buffFloor || gate.timeMax || gate.skillFloor
                 || gate.resourceMax || gate.resourceMin)) return [];
    // route to X's town (null ⇒ unreachable over usable travel edges)
    const route = routeTo(state, sess, X.townNum);
    if (!route) return [];
    // repMax gate: prepend a rep-sink to drive reputation to <= repMax.
    // repMax===0 needs nothing (loop-start rep is 0); repMax<0 needs a sink.
    let repSinkEntries = [], repSinkTicks = 0;
    if (gate && gate.repMax != null && gate.repMax < 0) {
        const sink = repSinkProvider(state, know, 0);
        if (!sink) return [];
        const nSink = Math.ceil(-gate.repMax / sink.repPer);
        repSinkEntries = [[sink.a.name, nSink]];
        repSinkTicks = nSink * Math.max(1, know.get(sink.a.name)?.ticksPerExec ?? 150);
    }
    // canStart resource needs of the route hops + X itself → placeable grantors
    // (resolveRouteGrantors treats X as the finalHop and resolves its own needs)
    const resolved = resolveRouteGrantors(state, know, sess, route.hops, { action: X });
    if (!resolved) return [];
    const { grantors, inline, segGrantors } = resolved;
    const costOf = (g) => Math.max(g.goldCost || 0, -(know.get(g.name)?.goldPerExec ?? 0));
    const totalCost = grantors.reduce((s, g) => s + costOf(g), 0);
    const targetTicks = know.get(X.name)?.ticksPerExec ?? X.cost ?? 300;

    // Price reducers (Haggle→Buy Supplies) — the SAME machinery buildPushes
    // uses: without it the toll is bought at full price and the chain dies
    // before the grantor even in a fat economy (Round-6 economics: pure-eco
    // headroom < full-price supplies; Haggle h-variants are what make the toll
    // fit). Reducers run in the town-0 economy segment (v1). Emitting one
    // candidate per h-variant lets planTargeted confirm and INSTALL the
    // smallest achievable h (§5 failed-link handles the rest).
    const reducers = unlockedOf(state)
        .map(a => ({ a, p: know.get(a.name) }))
        .filter(({ a, p }) => a.townNum === 0 && p && grantors.some(g => (p.costReductions[g.name] ?? 0) > 0));
    const repCapacity = limitedPools(state, know, 0)
        .filter(p => p.repPer > 0.1 && p.good > 0)
        .reduce((s, p) => s + Math.floor(p.good * p.repPer), 0);
    const hVariants = new Set([0]);
    for (const { p } of reducers) {
        const red = Math.max(...grantors.map(g => p.costReductions[g.name] ?? 0));
        const repPerUse = Math.max(0.01, -(p.repPerExec ?? -1));
        const hMax = Math.min(15, Math.ceil(totalCost / red), Math.floor(repCapacity / repPerUse));
        if (hMax >= 1) { hVariants.add(Math.max(1, Math.floor(hMax / 2))); hVariants.add(hMax); }
    }

    const routeLabel = route.hops.length ? route.hops.map(e => e.action.name).join(">") + ">" : "";
    const out = [];
    for (const h of [...hVariants].sort((a, b) => a - b)) {
        let price = totalCost, repNeed = 0;
        const reducerEntries = [];
        if (h > 0 && reducers.length) {
            const { a, p } = reducers[0];
            const red = Math.max(...grantors.map(g => p.costReductions[g.name] ?? 0));
            price = Math.max(0, totalCost - h * red);
            repNeed = h * Math.max(0, -p.repPerExec);
            reducerEntries.push([a.name, h]);
        }
        const entries = [...reducerEntries, ...inline.map(g => [g.name, 1])];
        const segEntries = [...segGrantors.values()].flat();
        const entryTicks = [...entries, ...segEntries].reduce((s, [n, l]) => s + l * (know.get(n)?.ticksPerExec || 150), 0);
        // reserve tail for the rep-sink + route + grantors + X's own exec
        const tailBudget = entryTicks + repSinkTicks + route.ticksEst + targetTicks + 300;
        const eco = buildEconomy(state, know, {
            purchaseInline: { entries, price, repNeed },
            extraTailTicks: tailBudget,
            // Mirror buildPushes' economy EXACTLY (this IS the generalized push):
            // multi-hop routes reserve the later hops' mana; single-hop town-0
            // travels (route.hops.length 0) lean on the interleave + optimistic
            // tail, same as the heuristic push that DOES confirm once the economy
            // is fat enough. planTargeted's engine confirm is the achievability
            // gate — it installs the chain the loop it first executes (before the
            // scorer would pick it), which is targeted mode's whole advantage.
            tailReserve: route.hops.length ? 2 * tailBudget : 0,
            optimisticTail: true,
        });
        if (!eco) continue;
        // economy → rep-sink → route hops (+ mid-route grantors) → X (terminal)
        const q = [...eco.q, ...repSinkEntries, ...routeTailEntries(route.hops, segGrantors, X.name)];
        out.push({ label: `target:${routeLabel}${X.name}:h${h}`, q, goal: { kind: "a", action: X.name } });
    }
    return out;
}

// Current read-state value of a PERSISTENT target (ruling 6). Used both as the
// across-rounds stop condition (drop the goal once R >= V) and as the kind-b
// achievability signal (R advanced this loop).
function readStateValue(state, t) {
    if (t.type === "skill") return state.skills?.[t.name]?.level ?? 0;
    if (t.type === "progress") return state.towns?.[t.town ?? 0]?.progress?.[t.name]?.level ?? 0;
    if (t.type === "buff") return state.buffs?.[t.name] ?? 0;
    if (t.type === "soulstones") return state.soulstones?.total ?? 0;
    if (t.type === "goldInvested") return state.goldInvested ?? 0;
    return 0;
}

// Rank providers of a PERSISTENT resource R by measured ΔR per tick, desc.
// Skill/progress dims use the max-throughput grinder (grindActionFor — the
// same trainer the frontier grinders rank on, "works today" per §3.2). Buffs /
// soulstones / goldInvested use the §4 persistentDelta profile field.
function rankValueProviders(state, know, t) {
    if (t.type === "skill" || t.type === "progress") {
        const dim = t.type === "skill" ? { kind: "s", v: t.name }
                                       : { kind: "p", v: t.name, town: t.town ?? 0 };
        const g = grindActionFor(state, dim, t.town ?? null);
        return g ? [{ a: g, rate: 1 / Math.max(1, g.cost) }] : [];
    }
    const dR = (p) => {
        if (!p?.persistentDelta) return 0;
        if (t.type === "buff") return p.persistentDelta.buffs?.[t.name] ?? 0;
        return p.persistentDelta[t.type] ?? 0;   // soulstones | goldInvested
    };
    return unlockedOf(state)
        .map(a => ({ a, p: know.get(a.name), d: dR(know.get(a.name)) }))
        .filter(x => x.d > 0)
        .map(x => ({ a: x.a, rate: x.d / Math.max(1, x.p.ticksPerExec) }))
        .sort((x, y) => y.rate - x.rate);
}

// regressTarget (§3.2, kind-b): FILL the loop with the actions producing the
// greatest ΔR toward a PERSISTENT target (ruling 6 — skill/talent/progress exp,
// buffs, soulstones, goldInvested; NOT gold/rep/mana). Reuses regressAction to
// get the route/gate/economy scaffold for the top provider, then replaces its
// terminal x1 with a fill count sized to the loop budget and capped by pool
// availability (§3.2) so the committed queue never runs dry on an exhausted
// pool. V is the ACROSS-ROUNDS stop condition (tracked by planTargeted), not a
// within-loop guarantee. Returns [{ label, q, goal }].
function regressTarget(state, know, sess, goal, opts = {}) {
    const t = goal.target;
    const providers = rankValueProviders(state, know, t);
    if (!providers.length) return [];
    const top = providers[0].a;
    // scaffold = [economy, ...route/grantors..., top x1] (h-variants); reuses
    // ALL of regressAction's route/gate/economy machinery for a routed/gated
    // provider, and degrades to [economy, top x1] for a plain town-0 grinder.
    const scaffolds = regressAction(state, know, sess, top, opts);
    if (!scaffolds.length) return [];
    const perExec = Math.max(1, know.get(top.name)?.ticksPerExec ?? top.cost ?? 150);
    // budget: a fraction of the capacity hint (T3 replaces this with the §3.5
    // per-goal budget share). Partial fill still ADVANCES R, so an over-sized N
    // is harmless — the confirm just runs fewer reps.
    let n = Math.max(1, Math.floor((opts.fillShare ?? 0.6) * (opts.capacityHint ?? state.baseMana) / perExec));
    if (top.type === "limited") {
        const lim = state.towns[top.townNum]?.limited[top.varName];
        if (lim) n = Math.min(n, Math.max(1, (lim.good ?? 0) + ((lim.total ?? 0) - (lim.checked ?? 0))));
    }
    if (top.allowed != null) n = Math.min(n, top.allowed);
    const label = `value:${t.type}${t.name ? ":" + t.name : ""}`;
    // replace the scaffold's terminal provider x1 with the fill count
    return scaffolds.map(c => ({
        label: `${label}>${c.label}`,
        q: [...c.q.slice(0, -1), [top.name, n]],
        goal,
    }));
}

// Build the targeted candidate list from a priority list of goals (T1: action
// goals; T2: + target-value goals). Returns [{ label, q, goal }] with each
// goal's h-variants in ascending order (planTargeted installs the smallest
// achievable h); unreachable goals drop out.
function generateTargeted(state, know, sess, goals, opts = {}) {
    const cands = [];
    for (const g of goals) {
        if (g.kind === "a") {
            const X = unlockedOf(state).find(a => a.name === g.action);
            if (X) cands.push(...regressAction(state, know, sess, X, opts));
        } else if (g.kind === "b") {
            cands.push(...regressTarget(state, know, sess, g, opts));
        }
    }
    return cands;
}

// Heuristic grind tail for the residual handoff (ruling 5): the top frontier
// dim's cheapest grinder, sized to `ticks`. Returns [name, reps] or null.
function heuristicGrindTail(state, know, thresholds, ticks) {
    for (const d of rankFrontierDims(state, thresholds ?? {})) {
        const g = grindActionFor(state, d, 0);
        if (!g) continue;
        const reps = Math.floor(ticks / Math.max(1, g.cost));
        if (reps >= 1) return [g.name, g.allowed != null ? Math.min(reps, g.allowed) : reps];
    }
    return null;
}

// Auto-rank targets (ruling 2): enumerate blocked-but-reachable travel
// destinations as action goals, nearest-locked-town first — the same "best
// locked/blocked target" the §6 escalation goes all-in on. No budgets (ruling
// 4). v1 covers the travel frontier (the pivotal blocked class); richer
// enumeration is a calibration question, deferred.
function autoRankGoals(state, know, sess, thresholds) {
    const targets = travelEdges(state)
        .filter(e => e.action.visible && e.action.unlocked && !e.dynamic && !state.townsUnlocked.includes(e.to))
        .sort((a, b) => a.to - b.to);
    const seen = new Set();
    const goals = [];
    for (const e of targets) {
        if (seen.has(e.action.name)) continue;
        seen.add(e.action.name);
        goals.push({ kind: "a", action: e.action.name });
    }
    return goals;
}

// Assemble the priority list into ONE committed queue (§3.3–3.5). The highest-
// priority ACHIEVABLE goal is the SPINE (its economy + chain, smallest-h
// variant); lower-priority kind-b goals layer BUDGETED fills onto the shared
// economy against a running remaining-ticks counter (cascade falls out of the
// counter); leftover budget goes to a heuristic grind tail (residual handoff,
// ruling 5). Returns { q, bareQ, label, spineGoal } or null (no goal's scaffold
// forms → full heuristic fallback). The engine confirm (planTargeted) decides
// achievability and whether the extension starved the spine (§8.4).
function assembleTargetedQueue(pre, know, sess, goals, thresholds, opts = {}) {
    const cap = opts.capacityHint ?? pre.baseMana;
    const ticksOf = (queue) => queue.reduce((s, [n, l]) => s + l * (know.get(n)?.ticksPerExec ?? 150), 0);
    // 1. spine = first goal whose scaffold forms (smallest-h variant)
    let spineIdx = -1, spineCand = null;
    for (let i = 0; i < goals.length; i++) {
        const g = goals[i];
        let cands = [];
        if (g.kind === "a") {
            const X = unlockedOf(pre).find(a => a.name === g.action);
            if (X) cands = regressAction(pre, know, sess, X, { ...opts, capacityHint: cap });
        } else {
            cands = regressTarget(pre, know, sess, g, { ...opts, capacityHint: cap, fillShare: g.budget ?? 0.6 });
        }
        if (cands.length) { spineIdx = i; spineCand = cands[0]; break; }
    }
    if (spineIdx < 0) return null;
    const bareQ = spineCand.q.slice();
    let q = spineCand.q.slice();
    const spineGoal = goals[spineIdx];
    // a spine kind-a TRAVEL goal must stay queue-terminal; layers insert before it
    const spineAction = spineGoal.kind === "a" ? unlockedOf(pre).find(a => a.name === spineGoal.action) : null;
    const terminalTravel = !!spineAction && (spineAction.travelDests ?? []).length > 0;
    const insert = (entry) => { if (!entry) return; if (terminalTravel) q.splice(q.length - 1, 0, entry); else q.push(entry); };
    // 2. layer lower-priority kind-b goals (budgeted fill, running counter, cascade)
    let remaining = Math.max(0, cap - ticksOf(q));
    for (let i = spineIdx + 1; i < goals.length && remaining > 300; i++) {
        const g = goals[i];
        if (g.kind !== "b") continue;   // v1: only kind-b layers concurrently (kind-a atomic — deferred)
        if (readStateValue(pre, g.target) >= (g.value ?? Infinity)) continue;
        const provs = rankValueProviders(pre, know, g.target);
        if (!provs.length) continue;
        const top = provs[0].a;
        const perExec = Math.max(1, know.get(top.name)?.ticksPerExec ?? top.cost ?? 150);
        // budgeted goal takes min(its share of the WHOLE fill budget, remaining)
        const share = g.budget ? Math.min(g.budget * cap, remaining) : remaining;
        let reps = Math.floor(share / perExec);
        if (top.type === "limited") {
            const lim = pre.towns[top.townNum]?.limited[top.varName];
            if (lim) reps = Math.min(reps, (lim.good ?? 0) + ((lim.total ?? 0) - (lim.checked ?? 0)));
        }
        if (top.allowed != null) reps = Math.min(reps, top.allowed);
        if (reps < 1) continue;
        insert([top.name, reps]);
        remaining -= reps * perExec;
    }
    // 3. residual handoff: heuristic grind tail on the leftover (ruling 5)
    if (remaining > 300) insert(heuristicGrindTail(pre, know, thresholds, remaining));
    return { q, bareQ, label: spineCand.label, spineGoal };
}

function generateCandidates(state, know, thresholds, sess, lastCommitted, opts = {}) {
    const multiTown = opts.multiTown ?? true;
    const cands = [];
    const add = (label, q) => { if (q && q.length) cands.push({ label, q }); };

    // The v0 candidate backbone is the TOWN-0 segment (every loop starts
    // there); out-of-town dims get expedition candidates below. only dims we
    // can actually grind right now (an unlocked town-0 action raises them)
    const allDims = rankFrontierDims(state, thresholds);
    const dims = allDims.filter(d => grindActionFor(state, d, 0));
    const backstop = cheapestProgressBackstop(state, 0);

    // grind candidates along the top frontier dims
    for (const [di, dim] of dims.slice(0, 4).entries()) {
        const target = grindActionFor(state, dim, 0);
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
        const t1 = grindActionFor(state, dims[0], 0), t2 = grindActionFor(state, dims[1], 0);
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
            .filter(a => a.townNum === 0)
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
    for (const p of buildPushes(state, know, sess, multiTown)) add(p.label, p.q);

    // expedition candidates: travel to an unlocked town t > 0 and work THERE
    // (new candidate types append after the v0 ones — inertness order rule).
    // Bounded to frontier towns: towns owning a global-top-4 probed-unmet dim,
    // plus always the highest unlocked town (§6.4 of the multi-town plan);
    // no screen exemption — expeditions must earn engine confirmation.
    if (multiTown) {
        const expeditionTowns = new Set();
        for (const d of allDims.slice(0, 4)) if (d.kind === "p" && (d.town ?? 0) > 0) expeditionTowns.add(d.town);
        const maxTown = Math.max(...state.townsUnlocked);
        if (maxTown > 0) expeditionTowns.add(maxTown);
        for (const t of [...expeditionTowns].sort((x, y) => x - y)) {
            if (!state.townsUnlocked.includes(t)) continue;
            const route = routeTo(state, sess, t);
            if (!route || !route.hops.length) continue;
            const resolved = resolveRouteGrantors(state, know, sess, route.hops);
            if (!resolved) continue;
            const { grantors, inline, segGrantors } = resolved;
            const costOf = (g) => Math.max(g.goldCost || 0, -(know.get(g.name)?.goldPerExec ?? 0));
            const totalCost = grantors.reduce((s, g) => s + costOf(g), 0);
            // The journey toll DOMINATES expedition economics (Round 6): gold
            // reserved for supplies forgoes its converter value (~50 mana per
            // gold), so price reducers (Haggle) are what buy town-t time.
            // Mirror buildPushes' reducer machinery (kept duplicated — the
            // push code path must stay byte-identical): h0 plus the deepest
            // fundable reduction.
            const reducers = unlockedOf(state)
                .map(a => ({ a, p: know.get(a.name) }))
                .filter(({ a, p }) => a.townNum === 0 && p && grantors.some(g => (p.costReductions[g.name] ?? 0) > 0));
            const repCapacity = limitedPools(state, know, 0)
                .filter(p => p.repPer > 0.1 && p.good > 0)
                .reduce((s, p) => s + Math.floor(p.good * p.repPer), 0);
            const hVariants = new Set([0]);
            for (const { a, p } of reducers) {
                const red = Math.max(...grantors.map(g => p.costReductions[g.name] ?? 0));
                const repPerUse = Math.max(0.01, -(p.repPerExec ?? -1));
                const hMax = Math.min(15, Math.ceil(totalCost / red), Math.floor(repCapacity / repPerUse));
                if (hMax >= 1) hVariants.add(hMax);
            }
            const tBackstop = cheapestProgressBackstop(state, t);
            const tDims = allDims.filter(d => (d.kind === "p" ? d.town === t : true) && grindActionFor(state, d, t));
            // generous tail batches: entries past the realized budget simply
            // never run (the loop ends when mana ends), so overrun is free —
            // n<1 skipping is what silently killed variants in Round 6
            const tailN = (cost) => Math.max(1, Math.floor(0.5 * (opts.capacityHint ?? 25000) / Math.max(1, cost)));
            for (const h of [...hVariants]) {
                let price = totalCost, repNeed = 0;
                const reducerEntries = [];
                if (h > 0 && reducers.length) {
                    const { a, p } = reducers[0];
                    const red = Math.max(...grantors.map(g => p.costReductions[g.name] ?? 0));
                    price = Math.max(0, totalCost - h * red);
                    repNeed = h * Math.max(0, -p.repPerExec);
                    reducerEntries.push([a.name, h]);
                }
                const entries = [...reducerEntries, ...inline.map(g => [g.name, 1])];
                const segEntries = [...segGrantors.values()].flat();
                const entryTicks = [...entries, ...segEntries].reduce((s, [n, l]) => s + l * (know.get(n)?.ticksPerExec || 150), 0);
                const eco = buildEconomy(state, know, {
                    cheapPurchases: true,
                    purchaseInline: (entries.length || price > 0) ? { entries, price, repNeed } : null,
                    extraTailTicks: entryTicks + route.ticksEst + 300,
                    optimisticTail: true,
                });
                if (!eco) continue;
                const head = [...eco.q, ...routeTailEntries(route.hops, segGrantors)];
                // grind on the town's top frontier dims
                for (const dim of tDims.slice(0, 2)) {
                    const target = grindActionFor(state, dim, t);
                    const q = [...head];
                    q.push([target.name, Math.min(tailN(target.cost), target.allowed ?? Infinity)]);
                    appendInvest(q, tailN(1) / 4, state, know, 0.9, t);
                    if (tBackstop) q.push([tBackstop.name, 99]);
                    add(`xp:${t}:grind:${dim.v}:h${h}`, q);
                }
                // investment in the town's measured pools
                if (limitedPools(state, know, t).some(p => p.unchecked > 0)) {
                    const q = [...head];
                    appendInvest(q, tailN(1) / 2, state, know, 1.0, t);
                    if (tBackstop) q.push([tBackstop.name, 99]);
                    add(`xp:${t}:invest:h${h}`, q);
                }
                // discovery grind on the town's best measured discoverer
                const disc = unlockedOf(state)
                    .filter(a => a.townNum === t)
                    .map(a => ({ a, p: know.get(a.name) }))
                    .filter(({ p }) => p && p.exec > 0 && Object.values(p.discovers ?? {}).some(x => x > 0))
                    .sort((x, y) => {
                        const rate = ({ p }) => Object.values(p.discovers).reduce((s, d) => s + d, 0) / Math.max(1, p.ticksPerExec);
                        return rate(y) - rate(x);
                    })[0];
                if (disc) {
                    const q = [...head];
                    q.push([disc.a.name, Math.min(tailN(disc.a.cost), disc.a.allowed ?? Infinity)]);
                    if (tBackstop) q.push([tBackstop.name, 99]);
                    add(`xp:${t}:discover:${disc.a.name}:h${h}`, q);
                }
                // bare expedition (fresh town, no knowledge yet): backstop
                // only — the tail must never idle mid-town
                if (tBackstop) add(`xp:${t}:bare:h${h}`, [...head, [tBackstop.name, 99]]);
            }
        }
    }

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
function scoreOutcome(pre, post, thresholds, r, prevCapacity, know, W, capacity, extra = {}) {
    let s = 0;
    const parts = {};
    parts.town = W.town * (post.townsUnlocked.length - pre.townsUnlocked.length);

    // §11.5 scoring-horizon terms. GATED ON THE PRE STATE: at townsUnlocked=
    // [0] neither branch runs, so the v0 byte-exact acceptance holds (stat
    // drift changes town-0 travel costs every loop — an ungated relief term
    // would re-rank v0 candidates). Activates from the first planning round
    // AFTER town 1 unlocks.
    if (pre.townsUnlocked.length > 1) {
        // Travel relief: the summed cost of the cheapest routes to every
        // reachable town is a PRICE the run pays again and again (commute
        // tolls now, the town-2 unlock price soon). Persistent reductions —
        // Old Shortcut cheapening Continue On (8000 - 60/level), stat growth
        // cheapening every hop — are pure plAdjCost arithmetic, visible in
        // the read states. Grantor tolls (supplies gold) are deliberately NOT
        // priced: pre and post share one knowledge Map, so their delta is
        // identically zero. Pure state + routeTo(state, null, t): no engine
        // work, deterministic.
        const reliefOf = (state) => {
            let sum = 0;
            const dests = new Set();
            for (const e of travelEdges(state)) {
                if (!e.dynamic && e.action.visible && e.action.unlocked && e.to !== 0) dests.add(e.to);
            }
            for (const t of dests) {
                const rt = routeTo(state, null, t);
                if (rt) sum += rt.ticksEst;
            }
            return sum;
        };
        parts.travelRelief = W.travelRelief * (reliefOf(pre) - reliefOf(post));
        // Headroom: capacity is bank-limited at the plateau (log-growth term
        // reads 0) while stat growth keeps cutting the PUMP's tick cost —
        // the disposable slice (capacity minus the capacity probe's spent
        // ticks) is what actually funds expeditions and the town-2 push
        // (Round 6: headroom 10,782 vs price 18.6k). The probe loop already
        // runs per candidate; its tick count rides along in `extra`.
        if (extra.probeTicks != null && extra.prevProbeTicks != null) {
            parts.headroom = W.headroom *
                ((capacity - extra.probeTicks) - (prevCapacity - extra.prevProbeTicks));
        }
    }

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
// Loop-only engine eval for the ENGINE screen mode: run the candidate's
// loop (no capacity probe, no state read) and return the engine-truth
// analog of the predictor's productive-mana proxy — mana spent on actions
// (Σ lastExec manaUsed; idle mana excluded). Uniform cost per candidate
// (every loop is bounded by the same mana budget), so pooled screens have
// no long pole — unlike the predictor, whose cost scales with queue
// entry count.
function evalLoopOnly(sess, snap, q) {
    try {
        sess.restore(snap);
        sess.setQueue(q);
        sess.restart();
        const r = sess.runLoop();
        if (r.degenerate) return { degenerate: true };
        return { degenerate: false, spent: (r.lastExec ?? []).reduce((s, e) => s + (e.manaUsed ?? 0), 0) };
    } catch {
        return { degenerate: true };
    }
}

async function screenCandidates(sess, snap, cands, K, mode = "predictor") {
    // screenMode "none": no cut — every candidate goes to engine
    // confirmation (the screen-as-regularizer ablation arm).
    if (mode === "none") return cands.map(c => ({ ...c, screen: 0 }));
    const scored = [];
    if (mode === "engine") {
        // screenMode "engine": rank by a real engine loop instead of the
        // Koviko predictor. Same K-cut and force-keep semantics below.
        let results;
        if (plEvalPool) {
            results = await plEvalPool(cands.map(c =>
                ({ kind: "escreen", save: snap.save, rng: snap.rng, q: c.q })));
        } else {
            results = cands.map(c => evalLoopOnly(sess, snap, c.q));
        }
        for (let i = 0; i < cands.length; i++) {
            const c = cands[i], r = results[i];
            if (!r.degenerate) c.pred = { totalMana: r.spent, isValid: true };
            scored.push({ ...c, screen: r.degenerate ? -1 : r.spent });
        }
        scored.sort((x, y) => y.screen - x.screen);
        const keepE = new Set(scored.slice(0, K).map(c => c.label));
        for (const c of scored) if (c.label.startsWith("push") || c.label === "repeat") keepE.add(c.label);
        return scored.filter(c => keepE.has(c.label));
    }
    const scoreOne = (c, p, ok) => {
        let s = 0;
        if (ok && p?.ok) {
            // productive-mana proxy: mana spent within budget
            const overdraft = Math.max(0, -(p.resources?.mana ?? 0));
            s = (p.totalMana ?? 0) - overdraft;
            c.pred = { totalMana: p.totalMana, isValid: p.isValid };
        } else ok = false;
        scored.push({ ...c, screen: ok ? s : -1 });
    };
    if (plEvalPool) {
        // pooled: predictions fan out to parallel contexts; each job restores
        // the snapshot itself. A worker-side failure surfaces as ok:false —
        // same resilience as the serial catch.
        const results = await plEvalPool(cands.map(c =>
            ({ kind: "screen", save: snap.save, rng: snap.rng, q: c.q })));
        for (let i = 0; i < cands.length; i++) scoreOne(cands[i], results[i], true);
    } else {
        sess.restore(snap);
        for (const c of cands) {
            let p = null, ok = true;
            try { p = await sess.predict(c.q); } catch { ok = false; }
            scoreOne(c, p, ok);
        }
    }
    scored.sort((x, y) => y.screen - x.screen);
    // always keep pushes and repeat (cheap insurance against predictor model gaps)
    const keep = new Set(scored.slice(0, K).map(c => c.label));
    for (const c of scored) if (c.label.startsWith("push") || c.label === "repeat") keep.add(c.label);
    return scored.filter(c => keep.has(c.label));
}

// ---------------------------------------------------------------------------
// Targeted planning (§11.10): assemble the priority list into ONE queue (spine +
// budgeted layers + heuristic residual tail), engine-CONFIRM it, and INSTALL it
// when the spine goal executes — no scoring vs the heuristic pool (ruling 1).
// Returns a planRound-shaped result, or null when no goal is achievable this
// loop (the caller falls back to the heuristic scorer — ruling 1's full
// fallback). The engine confirm IS the achievability oracle. If the residual
// extension STARVES the spine (§8.4), retry the bare spine before giving up.
// ---------------------------------------------------------------------------
async function planTargeted(sess, P, snap, pre, opts = {}) {
    // opts.escalate (§6 anti-fixation): ignore the user list AND per-goal
    // budgets — auto-rank the blocked frontier and go all-in on the escape
    // target for this one round.
    let goals = (opts.escalate || P.autoRankTargets)
        ? autoRankGoals(pre, P.know, sess, P.thresholds)
        : ((P.targets && P.targets.length) ? P.targets
           : (P.targetAction ? [{ kind: "a", action: P.targetAction }] : []));
    // drop kind-b goals whose target value V is already reached — the
    // across-rounds stop condition (§3.2); advance to the next priority.
    goals = goals.filter(g => g.kind !== "b" || readStateValue(pre, g.target) < (g.value ?? Infinity));
    if (!goals.length) return null;
    const assembled = assembleTargetedQueue(pre, P.know, sess, goals, P.thresholds,
        { multiTown: P.multiTown, capacityHint: P.prevTimeNeeded });
    if (!assembled) return null;
    const g = assembled.spineGoal;
    const achieves = (post, r) => g.kind === "a"
        ? execCountOf(r, g.action) > 0
        : readStateValue(post, g.target) > readStateValue(pre, g.target);
    const install = (q, label) => {
        sess.restore(snap);
        const conf = confirmCandidate(sess, snap, q, P.know, P.multiTown);
        sess.restore(snap);
        if (conf.degenerate || !achieves(conf.post, conf.r)) return null;
        const { score, parts } = scoreOutcome(pre, conf.post, P.thresholds, conf.r,
            P.prevTimeNeeded, P.know, P.weights, conf.capacity,
            { probeTicks: conf.probeTicks, prevProbeTicks: P.prevProbeTicks });
        const c = { label, q, goal: g };
        const best = { c, r: conf.r, post: conf.post, score, parts, postSnap: conf.postSnap,
                       capacity: conf.capacity, probeTicks: conf.probeTicks, nCands: 1, nScreened: 1 };
        return { best, snap, pre, nCands: 1, nScreened: 1,
                 evals: [{ label, score: Math.round(score * 10) / 10, parts }] };
    };
    // full assembly first; if the residual layers starved the spine, retry the
    // bare spine (the budget caps FILL — the cushion still decides feasibility).
    return install(assembled.q, assembled.label)
        ?? (assembled.bareQ.length !== assembled.q.length ? install(assembled.bareQ, assembled.label) : null);
}

// Anti-fixation counters (§6): the committed-queue identity STREAK and the
// no-new-action-availability DROUGHT, tracked on P (NOT serialized — a
// within-run mechanism like `perf`). Updated after each round's `best`; the
// trigger reads them at the START of the next round. Separation data (all 11
// bank-sweep traces): healthy max streak 16 / drought 135; the bank:20 hole
// 617 — so K=32 / D=256 are byte-inert by margin (the counters never reach
// them on a healthy run).
function updateStagnation(P, best, escalated) {
    const key = (q) => JSON.stringify(q ?? []);
    P.streak = (P.lastCommitted != null && key(best.c.q) === key(P.lastCommitted)) ? (P.streak ?? 0) + 1 : 0;
    // K backoff: an escalation round that RE-COMMITS the same queue (the escape
    // didn't take) doubles K so the guard fires less often. Sticky.
    if (escalated && P.streak > 0) P.antiFixK = (P.antiFixK ?? 32) * 2;
    // drought: rounds since ANY action gained visibility/unlock (measures real
    // progress, not queue churn)
    P.seenAvail = P.seenAvail ?? new Set();
    let fresh = false;
    for (const a of best.post.actions) {
        const k = `${a.name}:${a.visible ? (a.unlocked ? 2 : 1) : 0}`;
        if ((a.visible || a.unlocked) && !P.seenAvail.has(k)) { P.seenAvail.add(k); fresh = true; }
    }
    P.drought = fresh ? 0 : (P.drought ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// One planning round: from the CURRENT sim state, produce the best queue for
// the next loop. `P` is the persistent planning state (knowledge, thresholds,
// last committed queue, ...) owned by the caller (worker or standalone run).
// ---------------------------------------------------------------------------
async function planRound(sess, P) {
    P.loop = (P.loop ?? 0) + 1;
    // Wall-time observability per phase (behavior-inert: clock reads only,
    // nothing feeds back into planning). Not serialized in planning state;
    // a resumed run starts fresh accumulators.
    const perf = P.perf ?? (P.perf = { probe: 0, know: 0, gen: 0, screen: 0, confirm: 0, score: 0, rounds: 0 });
    perf.rounds++;
    let tPhase = Date.now();
    const pre = P.pre ?? sess.read();
    if (P.prevTimeNeeded == null) P.prevTimeNeeded = pre.baseMana;
    const snap = sess.save();
    if ((P.loop - 1) % (P.probeEvery ?? 1) === 0) P.thresholds = sess.probe();
    perf.probe += Date.now() - tPhase; tPhase = Date.now();
    await refreshKnowledge(sess, snap, pre, P.know, {
        seedFromPredictor: P.seedFromPredictor, divergenceLog: P.divergenceLog,
        multiTown: P.multiTown, vocabulary: P.vocabulary,
    });
    sess.restore(snap);
    perf.know += Date.now() - tPhase; tPhase = Date.now();

    // §6 anti-fixation escalation: when the HEURISTIC has stalled — the same
    // queue committed K rounds running, or D rounds with no new action becoming
    // available — auto-enter ONE all-in targeted round toward the blocked
    // frontier, then return to the scorer. Option-gated (plannerAntiFixation)
    // and byte-inert by margin at defaults (healthy streak ≤16 < K 32; guard
    // off). A failed escalation doubles K (updateStagnation).
    const escalate = P.antiFixation && P.strategy !== "targeted"
        && ((P.streak ?? 0) >= (P.antiFixK ?? 32) || (P.drought ?? 0) >= (P.droughtLimit ?? 256));

    // Targeted strategy (or an escalation round): goal-directed regression
    // first; a successful install returns straight away. Falling through to the
    // heuristic scorer is ruling 1's full fallback — byte-inert at the default
    // "heuristic" strategy with the guard off (branch never taken).
    if (P.strategy === "targeted" || escalate) {
        const t = await planTargeted(sess, P, snap, pre, { escalate });
        perf.gen += Date.now() - tPhase; tPhase = Date.now();
        if (t) { updateStagnation(P, t.best, escalate); return t; }
        sess.restore(snap);
    }

    const cands = generateCandidates(pre, P.know, P.thresholds, sess, P.lastCommitted,
        { multiTown: P.multiTown, capacityHint: P.prevTimeNeeded });
    if (!cands.length) throw new Error(`loop ${P.loop}: no candidates`);
    sess.restore(snap);
    perf.gen += Date.now() - tPhase; tPhase = Date.now();
    const screened = await screenCandidates(sess, snap, cands, P.screenK ?? 8, P.screenMode ?? "predictor");
    perf.screen += Date.now() - tPhase; tPhase = Date.now();

    let best = null;
    const evals = [];
    // Confirm all screened candidates, then score. The two phases are
    // separable because scoreOutcome is pure in the sim (state-object
    // arithmetic only), which is also what lets an eval pool run the
    // confirms in parallel contexts. Serial confirms are the reference
    // path and byte-identical to the historical interleaved loop.
    let confirms;
    if (plEvalPool) {
        const knowSer = [...P.know.entries()];
        confirms = await plEvalPool(screened.map(c => ({
            kind: "confirm", save: snap.save, rng: snap.rng, q: c.q, know: knowSer, multiTown: P.multiTown,
        })));
    } else {
        confirms = screened.map(c => confirmCandidate(sess, snap, c.q, P.know, P.multiTown));
    }
    perf.confirm += Date.now() - tPhase; tPhase = Date.now();
    for (let i = 0; i < screened.length; i++) {
        const c = screened[i], conf = confirms[i];
        if (conf.degenerate) { evals.push({ label: c.label, score: null }); continue; }
        const { score, parts } = scoreOutcome(pre, conf.post, P.thresholds, conf.r, P.prevTimeNeeded, P.know, P.weights, conf.capacity,
            { probeTicks: conf.probeTicks, prevProbeTicks: P.prevProbeTicks });
        evals.push({ label: c.label, score: Math.round(score * 10) / 10, capacity: conf.capacity,
                     probeTicks: conf.probeTicks, parts });
        const rec = { c, r: conf.r, post: conf.post, score, parts, postSnap: conf.postSnap,
                      capacity: conf.capacity, probeTicks: conf.probeTicks };
        if (!best || score > best.score) best = rec;
    }
    if (!best) throw new Error(`loop ${P.loop}: all candidates degenerate`);
    perf.score += Date.now() - tPhase;
    updateStagnation(P, best, escalate);
    // restore the pre-round state; the CALLER decides how to commit (the
    // standalone driver restores best.postSnap; the live game plays the queue)
    sess.restore(snap);
    return { best, snap, pre, nCands: cands.length, nScreened: screened.length, evals };
}

// §11.7 Design B (live no-pause pipelining): plan from the state the live game
// will be in AFTER it finishes the current window of committed loops, so the
// fresh plan is ready to install at that boundary with no pause. Simulates the
// committed queue `replanEvery` loops forward from the restored state (the game
// plays this same queue for that window), captures the predicted boundary hash,
// then plans from there. The live game installs the returned queue at the next
// boundary only if boundaryHash still matches — determinism makes them equal
// whenever the window ran the same queue with no reward-path RNG divergence.
// replanEvery<=1 looks one boundary ahead (the base Design B case).
async function planPipeline(sess, P, committedQueue, replanEvery = 1) {
    const K = Math.max(1, replanEvery | 0);
    for (let i = 0; i < K; i++) {
        sess.setQueue(committedQueue);
        sess.restart();
        sess.runLoop();
    }
    const predictedHash = boundaryHash();   // digest of the current (predicted) state
    P.pre = null;                 // plan from the advanced (predicted) state
    const res = await planRound(sess, P);
    return { ...res, boundaryHash: predictedHash };
}

// ---- planning-state serialization (snapshot-start iteration) --------------
// Everything planRound accumulates across loops, JSON-safe (the knowledge
// Map flattens to entries; JS numbers round-trip JSON exactly). Weights and
// knobs are deliberately NOT serialized — the resuming caller's own params
// win, which is the point: iterate on scorer/weights from a saved wall
// state without replaying hundreds of loops. Measurement is deterministic
// given state, so a carried knowledge table is exactly what a continuous
// run would hold (staleness re-measures on the normal cadence).
function serializePlanningState(P) {
    return {
        loop: P.loop,
        prevTimeNeeded: P.prevTimeNeeded,
        prevProbeTicks: P.prevProbeTicks ?? null,
        lastCommitted: P.lastCommitted,
        thresholds: P.thresholds,
        pre: P.pre,
        know: [...P.know.entries()],
    };
}
function restorePlanningState(P, s) {
    P.loop = s.loop ?? 0;
    P.prevTimeNeeded = s.prevTimeNeeded ?? null;
    P.prevProbeTicks = s.prevProbeTicks ?? null;
    P.lastCommitted = s.lastCommitted ?? null;
    P.thresholds = s.thresholds ?? {};
    P.pre = s.pre ?? null;
    P.know = new Map(s.know ?? []);
}

function newPlanningState(opts = {}) {
    return {
        know: new Map(),
        lastCommitted: null,
        prevTimeNeeded: null,
        prevProbeTicks: null,
        thresholds: {},
        pre: null,
        loop: 0,
        weights: opts.weights ?? { ...DEFAULT_WEIGHTS },
        screenK: opts.screenK ?? 8,
        screenMode: opts.screenMode ?? "predictor",
        probeEvery: opts.probeEvery ?? 1,
        seedFromPredictor: opts.seedFromPredictor ?? false,
        multiTown: opts.multiTown ?? true,
        // "empirical" (default, byte-exact) | "informed" (gate-metadata setup
        // prefixes; §11.8 piece 2). Not serialized — the resuming caller's
        // param wins, like weights/screenMode.
        vocabulary: opts.vocabulary ?? "empirical",
        // "heuristic" (default, byte-exact scorer) | "targeted" (§11.10 goal
        // regression). Orthogonal to plannerMode's display-vs-install axis
        // (§7 Option X). Not serialized — the resuming caller's param wins.
        strategy: opts.strategy ?? "heuristic",
        // T1 headless single-goal driver (--target-action); T3 the user priority
        // list. `targets` = [{kind,action?|target?,value?,budget?}]. autoRank
        // (ruling 2) ignores the list and enumerates the travel frontier.
        targetAction: opts.targetAction ?? null,
        targets: opts.targets ?? [],
        autoRankTargets: opts.autoRankTargets ?? false,
        // §6 stagnation trigger (auto-enter a targeted escalation round from the
        // heuristic when the queue fixates). Default off; counters live below.
        antiFixation: opts.antiFixation ?? false,
        streak: 0, drought: 0, antiFixK: 32, droughtLimit: 256, seenAvail: new Set(),
        divergenceLog: [],
    };
}

// ---------------------------------------------------------------------------
// Standalone driver: plays the whole game headlessly (stats harness / tests).
// Same commit semantics as the v0 experiments harness (restore the winner's
// post-loop snapshot) so results are directly comparable.
// ---------------------------------------------------------------------------
async function runStandalone({ maxLoops = 1200, weights, screenK = 8, screenMode = "predictor",
                               probeEvery = 1,
                               seedFromPredictor = false, multiTown = true, vocabulary = "empirical",
                               strategy = "heuristic", targetAction = null, targets = [], autoRankTargets = false,
                               antiFixation = false,
                               replanEvery = 1,
                               targetTown = 1,
                               verbose = false, onLoop = null, resume = null } = {}) {
    const t0 = Date.now();
    const sess = new Session();
    const P = newPlanningState({ weights, screenK, screenMode, probeEvery, seedFromPredictor, multiTown, vocabulary,
                                 strategy, targetAction, targets, autoRankTargets, antiFixation });
    const trace = [];
    const milestones = {};
    let cumTicks = 0;
    if (resume) {
        // Snapshot-start: continue from a prior run's end state (its last
        // committed postSnap). A continuous run reaches each planning round
        // with per-loop state normalized by the last eval loop's restart()
        // (resources reset, suppliesCost initialized — the §10a.8 gotcha);
        // a fresh context has none of that, so restart() once against the
        // save's own restored queue to match. maxLoops stays TOTAL loops
        // (P.loop resumes where the donor run stopped).
        plRestoreSave(resume.save);
        rngHooks.set(resume.rng ?? null);
        restorePlanningState(P, resume.planning ?? {});
        if (actions.next.length) sess.restart();
        P.pre = P.pre ?? sess.read();
    } else {
        P.pre = sess.read();
    }

    while (P.loop < maxLoops) {
        const { best, pre } = await planRound(sess, P);

        // commit the winner
        sess.restore(best.postSnap);
        cumTicks += best.r.ticks;
        P.prevTimeNeeded = best.capacity;
        P.prevProbeTicks = best.probeTicks;
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

        // §11.7 reuse: replay the winning queue for the rest of the window
        // (plannerReplanEvery>1) before planning again. Each replay is ONE cheap
        // runLoop, versus a full planRound whose Koviko screen alone is ~80–93%
        // of planning wall time — so K>1 trades loop-count optimality for
        // wall-clock. replanEvery<=1 skips this loop entirely (byte-exact today).
        for (let k = 1; k < replanEvery && P.loop < maxLoops; k++) {
            const rpre = P.pre;
            sess.setQueue(best.c.q);
            sess.restart();
            const r = sess.runLoop();
            P.loop++;
            cumTicks += r.ticks;
            const post = sess.read();
            const preAvail = new Map(rpre.actions.map(a => [a.name, a.visible ? (a.unlocked ? 2 : 1) : 0]));
            for (const a of post.actions) {
                const before = preAvail.get(a.name) ?? 0;
                const now = a.visible ? (a.unlocked ? 2 : 1) : 0;
                if (now > before) {
                    const key = `${a.name}:${now === 2 ? "unlocked" : "visible"}`;
                    if (!(key in milestones)) milestones[key] = { loop: P.loop, cumTicks };
                }
            }
            for (const t of post.townsUnlocked) {
                if (!rpre.townsUnlocked.includes(t)) milestones[`town${t}`] = { loop: P.loop, cumTicks };
            }
            trace.push({
                loop: P.loop, ticks: r.ticks, cumTicks,
                label: best.c.label, score: null, parts: {},
                mana: r.lastTimeNeeded, nCands: 0, nScreened: 0,
                queue: best.c.q.map(([n, l]) => `${n} x${l}`).join(", "), reused: true,
            });
            if (verbose && (P.loop % 25 === 0 || post.townsUnlocked.length > rpre.townsUnlocked.length))
                console.log(`  L${String(P.loop).padStart(4)} [${best.c.label}] ticks=${r.ticks} mana=${r.lastTimeNeeded} (reuse)`);
            if (onLoop) onLoop(trace[trace.length - 1]);
            P.pre = post;
            if (post.townsUnlocked.includes(targetTown)) break;
        }
        if (P.pre.townsUnlocked.includes(targetTown)) break;
    }

    return {
        weights: P.weights, loopsRun: trace.length, cumTicks,
        finished: P.pre.townsUnlocked.includes(targetTown),
        milestones, trace,
        perf: P.perf ?? null,
        divergences: P.divergenceLog,
        finalSnapshot: plSnapshot(),
        wallSeconds: (Date.now() - t0) / 1000,
        // resume blob: feed back via runStandalone({resume}) to continue
        // this run (snapshot-start iteration)
        resume: { save: plSaveClone(), rng: rngHooks.get(), planning: serializePlanningState(P) },
    };
}

// ---------------------------------------------------------------------------
// Buy Mana / zone-1 economy optimiser (assist tool; §11.6 ladder, user scope
// 2026-07-13). Pure (sess, snap, queue[[name,loops]]) -> {queue, report}.
// NEVER runs in the reference path — an opt-in assist over the PLAYER's live
// queue, so it is byte-inert against the frozen acceptance gate by
// construction. It optimises the town-0 mana<->gold economy:
//   REORDER  gold batches before each conversion;
//   REMOVE   redundant / thin (<=overhead) Buy Mana conversions;
//   INSERT / SPLIT a gold harvest to add an INTERMEDIATE conversion when the
//            loop budget would otherwise starve the harvest;
//   MERGE    unnecessarily-split entries (output is coalesced);
//   RESERVE  gold for downstream purchases (a starved purchase is a throughput
//            failure, so the tool keeps its gold and converts only the excess).
// The engine rollout is the oracle, so ordering constraints (travel terminal,
// funding order) are enforced IMPLICITLY: a mis-ordered action lands in the
// wrong town / can't start -> unmet reps -> the move is rejected.
//
// Objective (mana units), lexicographic minimise:
//   (1) unmet reps of every NON-converter queued action (throughput);
//   (2) unconvertedGold*rate + converter mana spent (overhead).
// Best-improvement hill climb (deterministic: lexicographically-min neighbour,
// ties by generation order).
function classifyEconomy(p) {
    if (!p || p.exec === 0) return "other";
    if (p.manaPerGold > 0) return "converter";
    if ((p.goldPerExec ?? 0) < 0) return "purchase";              // gold sink
    if ((p.goldPerExec ?? 0) > 0) return "goldGen";
    if ((p.manaPerExec ?? 0) > (p.ticksPerExec ?? 0)) return "manaGen";
    return "other";
}
// Measure the queue's distinct actions (+ enough to detect a converter) into
// `know`, applying the same converter post-detection refreshKnowledge uses.
function economyProfiles(sess, snap, state, names, know) {
    const byName = new Map(state.actions.map(a => [a.name, a]));
    const baselineCache = new Map();
    for (const name of names) {
        if (know.has(name)) continue;
        const a = byName.get(name);
        if (!a) continue;
        sess.restore(snap);
        const needs = sess.needs(name);
        measureAction(sess, snap, state, know, a, needs, { baselineCache, multiTown: false });
        const pf = know.get(name);
        if (pf && pf.exec > 0 && pf.manaPerExec > 0 && pf.goldPerExec < 0)
            pf.manaPerGold = pf.manaPerExec / (-pf.goldPerExec);
    }
}
function optimizeEconomy(sess, snap, queue, opts = {}) {
    const know = opts.know ?? new Map();
    sess.restore(snap);
    const state = sess.read();
    const queued = queue.map(([n, l]) => [n, l]);

    // classify the queued actions; detect a converter to insert (queue's own
    // converter, else the best unlocked gold->mana action — measure the small
    // set of unlocked goldCost purchases/converters to find it).
    economyProfiles(sess, snap, state, [...new Set(queued.map(([n]) => n))], know);
    const kindOf = (name) => classifyEconomy(know.get(name));
    let convName = queued.map(([n]) => n).find(n => kindOf(n) === "converter") ?? null;
    if (!convName) {
        const cand = state.actions.filter(a => a.unlocked && a.goldCost > 0).map(a => a.name);
        economyProfiles(sess, snap, state, cand, know);
        const c = converterOf(state, know);
        if (c) convName = c.name;
    }
    const rate = (convName && know.get(convName)?.manaPerGold) || 50;

    const rollout = (q) => { sess.restore(snap); sess.setQueue(q); sess.restart(); return sess.runLoop(); };
    const readout = (r) => {
        let failed = 0, convExecs = 0, convMana = 0;
        for (const e of r.lastExec ?? []) {
            if (kindOf(e.name) === "converter") { convExecs += e.loops - e.loopsLeft; convMana += e.manaUsed ?? 0; }
            else failed += Math.max(0, e.loopsLeft);
        }
        const unconvGold = Math.max(0, r.lastResources?.gold ?? 0);
        return { failed, convExecs, unconvGold, econ: unconvGold * rate + convMana };
    };
    const cmp = (a, b) => (a.failed - b.failed) || (a.econ - b.econ);
    const coalesce = (q) => { const o = []; for (const [n, l] of q) { const p = o[o.length - 1]; if (p && p[0] === n) p[1] += l; else o.push([n, l]); } return o; };

    function* neighbours(q) {
        const n = q.length;
        for (let i = 0; i < n; i++) for (let j = 0; j <= n; j++) {
            if (j === i || j === i + 1) continue;
            const c = q.map(e => e.slice()); const [e] = c.splice(i, 1); c.splice(j > i ? j - 1 : j, 0, e); yield c;
        }
        for (let i = 0; i + 1 < n; i++) { const c = q.map(e => e.slice()); [c[i], c[i + 1]] = [c[i + 1], c[i]]; yield c; }
        for (let i = 0; i < n; i++) if (kindOf(q[i][0]) === "converter") {
            const c = q.map(e => e.slice()); if (c[i][1] > 1) c[i][1] -= 1; else c.splice(i, 1); yield c;
        }
        if (convName) {
            for (let j = 0; j <= n; j++) { const c = q.map(e => e.slice()); c.splice(j, 0, [convName, 1]); yield c; }
            for (let i = 0; i < n; i++) if (kindOf(q[i][0]) === "goldGen") {
                const [name, loops] = q[i];
                for (let k = 1; k < loops; k++) { const c = q.map(e => e.slice()); c.splice(i, 1, [name, k], [convName, 1], [name, loops - k]); yield c; }
            }
        }
    }

    let cur = coalesce(queued.map(e => e.slice()));
    let curW = readout(rollout(cur));
    const before = { ...curW };
    const maxMoves = opts.maxMoves ?? 40;
    let moves = 0, evals = 1;
    while (moves < maxMoves) {
        let best = null, bestW = curW;
        for (const nb of neighbours(cur)) { evals++; const w = readout(rollout(nb)); if (cmp(w, bestW) < 0) { best = nb; bestW = w; } }
        if (!best) break;
        cur = coalesce(best); curW = readout(rollout(cur)); moves++;
    }
    return { queue: cur, report: { before, after: curW, moves, evals, converter: convName, rate } };
}

return {
    DEFAULT_WEIGHTS, MEASURE_MANA,
    Session, newPlanningState, planRound, planPipeline, runStandalone,
    boundaryHash,
    optimizeEconomy, classifyEconomy,
    serializePlanningState, restorePlanningState,
    setRngHooks, setEvalPool, confirmCandidate, evalLoopOnly,
    // exposed for tests and the automation controller
    emptyProfile, measureAction, refreshKnowledge, generateCandidates,
    buildEconomy, limitedPools, rankFrontierDims, grindActionFor,
    scoreOutcome, probeCapacity, screenCandidates,
    travelEdges, routeTo, buildPushes,
    // Layer P / metadata (vocabulary plan §2/§4)
    probeEdges, measureEdge, dimEffectsFor, contextFor,
    // targeted mode (§11.10)
    regressAction, regressTarget, generateTargeted, repSinkProvider,
    rankValueProviders, readStateValue, planTargeted,
    assembleTargetedQueue, heuristicGrindTail, autoRankGoals, updateStagnation,
    _internals: { plReadState, plProbeThresholds, plProbeCanStartNeeds, plSaveClone,
                  plRestoreSave, plRunOneLoopChunk, plInjectResources, plSnapshot,
                  plSetQueue, plGetQueue, plPredictQueue },
};
})();
