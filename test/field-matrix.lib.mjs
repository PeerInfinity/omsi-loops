// test/field-matrix.lib.mjs — Tier-1 declarative-field equivalence matrix
// (XML migration plan §4 Phase 3).
//
// Builds a deterministic state corpus and records, for every action and every
// state, the values of the declarative fields the XML will eventually model:
//   manaCost, goldCost, visible, unlocked, canStart, allowed, storyReqs(1..8).
// These are pure functions of game state (verified: zero Math.random across
// the whole matrix — the build asserts it), so the matrix is exact and needs
// no seeding or tolerance. Phase 4's JS-vs-XML differential replays the same
// corpus with === comparison; this golden pins the JS oracle itself against
// drift in the meantime.
//
// Corpus strata (all deterministic):
//   boot        — the harness boot state (loadDefaults + stonesUsed + [0]);
//   all-zero    — every probe dim at zero;
//   all-max     — every probe dim at max (skill 2000, buffs at buffHardCaps,
//                 storyMax 20, every storyFlag + prestige on);
//   thresholds  — for each (dim, level) found by perturbation probing the
//                 157×2 visible()/unlocked() closures (pass A: single dim
//                 raised from all-zero, binary-searched; pass B: single dim
//                 lowered from all-max — catches conjunction floors), one
//                 state at level-1 and one at level, in both profiles; plus
//                 the boolean dims that flip a predicate in either profile;
//   random      — seeded mulberry32 sweep states that additionally randomize
//                 resources (reputation goes negative), town ledger vars
//                 (total ≥ checked ≥ good ≥ goodTemp), stonesUsed,
//                 goldInvested (threshold-aware: 1e6 / 1e9 / 999999999999 are
//                 storyReqs breakpoints), trainingLimits and townsUnlocked;
//   fixtures    — the ui-parity mid/deep crafted saves, round-tripped through
//                 the real load(false, saveJson) in a fresh context each.
//
// The perturbation prober is adapted from the unlock-discretization prototype
// (NewDocs/plans/omsiloops/experiments/unlock-extract-probe.mjs, 2026-07-11).
// Here we only need the threshold VALUES for corpus placement, not clause
// semantics, so the sum/survey disambiguation passes are deliberately absent.

import crypto from "node:crypto";
import { makeContext } from "./harness.mjs";

export const FIELD_COLUMNS = ["manaCost", "goldCost", "visible", "unlocked", "canStart", "allowed", "storyReqs1to8"];

const FM_INSTALL = `
globalThis.__fm = (() => {
    // ---- probe dims (adapted from the unlock-extract prototype) ----
    const numericDims = [];   // {kind, town?, v, max}
    for (const t of towns) {
        for (const v of t.progressVars) {
            if (v.startsWith("SurveyZ")) numericDims.push({ kind: "surveyLevel", town: t.index, v, max: 100 });
            else numericDims.push({ kind: "townLevel", town: t.index, v, max: 100 });
        }
    }
    for (const s in skills) numericDims.push({ kind: "skillLevel", v: s, max: 2000 });
    // probe bound must come from the game's own caps (Imbue Soul unlocks at
    // Imbuement/Imbuement2 > 499 — a fixed 100 hides it)
    for (const b in buffs) numericDims.push({ kind: "buffLevel", v: b, max: buffHardCaps[b] ?? 1000 });
    numericDims.push({ kind: "storyMax", v: "storyMax", max: 20 });
    // derived dim: sets all 9 Survey vars evenly — getExploreProgress() is
    // floor(mean of survey levels), so no single survey dim can cross
    // aggregate thresholds like Open Portal's ep >= 75
    numericDims.push({ kind: "exploreProgress", v: "exploreProgress", max: 100 });
    const boolDims = [{ kind: "prestige", v: "completedAnyPrestige" }];
    for (const f in storyFlags) boolDims.push({ kind: "storyFlag", v: f });

    const expOf = (town, v, L) =>
        towns[town].progressScaling[v] === "linear" ? 5050 * L : 100 * L * (L + 1) / 2;
    const set = (d, L) => {
        if (d.kind === "townLevel") towns[d.town]["exp" + d.v] = expOf(d.town, d.v, L);
        else if (d.kind === "surveyLevel") towns[d.town]["exp" + d.v] = expOf(d.town, "Survey", L);
        else if (d.kind === "skillLevel") skills[d.v].levelExp.level = L;
        else if (d.kind === "buffLevel") buffs[d.v].amt = L;
        else if (d.kind === "storyMax") storyMax = L;
        else if (d.kind === "exploreProgress")
            for (const t of towns) t["expSurveyZ" + t.index] = expOf(t.index, "Survey", L);
    };
    const setBool = (d, on) => {
        if (d.kind === "prestige") prestigeValues.completedAnyPrestige = on;
        else storyFlags[d.v] = on;
    };
    const zeroAll = () => {
        for (const d of numericDims) set(d, 0);
        for (const d of boolDims) setBool(d, false);
    };
    const maxAll = () => {
        for (const d of numericDims) set(d, d.max);
        for (const d of boolDims) setBool(d, true);
    };

    // ---- extra state surface beyond the probe dims (reset per state) ----
    const bootResources = structuredClone(resources);
    const bootTowns = towns.map(t => {
        const o = {};
        for (const v of t.allVarNames)
            for (const p of ["exp", "checked", "good", "goodTemp", "total"]) {
                const k = p + v;
                if (typeof t[k] === "number") o[k] = t[k];
            }
        return o;
    });
    const bootStones = structuredClone(stonesUsed);
    const bootGoldInvested = goldInvested, bootTrainingLimits = trainingLimits;
    const resetExtras = () => {
        for (const k in resources) delete resources[k];
        Object.assign(resources, structuredClone(bootResources));
        towns.forEach((t, i) => Object.assign(t, bootTowns[i]));
        stonesUsed = structuredClone(bootStones);
        goldInvested = bootGoldInvested;
        trainingLimits = bootTrainingLimits;
        townsUnlocked = [0];
    };

    // ---- predicates for threshold probing ----
    const preds = [];
    for (const t of towns) for (const a of t.totalActionList) {
        preds.push({ fn: () => a.visible() });
        preds.push({ fn: () => a.unlocked() });
    }
    const T = (p) => { try { return !!p.fn(); } catch (e) { return false; } };

    const bisect = (d, lo, hi, wantPassAt) => {
        // smallest L in (lo, hi] with pred === wantPassAt(true) when raised
        while (lo + 1 < hi) {
            const mid = Math.floor((lo + hi) / 2);
            set(d, mid);
            if (wantPassAt()) hi = mid; else lo = mid;
        }
        return hi;
    };

    const collectThresholds = () => {
        let evals = 0;
        const TT = (p) => { evals++; return T(p); };
        const zero = new Map(), max = new Map(), zeroBools = new Set(), maxBools = new Set();
        for (const p of preds) {
            zeroAll();
            if (!TT(p)) {
                for (let i = 0; i < numericDims.length; i++) {
                    const d = numericDims[i];
                    set(d, d.max);
                    if (TT(p)) {
                        const h = bisect(d, 0, d.max, () => TT(p));
                        const s = zero.get(i); if (s) s.add(h); else zero.set(i, new Set([h]));
                    }
                    set(d, 0);
                }
                for (let i = 0; i < boolDims.length; i++) {
                    setBool(boolDims[i], true);
                    if (TT(p)) zeroBools.add(i);
                    setBool(boolDims[i], false);
                }
            }
            maxAll();
            if (TT(p)) {
                for (let i = 0; i < numericDims.length; i++) {
                    const d = numericDims[i];
                    set(d, 0);
                    if (!TT(p)) {
                        const h = bisect(d, 0, d.max, () => TT(p));
                        const s = max.get(i); if (s) s.add(h); else max.set(i, new Set([h]));
                    }
                    set(d, d.max);
                }
                for (let i = 0; i < boolDims.length; i++) {
                    setBool(boolDims[i], false);
                    if (!TT(p)) maxBools.add(i);
                    setBool(boolDims[i], true);
                }
            }
        }
        zeroAll();
        const flat = (m) => [...m.entries()].map(([d, s]) => [d, [...s].sort((a, b) => a - b)]);
        return { zero: flat(zero), max: flat(max), zeroBools: [...zeroBools], maxBools: [...maxBools], evals };
    };

    // ---- field evaluation ----
    const norm = (v) => {
        if (v === undefined) return null;
        if (typeof v === "number" && !isFinite(v)) return "num:" + String(v);
        if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
        return "val:" + String(v);
    };
    const evalFields = () => {
        const out = [];
        for (const t of towns) for (const a of t.totalActionList) {
            const call = (fn) => {
                if (typeof fn !== "function") return null;
                try { return norm(fn.call(a)); } catch (e) { return "throws:" + e.message; }
            };
            const row = [a.name, call(a.manaCost), call(a.goldCost), call(a.visible),
                call(a.unlocked), call(a.canStart), call(a.allowed)];
            if (typeof a.storyReqs === "function") {
                const sr = [];
                for (let n = 1; n <= 8; n++) {
                    try { sr.push(norm(a.storyReqs(n))); } catch (e) { sr.push("throws:" + e.message); }
                }
                row.push(sr);
            } else row.push(null);
            out.push(row);
        }
        return out;
    };

    // ---- state application ----
    // spec: { profile: "boot"|"zero"|"max", dims: [[i, L]...], bools: [[i, on]...], random: seed|null }
    let rs = 0;
    const rnd = () => { rs |= 0; rs = rs + 0x6D2B79F5 | 0; let t = Math.imul(rs ^ rs >>> 15, 1 | rs); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const applyState = (spec) => {
        resetExtras();
        if (spec.profile === "zero") zeroAll();
        else if (spec.profile === "max") maxAll();
        else { zeroAll(); }   // "boot": dims zeroed, extras at boot defaults
        for (const [i, L] of spec.dims ?? []) set(numericDims[i], L);
        for (const [i, on] of spec.bools ?? []) setBool(boolDims[i], on);
        if (spec.random != null) {
            rs = spec.random >>> 0;
            for (const d of numericDims) {
                if (d.kind === "exploreProgress") continue;   // derived — surveys already randomized
                const r = rnd();
                const L = r < 0.35 ? 0 : r < 0.75 ? Math.floor(rnd() * 41) : Math.floor(rnd() * (d.max + 1));
                set(d, L);
            }
            for (const d of boolDims) setBool(d, rnd() < 0.12);
            for (const k of Object.keys(resources).sort()) {
                const v = resources[k];
                if (typeof v === "boolean") resources[k] = rnd() < 0.15;
                else if (k === "reputation") resources[k] = Math.floor(rnd() * 21) - 10;
                else if (k === "gold") resources[k] = rnd() < 0.3 ? 0 : Math.floor(rnd() * 100000);
                else if (typeof v === "number") resources[k] = rnd() < 0.3 ? 0 : Math.floor(rnd() * 1000);
            }
            for (const t of towns) for (const v of t.allVarNames) {
                if (typeof t["total" + v] !== "number" || rnd() >= 0.3) continue;
                const total = Math.floor(rnd() * 500);
                const checked = Math.floor(rnd() * (total + 1));
                const good = Math.floor(rnd() * (Math.floor(total / 10) + 1));
                t["total" + v] = total; t["checked" + v] = checked;
                t["good" + v] = good; t["goodTemp" + v] = Math.floor(rnd() * (good + 1));
            }
            for (const k of Object.keys(stonesUsed)) stonesUsed[k] = Math.floor(rnd() * 3);
            const gi = [0, 999999, 1000000, 999999999, 1000000000, 999999999999];
            goldInvested = gi[Math.floor(rnd() * gi.length)];
            trainingLimits = Math.floor(rnd() * 31);
            townsUnlocked = Array.from({ length: 1 + Math.floor(rnd() * 9) }, (_, i) => i);
        }
        return JSON.stringify(evalFields());
    };

    const dimName = (i) => { const d = numericDims[i]; return d.kind + ":" + (d.town ?? "") + ":" + d.v; };
    const boolName = (i) => { const d = boolDims[i]; return d.kind + ":" + d.v; };
    return {
        nNumeric: numericDims.length, nBool: boolDims.length, nPreds: preds.length,
        maxOf: (i) => numericDims[i].max,
        collectThresholds, applyState, evalFields, dimName, boolName,
    };
})();
`;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

// The ui-parity fixture recipes (CC/scripts/omsi-parity/run-ui-parity.mjs) —
// kept textually identical so the two harnesses stay in sync.
export const FIXTURE_RECIPES = {
    mid: `
        cheatSkill("Magic", 20);
        cheatSkill("Combat", 20);
        towns[0].expWander = 505000;
        towns[0].expMet = 505000;
        towns[0].expSecrets = 505000;
    `,
    deep: `
        cheatSkill("Magic", 100);
        cheatSkill("Combat", 100);
        cheatSkill("Alchemy", 250);
        cheatSkill("Dark", 1200);
        cheatSkill("Mercantilism", 10);
        cheatSkill("Thievery", 5);
        cheatSkill("Pyromancy", 100);
        cheatSkill("Restoration", 1500);
        for (const action of totalActionList) {
            if (action.type === "progress") {
                towns[action.townNum]["exp" + action.varName] = 505000;
            }
        }
        townsUnlocked = [0, 1];
    `,
};

export function buildFieldMatrix({ randomStates = 64, perturb = null, only = null } = {}) {
    const ctx = makeContext(12345);
    ctx.ev(FM_INSTALL);
    const info = JSON.parse(ctx.ev("JSON.stringify({ n: __fm.nNumeric, b: __fm.nBool, p: __fm.nPreds })"));

    const th = JSON.parse(ctx.ev("JSON.stringify(__fm.collectThresholds())"));

    // ---- assemble the state list (order is part of the golden) ----
    const states = [];   // {id, spec}
    states.push({ id: "boot", spec: { profile: "boot" } });
    states.push({ id: "all-zero", spec: { profile: "zero" } });
    states.push({ id: "all-max", spec: { profile: "max" } });
    const dimName = (i) => ctx.ev(`__fm.dimName(${i})`);
    const boolName = (i) => ctx.ev(`__fm.boolName(${i})`);
    for (const [profile, list] of [["zero", th.zero], ["max", th.max]]) {
        for (const [i, levels] of list) {
            const name = dimName(i);
            for (const h of levels) {
                for (const L of h > 0 ? [h - 1, h] : [h]) {
                    states.push({ id: `${profile}:${name}@${L}`, spec: { profile, dims: [[i, L]] } });
                }
            }
        }
    }
    for (const i of th.zeroBools) states.push({ id: `zero:${boolName(i)}=on`, spec: { profile: "zero", bools: [[i, true]] } });
    for (const i of th.maxBools) states.push({ id: `max:${boolName(i)}=off`, spec: { profile: "max", bools: [[i, false]] } });
    for (let k = 0; k < randomStates; k++) {
        states.push({ id: `random:${k}`, spec: { profile: "zero", random: 0x51D0 + k * 7919 } });
    }

    // optional single-state perturbation (anti-vacuity self-check support)
    if (perturb) {
        const s = states.find(s => s.id === perturb.id);
        if (!s) throw new Error(`perturb target not found: ${perturb.id}`);
        s.spec = JSON.parse(JSON.stringify(s.spec));
        s.spec.dims = [...(s.spec.dims ?? []), [perturb.dim, perturb.level]];
    }

    const rngBefore = ctx.rngCount();
    const perState = [];
    let baseline = null;
    const selected = only ? states.filter(s => only.includes(s.id)) : states;
    for (const s of selected) {
        const json = ctx.ev(`__fm.applyState(${JSON.stringify(s.spec)})`);
        perState.push({ id: s.id, hash: sha(json) });
        if (s.id === "boot") baseline = JSON.parse(json);
    }

    // fixtures: crafted save round-tripped through the real load() in a fresh
    // context each (load() owns stonesUsed/townsUnlocked/loadouts init)
    for (const [name, recipe] of Object.entries(FIXTURE_RECIPES)) {
        if (only && !only.includes(`fixture:${name}`)) continue;
        const crafter = makeContext(12345);
        crafter.ev(recipe);
        const blob = crafter.ev("JSON.stringify(doSave())");
        const fixCtx = makeContext(12345);
        fixCtx.ev(FM_INSTALL);
        // DOM touches on the load() path: closeTutorial(), and doLoad WRITES
        // buff<name>Cap input values (inputElement type-checks the stub class).
        // Scoped to the load call — getElementById -> null is load-bearing
        // otherwise (see harness.mjs).
        fixCtx.ev(`
            closeTutorial = () => {};
            globalThis.window = globalThis;      // doLoad reads window.localStorage
            globalThis.loadChallenge = () => {}; // challenges.js is not a sim file; mode 0 is a no-op anyway
            recalcInterval = () => {};           // would start a real setInterval in the vm
            // In a real browser every UI element exists during load(); mirror
            // that with a permissive input stub, then restore the null stub
            // (null is load-bearing for tick-path search-toggle semantics).
            const __el = () => Object.assign(new HTMLInputElement(), {
                classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                style: {}, textContent: "", value: "", checked: false,
            });
            document.getElementById = () => __el();
            const __blob = JSON.parse(${JSON.stringify(blob)});
            __blob.date = new Date().toISOString();  // zero offline gain, deterministic fields
            load(false, JSON.stringify(__blob));
            document.getElementById = () => null;
        `);
        const json = fixCtx.ev("JSON.stringify(__fm.evalFields())");
        perState.push({ id: `fixture:${name}`, hash: sha(json) });
    }

    const rngConsumed = ctx.rngCount() - rngBefore;
    const matrixHash = sha(perState.map(s => `${s.id}=${s.hash}`).join("\n"));
    return {
        meta: {
            dims: { numeric: info.n, bool: info.b }, predicates: info.p,
            probeEvals: th.evals, states: perState.length, randomStates,
            fieldColumns: FIELD_COLUMNS,
        },
        perState, matrixHash, baseline, rngConsumed,
    };
}
