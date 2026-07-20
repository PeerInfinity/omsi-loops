// unlock-table.lib.mjs — shared machinery for the unlock table: build the
// table in-memory (test/unlock-table.test.mjs asserts it equals the committed
// data/unlockTable.json) and verify it against the live JS closures.
//
// The generator that WRITES the golden is test/regen-unlock-table.mjs; it is
// deliberately not a *.test.mjs so `npm test` can never rewrite a golden.
//
// Division of labour, and why it is split this way:
//   - unlocks.js owns the WALK (XML -> rows). One implementation, shared with
//     the runtime, so the shipped predicates and the committed table can never
//     drift apart.
//   - this file owns the MEASUREMENT (sweeping the live adjust*() curve) and
//     the VERIFICATION (rows vs the real closures). Those need a booted game;
//     the walk does not.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeContext, XML_SIM_FILES } from "./harness.mjs";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const TABLE_PATH = path.join(ROOT, "data", "unlockTable.json");

/** default step count per quantity var (plan §3.5: G = 8) */
export const GRANULARITY = 8;

/** A context with the XML stack + unlocks.js loaded, ready to walk and probe. */
export function makeUnlockContext(seed = 12345) {
    return makeContext(seed, [...XML_SIM_FILES, "unlocks.js"]);
}

/** the XML text the walk reads — file bytes; the carrier guard proves the
 *  shipped carrier matches these, so both derivations see identical input */
export function readXml() {
    return fs.readFileSync(path.join(ROOT, "data", "actionList.xml"), "utf8");
}

// ---------------------------------------------------------------------------
// Resolvers: identity + town lookups, taken from the live game objects
// ---------------------------------------------------------------------------
const INSTALL_RESOLVERS = `
globalThis.__ut = (() => {
    const byName = new Map();
    for (const a of totalActionList) byName.set(a.name, { varName: a.varName, town: a.townNum });
    const townOfProgressVar = (v, where) => {
        for (const t of towns) {
            // progressVars stores the SurveyZ<i> varName directly for surveys
            if (t.progressVars.includes(v)) return t.index;
        }
        throw new Error(where + ": no town owns progress var " + v);
    };
    return {
        actionMeta: (name) => byName.get(name),
        townOfProgressVar,
    };
})();
`;

/** Walk the XML into predicate rows, inside the vm (unlocks.js lives there). */
export function walkRows(ctx, xmlText) {
    ctx.ev(INSTALL_RESOLVERS);
    return JSON.parse(ctx.ev(
        `JSON.stringify(Unlocks.walkPredicates(${JSON.stringify(xmlText)}, __ut))`));
}

/** Walk the <totalDiscovered> provenance (dims + modifiers) for the 18 vars. */
export function walkQuantityDims(ctx, xmlText) {
    ctx.ev(INSTALL_RESOLVERS);
    return JSON.parse(ctx.ev(
        `JSON.stringify(Unlocks.walkQuantityDims(${JSON.stringify(xmlText)}, __ut))`));
}

// ---------------------------------------------------------------------------
// Quantity curves — measured off the LIVE adjust*() functions
// ---------------------------------------------------------------------------
// The XML's <totalDiscovered> is descriptive: the interpreter never compiles
// it, and driver.js adjustAll() stays the real implementation. So the table
// takes the DIM LIST from the XML and the NUMBERS from the running game, and
// hard-errors if the two disagree about which dims matter. Neither side can
// quietly drift: a re-implementation of the formula here would just be a
// second thing to keep in sync, which is the bug this arc exists to remove.
const INSTALL_SWEEP = `
globalThis.__uq = (() => {
    // town progress exp <-> level, matching Town.getLevel's two scalings
    const expOf = (townIdx, v, L) =>
        towns[townIdx].progressScaling[v] === "linear" ? 5050 * L : 100 * L * (L + 1) / 2;
    const setLevel = (townIdx, v, L) => { towns[townIdx]["exp" + v] = expOf(townIdx, v, L); };
    // every progress var in the game, as (town, varName) pairs
    const allDims = [];
    for (const t of towns) for (const v of t.progressVars) allDims.push({ town: t.index, v });
    const zeroProgress = () => { for (const d of allDims) setLevel(d.town, d.v, 0); };
    const totalOf = (town, action) => { adjustAll(); return towns[town]["total" + action]; };
    const townOf = (v) => { for (const t of towns) if (t.progressVars.includes(v)) return t.index; return -1; };
    return { setLevel, allDims, zeroProgress, totalOf, townOf };
})();
`;

/**
 * Measure one var's capacity curve by driving the real adjustAll().
 *
 * Baseline state: all progress at zero, no prestige, no Spatiomancy. The
 * boundaries are therefore a property of the PROGRESS curve alone; the
 * skillMod/surveyBonus modifiers only ever raise the live total, so under AP
 * they make a player cross the same boundaries earlier. That is vanilla
 * pacing (more Spatiomancy has always meant more capacity sooner), not a
 * distortion introduced here.
 */
export function measureQuantityCurves(ctx, quantityDims, granularity = GRANULARITY) {
    ctx.ev(INSTALL_SWEEP);
    const spec = quantityDims.map(q => ({ action: q.action, town: q.town, dims: q.dims }));
    return JSON.parse(ctx.ev(`
JSON.stringify((() => {
    const { setLevel, allDims, zeroProgress, totalOf, townOf } = __uq;
    const G = ${granularity};
    const out = [];
    for (const q of ${JSON.stringify(spec)}) {
        zeroProgress();
        const dimTowns = q.dims.map(v => ({ v, town: townOf(v) }));
        if (dimTowns.some(d => d.town < 0)) throw new Error("unlock-table: unknown progress var for " + q.action);

        // --- which dims does the live formula ACTUALLY respond to? ---
        // Probe from a MID baseline (the var's own dims at level 50), never
        // from all-zero: surveyBonus and the Spatiomancy skillMod are
        // multiplicative on the base amount, so at base = 0 they are
        // mathematically invisible and every survey dim reads as inert. Same
        // shape as the corpus rule the effect differential is built around —
        // a probe only separates what its baseline straddles.
        zeroProgress();
        for (const d of dimTowns) setLevel(d.town, d.v, 50);
        const base = totalOf(q.town, q.action);
        if (base <= 0) throw new Error("unlock-table: mid baseline is zero for " + q.action);
        const sensitive = [];
        for (const d of allDims) {
            const restore = dimTowns.some(x => x.v === d.v) ? 50 : 0;
            setLevel(d.town, d.v, 100);
            if (totalOf(q.town, q.action) !== base) sensitive.push(d.v);
            setLevel(d.town, d.v, restore);
        }
        // the declared non-progress modifier: Spatiomancy raises capacity for
        // every var whose <totalDiscovered> carries a <skillMod>, and for no
        // other. 2000 is the skill cap, above every var's skillMod window.
        const spatioBefore = getSkillLevel("Spatiomancy");
        skills.Spatiomancy.levelExp.level = 2000;
        const spatioSensitive = totalOf(q.town, q.action) !== base;
        skills.Spatiomancy.levelExp.level = spatioBefore;

        // --- sample the reachable range ---
        // axes + the diagonal; the formulas are monotone non-decreasing in
        // every dim, so the extremes are exact and the samples in between
        // only need to be representative of the shape.
        zeroProgress();
        const values = new Set();
        for (const d of dimTowns) {
            for (let L = 0; L <= 100; L++) {
                setLevel(d.town, d.v, L);
                values.add(totalOf(q.town, q.action));
            }
            setLevel(d.town, d.v, 0);
        }
        for (let L = 0; L <= 100; L++) {
            for (const d of dimTowns) setLevel(d.town, d.v, L);
            values.add(totalOf(q.town, q.action));
        }
        for (const d of dimTowns) setLevel(d.town, d.v, 100);
        const max = totalOf(q.town, q.action);
        values.add(max);
        zeroProgress();

        const positive = [...values].filter(v => v > 0).sort((a, b) => a - b);
        out.push({ action: q.action, town: q.town, dims: q.dims, sensitive, spatioSensitive,
                   firstNonzero: positive[0] ?? 0, max, G });
    }
    zeroProgress();
    adjustAll();
    return out;
})())`));
}

/**
 * Assemble the whole table. Deterministic: row order follows the XML's own
 * action order, so a regen with no content change is a no-op diff.
 *
 * `apEligible` records STRUCTURAL eligibility — whether a row could ever be an
 * AP location — and is the plan §3.4 enforcement point: a non-monotone row can
 * turn back OFF as the player progresses, so it can never carry a check.
 * `visible` rows are cosmetic and never locations (§3.2). Which of the
 * eligible rows v1 actually uses is a separate, looser question, recorded in
 * meta.v1Pool rather than baked into the rows.
 */
export function buildTable(ctx, xmlText, granularity = GRANULARITY) {
    const predicates = walkRows(ctx, xmlText).map(r => ({
        ...r, apEligible: r.monotone && r.pred === "unlocked",
    }));
    const dims = walkQuantityDims(ctx, xmlText);
    const curves = measureQuantityCurves(ctx, dims, granularity);
    checkQuantityProvenance(curves, dims);
    const quantities = curves.flatMap(c => quantityRows(c).map(r => ({ ...r, apEligible: true })));
    return {
        version: 1,
        meta: {
            granularity,
            // the 2026-07-19 ruling: v1 randomizes discovery quantity steps
            // only. Action-unlock rows are carried here in full but are not
            // v1 locations.
            v1Pool: "quantity",
            counts: { predicates: predicates.length, quantities: quantities.length },
        },
        rows: predicates,
        quantities,
    };
}

export const serializeTable = (table) => JSON.stringify(table, null, 1) + "\n";

// ---------------------------------------------------------------------------
// The verifier: walked rows vs the live JS closures
// ---------------------------------------------------------------------------
// The whole arc rests on one claim — "the table says exactly what the game
// does". The XML and the closures are two independent expressions of the same
// conditions (the closures are hand-written JS; the XML was transcribed and
// proven equivalent by the field-matrix differential), so checking the walk
// against the closures is a real oracle, not a restatement.
//
// Dim plumbing is ported from the 2026-07-11 de-risking experiment
// (NewDocs/plans/omsiloops/experiments/unlock-extract-probe.mjs). Its bounds
// lesson is load-bearing and preserved verbatim: probe and corpus bounds come
// from the game's own caps, never a flat 100 — a fixed bound of 100 made Imbue
// Soul (Imbuement > 499 && Imbuement2 > 499) extract as NEVER, and a corpus
// sharing the bound could not catch it.
const INSTALL_DIMS = `
globalThis.__ux = (() => {
    const numericDims = [];
    for (const t of towns) {
        for (const v of t.progressVars) {
            // progressVars stores the SurveyZ<i> varName directly; detect by
            // prefix, not equality (getting this wrong silently disabled the
            // experiment's survey disambiguation pass)
            if (v.startsWith("SurveyZ")) numericDims.push({ kind: "surveyLevel", town: t.index, v, max: 100 });
            else numericDims.push({ kind: "townLevel", town: t.index, v, max: 100 });
        }
    }
    for (const s in skills) numericDims.push({ kind: "skillLevel", v: s, max: 2000 });
    for (const b in buffs) numericDims.push({ kind: "buffLevel", v: b, max: buffHardCaps[b] ?? 1000 });
    numericDims.push({ kind: "storyMax", v: "storyMax", max: 20 });
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
        for (const d of numericDims) if (d.kind !== "exploreProgress") set(d, 0);
        storyMax = 0;
        for (const d of boolDims) setBool(d, false);
    };
    const maxAll = () => {
        for (const d of numericDims) if (d.kind !== "exploreProgress") set(d, d.max);
        for (const d of boolDims) setBool(d, true);
    };
    const preds = [];
    for (const a of totalActionList) {
        preds.push({ varName: a.varName, name: a.name, pred: "visible", fn: () => a.visible() });
        preds.push({ varName: a.varName, name: a.name, pred: "unlocked", fn: () => a.unlocked() });
    }
    // closures may throw on nonsense states; the engine consumes them in
    // boolean position, so a throw reads as false on both sides
    const test = (p) => { try { return !!p.fn(); } catch (e) { return false; } };
    const findDim = (kind, v) => numericDims.find(d => d.kind === kind && d.v === v);
    return { numericDims, boolDims, set, setBool, zeroAll, maxAll, preds, test, findDim };
})();
`;

// The three ui-parity save states. Kept in step with
// CC/scripts/omsi-parity/run-ui-parity.mjs craftSaves() — that gate is the
// reason these particular states exist, and they are the closest thing the
// project has to real progressed saves.
const FIXTURES = {
    fresh: "",
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

/**
 * Differential: for every (state x action x predicate), the row's live
 * evaluation must equal the JS closure's answer, compared with === after
 * boolean coercion (both sides are consumed in boolean position; several JS
 * bodies return truthy non-booleans).
 *
 * @returns {{checks: number, states: number, mismatches: {id: string, state: string, row: boolean, closure: boolean}[]}}
 */
export function verifyAgainstClosures(ctx, rows, { corpus = 400 } = {}) {
    ctx.ev(INSTALL_DIMS);
    return JSON.parse(ctx.ev(`
JSON.stringify((() => {
    const { numericDims, boolDims, set, setBool, zeroAll, maxAll, preds, test, findDim } = __ux;
    const rows = ${JSON.stringify(JSON.stringify(rows))};
    const table = JSON.parse(rows);
    const byKey = new Map(table.map(r => [r.action + "." + r.pred, r]));
    const mismatches = [];
    let checks = 0, states = 0;

    const compare = (stateName) => {
        states++;
        for (const p of preds) {
            const r = byKey.get(p.varName + "." + p.pred);
            if (!r) throw new Error("unlock-table: no row for " + p.varName + "." + p.pred);
            const closure = test(p);
            const row = Unlocks.achievedNow(r);
            checks++;
            if (closure !== row && mismatches.length < 40) {
                mismatches.push({ id: r.id, state: stateName, row, closure });
            }
        }
    };

    // --- stratum 1: threshold-adjacent sweeps ---------------------------
    // The exact-boundary states uniform sampling misses. Every clause is
    // probed at level-1 / level / level+1 against BOTH an all-zero and an
    // all-max background, so off-by-one and >= vs > both surface.
    const dimsOfClause = (c) => {
        if (c.kind === "skillSum") return c.vs.map(v => findDim("skillLevel", v));
        if (c.kind === "exploreProgress") return [findDim("exploreProgress", "exploreProgress")];
        if (c.kind === "storyMax") return [findDim("storyMax", "storyMax")];
        if (c.kind === "storyFlag" || c.kind === "prestige") return [];
        return [findDim(c.kind === "surveyLevel" ? "surveyLevel" : c.kind, c.v)];
    };
    for (const r of table) {
        for (const c of r.requires) {
            const ds = dimsOfClause(c).filter(Boolean);
            if (!ds.length) continue;
            for (const background of ["zero", "max"]) {
                for (const delta of [-1, 0, 1]) {
                    background === "zero" ? zeroAll() : maxAll();
                    const L = (c.level ?? 0) + delta;
                    // a sum splits its threshold across its terms
                    if (c.kind === "skillSum") {
                        ds.forEach((d, i) => set(d, i === 0 ? Math.max(0, L) : 0));
                    } else {
                        for (const d of ds) set(d, Math.max(0, L));
                    }
                    compare("threshold:" + r.id + ":" + c.kind + ":" + background + ":" + delta);
                }
            }
        }
    }

    // --- stratum 2: seeded random states --------------------------------
    let s = 0xC0FFEE;
    const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    for (let i = 0; i < ${corpus}; i++) {
        zeroAll();
        for (const d of numericDims) {
            if (d.kind === "exploreProgress") continue;   // derived from the survey dims
            const r = rnd();
            const L = r < 0.35 ? 0 : r < 0.75 ? Math.floor(rnd() * 41) : Math.floor(rnd() * (d.max + 1));
            set(d, L);
        }
        for (const d of boolDims) setBool(d, rnd() < 0.12);
        compare("random:" + i);
    }

    zeroAll();
    return { checks, states, mismatches };
})())`));
}

// ---------------------------------------------------------------------------
// The independent extraction leg
// ---------------------------------------------------------------------------
// Ported from the 2026-07-11 experiment. This derives the SAME rows by a
// completely different route — perturbation-probing the JS closures, sharing
// no code and no input with the XML walk — so agreement between the two is
// evidence about the conditions themselves rather than about one parser.
//
// Probing is structurally blind to non-monotone clauses: it starts from the
// all-zero state, where an upper bound is already satisfied, so it cannot see
// one. That is not a defect to work around, it is why the comparison below is
// scoped to monotone rows (the experiment found exactly this, reporting Buy
// Glasses as its single mismatch).
export function extractByProbing(ctx) {
    ctx.ev(INSTALL_DIMS);
    return JSON.parse(ctx.ev(`
JSON.stringify((() => {
    const { numericDims, boolDims, set, setBool, zeroAll, preds, test } = __ux;
    const out = [];
    let evals = 0;
    const T = (p) => { evals++; return test(p); };
    for (const p of preds) {
        zeroAll();
        const clauses = [];
        let always = false, never = false;
        if (T(p)) always = true;
        else {
            // pass A: raise one dim at a time from zero, binary-search the threshold
            for (const d of numericDims) {
                set(d, d.max);
                if (T(p)) {
                    let lo = 0, hi = d.max;
                    while (lo + 1 < hi) {
                        const mid = Math.floor((lo + hi) / 2);
                        set(d, mid);
                        if (T(p)) hi = mid; else lo = mid;
                    }
                    clauses.push({ kind: d.kind, town: d.town, v: d.v, level: hi });
                }
                set(d, 0);
            }
            for (const d of boolDims) {
                setBool(d, true);
                if (T(p)) clauses.push({ kind: d.kind, v: d.v });
                setBool(d, false);
            }
            // survey-vs-aggregate disambiguation, BEFORE sum-merge: the survey
            // dims and the derived exploreProgress dim shadow each other
            const agg = clauses.find(c => c.kind === "exploreProgress");
            if (agg) {
                const aggDim = numericDims.find(d => d.kind === "exploreProgress");
                for (const c of clauses.filter(c => c.kind === "surveyLevel")) {
                    if (agg.level < c.level) {
                        set(aggDim, Math.min(c.level - 1, agg.level));
                        const stillPasses = T(p);
                        set(aggDim, 0);
                        if (stillPasses) c.drop = true;
                    }
                }
                const indiv = clauses.filter(c => c.kind === "surveyLevel" && !c.drop);
                if (indiv.length) {
                    const rest = numericDims.filter(d => d.kind === "surveyLevel" && !indiv.some(c => c.v === d.v));
                    for (const d of rest) set(d, agg.level);
                    const passesWithoutIndiv = T(p);
                    for (const d of rest) set(d, 0);
                    if (!passesWithoutIndiv) agg.drop = true;
                }
            }
            // sum disambiguation: equal-threshold same-kind pairs -> split test
            const numeric = clauses.filter(c => c.level !== undefined && !c.drop && c.kind !== "surveyLevel" && c.kind !== "exploreProgress");
            for (let i = 0; i < numeric.length; i++) for (let j = i + 1; j < numeric.length; j++) {
                const a = numeric[i], b = numeric[j];
                if (a.kind !== b.kind || a.level !== b.level || a.level < 2 || a.merged || b.merged) continue;
                const da = numericDims.find(d => d.v === a.v && d.town === a.town);
                const db = numericDims.find(d => d.v === b.v && d.town === b.town);
                set(da, a.level - 1); set(db, 1);
                const isSum = T(p);
                set(da, 0); set(db, 0);
                if (isSum) { a.merged = true; b.merged = true;
                    clauses.push({ kind: a.kind === "skillLevel" ? "skillSum" : a.kind + "Sum", vs: [a.v, b.v], level: a.level }); }
            }
            const kept = clauses.filter(c => !c.merged && !c.drop);
            // pass B: nothing flips alone -> conjunction floors, everything else maxed
            if (!kept.length) {
                for (const d of numericDims) set(d, d.max);
                for (const d of boolDims) setBool(d, true);
                if (!T(p)) never = true;
                else {
                    for (const d of numericDims) {
                        set(d, 0);
                        if (!T(p)) {
                            let lo = 0, hi = d.max;
                            while (lo + 1 < hi) {
                                const mid = Math.floor((lo + hi) / 2);
                                set(d, mid);
                                if (T(p)) hi = mid; else lo = mid;
                            }
                            kept.push({ kind: d.kind, town: d.town, v: d.v, level: hi, and: true });
                        }
                        set(d, d.max);
                    }
                    for (const d of boolDims) {
                        setBool(d, false);
                        if (!T(p)) kept.push({ kind: d.kind, v: d.v, and: true });
                        setBool(d, true);
                    }
                }
            }
            out.push({ varName: p.varName, name: p.name, pred: p.pred,
                mode: never ? "NEVER" : kept.some(c => c.and) ? "AND" : "OR",
                clauses: kept.map(({ merged, drop, and, ...c }) => c) });
            zeroAll();
            continue;
        }
        out.push({ varName: p.varName, name: p.name, pred: p.pred, mode: "ALWAYS", clauses: [] });
        zeroAll();
    }
    zeroAll();
    return { rows: out, evals };
})())`));
}

/**
 * Compare the walked rows against the probe-extracted rows, structurally.
 *
 * Two tolerated differences, both narrow and both asserted to still apply so
 * the tolerance can never silently widen:
 *  - NON-MONOTONE rows are skipped (probing cannot see upper bounds/inversions).
 *  - The `exploreProgress >= 1` REDUNDANCY CLASS: where a predicate is
 *    `getExploreProgress() > 0`, any single survey level >= 1 also satisfies
 *    it, so probing emits an equivalent-but-redundant `surveyLevel >= 1`
 *    disjunct per survey dim. Equivalent, not different.
 */
export function compareWithProbe(walked, probed) {
    const eff = (c) => (c.op === "gt" ? c.level + 1 : c.level);
    const keyOf = (c, level) => {
        switch (c.kind) {
            case "townLevel":
            case "surveyLevel":  return `${c.kind}:${c.town}:${c.v}:${level}`;
            case "skillSum":     return `skillSum:${[...c.vs].sort().join("+")}:${level}`;
            case "exploreProgress":
            case "storyMax":     return `${c.kind}:${level}`;
            case "storyFlag":
            case "prestige":     return `${c.kind}:${c.v}`;
            default:             return `${c.kind}:${c.v}:${level}`;
        }
    };
    const byKey = new Map(probed.rows.map(r => [`${r.varName}.${r.pred}`, r]));
    const diffs = [];
    let compared = 0, skippedNonMonotone = 0, redundantDropped = 0;

    for (const w of walked) {
        if (!w.monotone) { skippedNonMonotone++; continue; }
        const p = byKey.get(`${w.action}.${w.pred}`);
        if (!p) { diffs.push({ id: w.id, why: "no probe row" }); continue; }
        compared++;
        if (w.mode !== p.mode) {
            diffs.push({ id: w.id, why: `mode ${w.mode} vs probe ${p.mode}` });
            continue;
        }
        // The redundancy class, applied to BOTH sides or neither: an
        // `exploreProgress >= 1` clause and a set of `surveyLevel >= 1`
        // disjuncts are the same statement, because getExploreProgress()
        // returns max(floor(total/9), 1) whenever total > 0 — so the
        // aggregate reaches 1 exactly when some survey level does. Probing
        // resolves it to the individual dims, the XML states it as the
        // aggregate. Tolerated only when the probe actually produced those
        // disjuncts, so a genuinely missing clause still fails.
        let wClauses = w.requires;
        let pClauses = p.clauses;
        const aggAtOne = w.mode === "OR" && w.requires.some(c => c.kind === "exploreProgress" && eff(c) === 1);
        const probeSurveyOnes = pClauses.filter(c => c.kind === "surveyLevel" && c.level === 1);
        if (aggAtOne && probeSurveyOnes.length) {
            wClauses = wClauses.filter(c => !(c.kind === "exploreProgress" && eff(c) === 1));
            pClauses = pClauses.filter(c => !(c.kind === "surveyLevel" && c.level === 1));
            redundantDropped++;
        }
        const wKeys = new Set(wClauses.map(c => keyOf(c, eff(c))));
        const pKeys = new Set(pClauses.map(c => keyOf(c, c.level)));
        const missing = [...wKeys].filter(k => !pKeys.has(k));
        const extra = [...pKeys].filter(k => !wKeys.has(k));
        if (missing.length || extra.length) {
            diffs.push({ id: w.id, why: `clauses differ; walked-only=[${missing}] probe-only=[${extra}]` });
        }
    }
    return { compared, skippedNonMonotone, redundantDropped, diffs };
}

/** Stratum 3: the three ui-parity save fixtures, each in its own context. */
export function verifyAgainstFixtures(rows) {
    const out = { checks: 0, states: 0, mismatches: [] };
    for (const [name, recipe] of Object.entries(FIXTURES)) {
        const ctx = makeUnlockContext();
        if (recipe.trim()) ctx.ev(recipe);
        ctx.ev(INSTALL_DIMS);
        const r = JSON.parse(ctx.ev(`
JSON.stringify((() => {
    const { preds, test } = __ux;
    const table = JSON.parse(${JSON.stringify(JSON.stringify(rows))});
    const byKey = new Map(table.map(r => [r.action + "." + r.pred, r]));
    const mismatches = [];
    let checks = 0;
    for (const p of preds) {
        const row = Unlocks.achievedNow(byKey.get(p.varName + "." + p.pred));
        const closure = test(p);
        checks++;
        if (closure !== row) mismatches.push({ id: p.varName + "." + p.pred, state: ${JSON.stringify(name)}, row, closure });
    }
    return { checks, mismatches };
})())`));
        out.checks += r.checks;
        out.states++;
        out.mismatches.push(...r.mismatches);
    }
    return out;
}

/**
 * Cross-check the XML's declared provenance against what the live formula
 * actually responds to. A mismatch is a HARD ERROR: it means <totalDiscovered>
 * and adjustAll() have diverged, and every downstream number (dim lists, and
 * the AP location pool built from them) would be describing a formula the game
 * no longer runs.
 *
 * The expected sensitive set is the declared <progressLevel> dims, PLUS the
 * town's own survey var for any var declaring <surveyBonus> — getSurveyBonus
 * reads `town.getLevel("Survey")`, which is a progress var like any other, it
 * just isn't (and shouldn't be) listed as a source dim.
 */
export function checkQuantityProvenance(curves, quantityDims) {
    const problems = [];
    for (const c of curves) {
        const declared = quantityDims.find(q => q.action === c.action);
        const hasSurvey = declared.modifiers.some(m => m.kind === "surveyBonus");
        const hasSkillMod = declared.modifiers.some(m => m.kind === "skillMod");
        const expected = new Set([...c.dims, ...(hasSurvey ? [`SurveyZ${c.town}`] : [])]);
        const got = new Set(c.sensitive);
        const extra = [...got].filter(v => !expected.has(v));
        const missing = [...expected].filter(v => !got.has(v));
        if (extra.length) problems.push(`${c.action}: live formula responds to undeclared dim(s) ${extra.join(", ")}`);
        if (missing.length) problems.push(`${c.action}: declared dim(s) ${missing.join(", ")} do not move the live total`);
        if (hasSkillMod !== c.spatioSensitive) {
            problems.push(hasSkillMod
                ? `${c.action}: declares <skillMod> but Spatiomancy does not move the live total`
                : `${c.action}: Spatiomancy moves the live total but no <skillMod> is declared`);
        }
    }
    if (problems.length) {
        throw new Error("unlock-table: <totalDiscovered> disagrees with the live adjust*() functions:\n  "
            + problems.join("\n  "));
    }
}

/**
 * Turn a measured curve into G step rows.
 *
 * Boundaries are equally spaced across [firstNonzero, max]. Plan §3.5
 * decision 3 pins the first trigger to the first nonzero formula output so a
 * fresh AP game is never softlocked on a var the early economy needs; the
 * remaining boundaries divide the rest of the reachable range evenly, and the
 * grants sum to exactly the vanilla maximum, so owning every step reproduces
 * vanilla capacity.
 */
export function quantityRows(curve) {
    const { action, town, dims, firstNonzero, max, G } = curve;
    const rows = [];
    let granted = 0;
    for (let i = 0; i < G; i++) {
        const t = G === 1 ? max : Math.round(firstNonzero + (max - firstNonzero) * i / (G - 1));
        rows.push({
            id: `q:${town}:${action}:${i}`,
            town, var: action, step: i, dims,
            trigger: { vanillaTotalAtLeast: t },
            grant: { items: t - granted },
        });
        granted = t;
    }
    return rows;
}
