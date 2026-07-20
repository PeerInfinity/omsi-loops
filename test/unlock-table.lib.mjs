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
import { makeContext } from "./harness.mjs";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const TABLE_PATH = path.join(ROOT, "data", "unlockTable.json");

/** the quantity model this table implements (plan §3.5, USER-RULED 2026-07-19) */
export const QUANTITY_MODEL = "loot-batch";

/**
 * Discovery vars excluded from randomization entirely — no AP locations, no AP
 * items (USER RULING 2026-07-20).
 *
 * The four Hauls are the whole list. They are the game's soulstone grind: at
 * 2500 capacity per progress level against a 1000-per-batch ratio, each one
 * would mint 250 batch rows, so on the batch model alone they are 1,000 of
 * 1,620 rows — 62% of the pool spent on four repetitive grind actions. They
 * are excluded here at the source rather than filtered downstream so that no
 * consumer has to remember the rule; meta.excludedVars keeps the decision
 * visible in the committed artifact.
 *
 * This is the LOCATION/ITEM axis only. Cross-game loot shuffling is a
 * different surface and already excludes them by construction —
 * omsiSubstrateWrapper/generateAwardSchedule.js ships OMSI_LOOTABLES =
 * ['Pots', 'Locks']. Anything widening that list must honour this ruling too.
 */
export const QUANTITY_EXCLUDED_VARS = Object.freeze(["StonesZ1", "StonesZ3", "StonesZ5", "StonesZ6"]);

/** A context ready to walk and probe. The XML stack and unlocks.js are in the
 *  default SIM_FILES since the cutover, so a plain context already has both. */
export function makeUnlockContext(seed = 12345) {
    return makeContext(seed);
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

/** Walk the <totalDiscovered> provenance (dims + coeffs + modifiers) for the 18 vars. */
export function walkQuantityDims(ctx, xmlText) {
    ctx.ev(INSTALL_RESOLVERS);
    return JSON.parse(ctx.ev(
        `JSON.stringify(Unlocks.walkQuantityDims(${JSON.stringify(xmlText)}, __ut))`));
}

/** Mint loot-batch rows through the runtime's own implementation. */
export function quantityRows(ctx, curves) {
    return JSON.parse(ctx.ev(
        `JSON.stringify(${JSON.stringify(curves)}.flatMap(c => Unlocks.quantityRows(c)))`));
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
 * Assert the sweep context is multiplier-NEUTRAL, so a measured total is the
 * BASE-RATE total the loot-batch model is defined against (plan §3.5).
 *
 * Neutral by construction rather than by stubbing: a fresh boot has no
 * prestige, no Spatiomancy and no Survey progress, and each of the three
 * modifiers is the identity there — `adjustContentFromPrestige()` is 1
 * (prestige.js:203), `getSurveyBonus()` is `level * .005` = 0 (stats.js:484),
 * and the Spatiomancy `getSkillMod` window bottoms out at 1. Asserting it
 * means a future change to any of those defaults trips the generator loudly
 * instead of quietly skewing every threshold in the golden.
 */
const ASSERT_NEUTRAL = `
(() => {
    const bad = [];
    const prestige = adjustContentFromPrestige();
    if (prestige !== 1) bad.push("adjustContentFromPrestige() = " + prestige + ", want 1");
    const spatio = getSkillMod("Spatiomancy", 100, 300, .5);
    if (spatio !== 1) bad.push("Spatiomancy skillMod = " + spatio + ", want 1");
    for (const t of towns) {
        const sb = getSurveyBonus(t);
        if (sb !== 0) bad.push("getSurveyBonus(town " + t.index + ") = " + sb + ", want 0");
    }
    if (bad.length) throw new Error("unlock-table: sweep context is not multiplier-neutral:\\n  " + bad.join("\\n  "));
})();
`;

/**
 * Measure each var's BASE-RATE capacity ceiling by driving the real
 * adjustAll() with every source dim at its cap (level 100) and all three
 * multipliers neutral.
 *
 * That ceiling is the only number the loot-batch model needs from the game:
 * a var mints `floor(baseMax / oneInEvery)` locations, and batch k's trigger
 * is the plain scalar `k * oneInEvery` (plan §3.5). There is no boundary
 * SEARCH here and deliberately so — because the trigger is a threshold on
 * the same monotone scalar the game already computes, it is order-
 * independent by construction for the multi-source vars (Herbs, Wild Mana)
 * rather than by a sweep that happened to try the right orders. The verifier
 * leg replays the orders anyway, as a check on that reasoning.
 *
 * The sensitivity probe below feeds checkQuantityProvenance: it is what
 * catches <totalDiscovered> drifting away from the live formula.
 */
export function measureQuantityCurves(ctx, quantityDims) {
    ctx.ev(INSTALL_SWEEP);
    ctx.ev(ASSERT_NEUTRAL);
    const spec = quantityDims.map(q => ({
        action: q.action, town: q.town, dims: q.dims, name: q.name, oneInEvery: q.oneInEvery,
    }));
    return JSON.parse(ctx.ev(`
JSON.stringify((() => {
    const { setLevel, allDims, zeroProgress, totalOf, townOf } = __uq;
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

        // --- the base-rate ceiling: every source dim at its level cap ---
        zeroProgress();
        const atZero = totalOf(q.town, q.action);
        for (const d of dimTowns) setLevel(d.town, d.v, 100);
        const baseMax = totalOf(q.town, q.action);
        zeroProgress();

        // --- the independent JS oracle for the batch size ---
        // <oneInEvery> is XML; the ratio the game actually walks is the second
        // argument of the action's finishRegular() call. Reading it out of the
        // live function source keeps the two derivations independent, which is
        // the whole point of cross-checking them in checkQuantityProvenance.
        const act = totalActionList.find(a => a.name === q.name);
        if (!act) throw new Error("unlock-table: no live Action named " + q.name);
        const src = String(act.loopsFinished ?? act.finish ?? "");
        const m = /finishRegular\\(\\s*this\\.varName\\s*,\\s*(\\d+)/.exec(src);
        out.push({ action: q.action, name: q.name, town: q.town, dims: q.dims,
                   sensitive, spatioSensitive, atZero, baseMax,
                   oneInEvery: q.oneInEvery, jsOneInEvery: m ? Number(m[1]) : null });
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
export function buildTable(ctx, xmlText) {
    const predicates = walkRows(ctx, xmlText).map(r => ({
        ...r, apEligible: r.monotone && r.pred === "unlocked",
    }));
    const dims = walkQuantityDims(ctx, xmlText);
    const curves = measureQuantityCurves(ctx, dims);
    checkQuantityProvenance(curves, dims);
    // Minted by unlocks.js, not here: runtime evaluates these rows too (the
    // diff pass has to answer "is batch k complete?"), and two mintings would
    // be two things to keep in sync. checkQuantityProvenance above has already
    // proven the coefficients this uses reproduce the live adjust*() sweep.
    const quantities = quantityRows(ctx, dims.filter(d => !d.excluded))
        .map(r => ({ ...r, apEligible: true }));
    return {
        version: 1,
        meta: {
            quantityModel: QUANTITY_MODEL,
            excludedVars: [...QUANTITY_EXCLUDED_VARS],
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
        // every formula must be 0 at zero progress. The batch model numbers
        // rows from a standing start (batch k unlocks at k * oneInEvery), so a
        // var that already had capacity before any progress would need a
        // step-0 row the generator never mints — better to fail loudly than to
        // ship a table that silently owes the player a batch.
        if (c.atZero !== 0) {
            problems.push(`${c.action}: base total is ${c.atZero} at zero progress, want 0`);
        }
        // the LINEAR FORM the rows are minted from must reproduce the ceiling
        // the live formula actually reaches. This is the assertion that makes
        // reading coefficients off the XML safe: a nonlinear future formula
        // fails generation here instead of silently skewing every threshold.
        // (The per-point check across the whole sweep is verifyQuantityRows.)
        const derivedMax = Math.round(declared.coeffs.reduce((s, k) => s + k * 100, 0));
        if (derivedMax !== c.baseMax) {
            problems.push(`${c.action}: coefficients give a base-rate ceiling of ${derivedMax}, `
                + `live adjustAll() reaches ${c.baseMax} — the formula is not the declared linear form`);
        }
        // the exclusion ruling has two copies (runtime needs it in unlocks.js,
        // the generator records it here); they must not drift apart
        if (declared.excluded !== QUANTITY_EXCLUDED_VARS.includes(c.action)) {
            problems.push(`${c.action}: unlocks.js and the generator disagree about the haul exclusion`);
        }
        // the batch size the table mints locations from must be the batch size
        // the checking walk actually yields loot on
        if (c.jsOneInEvery === null) {
            problems.push(`${c.action}: no finishRegular(this.varName, N, ...) call found in the live action`);
        } else if (c.jsOneInEvery !== c.oneInEvery) {
            problems.push(`${c.action}: <oneInEvery> is ${c.oneInEvery} but finishRegular walks ${c.jsOneInEvery}`);
        }
    }
    if (problems.length) {
        throw new Error("unlock-table: <totalDiscovered> disagrees with the live adjust*() functions:\n  "
            + problems.join("\n  "));
    }
}

/**
 * Replay every quantity var's source dims 0 -> cap against the live
 * adjustAll() and check the committed rows fire exactly when the game says
 * the next complete batch became checkable.
 *
 * The claim under test, at every state along the path:
 *
 *     rows fired  ===  min(rowCount, floor(liveBaseTotal / oneInEvery))
 *
 * The left side comes from the TABLE (thresholds frozen in the golden); the
 * right side is computed from the total the running game just wrote. So this
 * is not the generator restating itself: it re-derives the batch count from
 * the live formula and asserts the frozen thresholds agree, at 101 states per
 * dim. The `min` is the v1 cap — past baseMax there is no further row, which
 * is the one place the two sides are allowed to stop tracking.
 *
 * Two orderings are replayed for every multi-source var (declared order, then
 * reversed, plus the diagonal), and the fired set at the end must be identical
 * across all of them. Order-independence is already true by construction — the
 * trigger is a threshold on a single monotone scalar — but that is exactly the
 * kind of reasoning that is worth one cheap empirical check, since a
 * non-monotone formula would silently break it.
 *
 * Also asserts the live total never DECREASES along a monotone path: a row
 * that could un-fire would be a location that un-collects.
 */
export function verifyQuantityRows(ctx, curves, quantities) {
    ctx.ev(INSTALL_SWEEP);
    ctx.ev(ASSERT_NEUTRAL);
    // Excluded vars mint no rows, so replaying them would compare an empty
    // threshold list against itself and report a vacuous pass. Drop them here
    // and assert every var that SHOULD have rows does — otherwise a var that
    // silently stopped minting would look like a clean run.
    const spec = curves
        .filter(c => !QUANTITY_EXCLUDED_VARS.includes(c.action))
        .map(c => ({
            action: c.action, town: c.town, dims: c.dims, oneInEvery: c.oneInEvery,
            coeffs: quantities.find(q => q.var === c.action && q.town === c.town)?.coeffs,
            thresholds: quantities.filter(q => q.var === c.action && q.town === c.town)
                .map(q => q.trigger.baseTotalAtLeast),
        }));
    const empty = spec.filter(s => s.thresholds.length === 0).map(s => s.action);
    if (empty.length) {
        throw new Error(`unlock-table: non-excluded var(s) minted no batch rows: ${empty.join(", ")}`);
    }
    if (quantities.some(q => QUANTITY_EXCLUDED_VARS.includes(q.var))) {
        throw new Error("unlock-table: an excluded var reached the row table");
    }
    return JSON.parse(ctx.ev(`
JSON.stringify((() => {
    const { setLevel, zeroProgress, totalOf, townOf } = __uq;
    const problems = [];
    let states = 0, checks = 0, orderings = 0;
    for (const q of ${JSON.stringify(spec)}) {
        const dims = q.dims.map(v => ({ v, town: townOf(v) }));
        const N = q.oneInEvery, cap = q.thresholds.length;
        // sorted ascending is an invariant of the row shape; rely on it
        const fired = (T) => q.thresholds.filter(t => T >= t).length;

        // paths: each dim alone 0->100 (leaving the others at 0), the
        // declared order and its reverse walked cumulatively, and the diagonal
        const paths = [];
        for (const d of dims) paths.push([d]);
        if (dims.length > 1) {
            paths.push(dims, [...dims].reverse());
        }
        for (const path of paths) {
            orderings++;
            zeroProgress();
            let prev = -1;
            for (const d of path) {
                for (let L = 0; L <= 100; L++) {
                    setLevel(d.town, d.v, L);
                    const T = totalOf(q.town, q.action);
                    states++; checks++;
                    // the dot product the RUNTIME evaluates triggers with must
                    // equal the base-rate total the game just computed, at
                    // every point — not merely at the ceiling. Same expression
                    // as the live path (Unlocks.quantityBaseTotal), so this is
                    // the formula-shape oracle, not a restatement.
                    const dot = Unlocks.quantityBaseTotal({ id: q.action, dims: q.dims, coeffs: q.coeffs });
                    if (dot !== T) {
                        problems.push(q.action + " @" + d.v + "=" + L + ": dot product " + dot
                            + " != live base total " + T + " (formula is not linear in the declared dims)");
                    }
                    if (T < prev) problems.push(q.action + ": live total DECREASED (" + prev + " -> " + T + ") raising " + d.v);
                    prev = T;
                    const want = Math.min(cap, Math.floor(T / N));
                    const got = fired(T);
                    if (got !== want) {
                        problems.push(q.action + " @" + d.v + "=" + L + " total=" + T
                            + ": " + got + " rows fired, live formula supports " + want + " complete batches");
                    }
                }
            }
        }
        // all dims at 100, three ways in for multi-source vars
        const finals = [];
        for (const order of (dims.length > 1 ? [dims, [...dims].reverse(), null] : [dims])) {
            zeroProgress();
            if (order === null) {
                for (let L = 0; L <= 100; L++) for (const d of dims) setLevel(d.town, d.v, L);
            } else {
                for (const d of order) setLevel(d.town, d.v, 100);
            }
            finals.push(fired(totalOf(q.town, q.action)));
            states++;
        }
        if (new Set(finals).size !== 1) {
            problems.push(q.action + ": source ORDER changed the fired set: " + finals.join(" vs "));
        }
        if (finals[0] !== cap) {
            problems.push(q.action + ": at max progress " + finals[0] + " of " + cap + " rows fired — the cap is wrong");
        }
        zeroProgress();
    }
    zeroProgress();
    adjustAll();
    return { problems, states, checks, orderings };
})())`));
}
