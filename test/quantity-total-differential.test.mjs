// quantity-total-differential.test.mjs — arc B (town de-hardcoding): the
// independent stratum for compiling <totalDiscovered> into computeTotal().
//
// Arc B deletes the 14 hand-pinned adjust*() capacity functions and drives
// driver.adjustAll() from the XML <totalDiscovered> blocks via the existing
// evaluator (ActionListXml.getQuantityTotalFns / applyQuantityTotals). The
// run-planner byte-gate proves this reproduces the default 9-town sim to the
// bit — but it can only witness the levels/skills that ONE default run
// reaches. A structural divergence at, say, Spatiomancy past a skillMod
// window boundary, or an odd Secrets level exercising LQuests' /2 round,
// would slip past it. See [[feedback_verifier_shared_assumption]].
//
// This test is that independent stratum: an ORACLE that is a verbatim copy of
// the 14 deleted JS functions (captured here before the deletion is trusted),
// swept over the full multiplier space — source levels x Spatiomancy x
// PrestigeSpatiomancy x Survey — asserting computeTotal() === the JS oracle at
// every sample. The oracle calls the SAME game helpers the compiled path does
// (adjustContentFromPrestige / getSurveyBonus / getSkillMod / town.getLevel) —
// those are unchanged by arc B and are not what is under test; what is under
// test is whether the XML formula STRUCTURE matches the JS structure. The
// oracle derives from the JS source, computeTotal derives from the XML, so a
// mismatch means the two representations disagree.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

const SEED = 12345;

// The 14 quantity vars the loop converts, in getQuantityTotalFns() order.
const QUANTITY_VARS = ["Pots", "Locks", "SQuests", "LQuests", "WildMana", "Herbs",
    "Hunt", "Gamble", "Geysers", "MineSoulstones", "Artifacts", "Donations",
    "Pylons", "Wells"];

// Verbatim transcription of the deleted adjust*() bodies (actionList.js at
// fork e5ef307), keyed by the total var each wrote. This is the oracle: it
// must NOT be derived from the XML. Geysers rounds its outer total (the lone
// non-floor); LQuests divides Secrets by 2; WildMana/Herbs sum multiple
// progress dims.
const ORACLE_SRC = `
globalThis.__oracleTotals = function () {
    const acp = adjustContentFromPrestige;
    const o = {};
    { let town = towns[0]; let base = Math.round(town.getLevel("Wander") * 5 * acp()); o.Pots = Math.floor(base + base * getSurveyBonus(town)); }
    { let town = towns[0]; let base = Math.round(town.getLevel("Wander") * acp()); o.Locks = Math.floor(base * getSkillMod("Spatiomancy", 100, 300, .5) + base * getSurveyBonus(town)); }
    { let town = towns[0]; let base = Math.round(town.getLevel("Met") * acp()); o.SQuests = Math.floor(base * getSkillMod("Spatiomancy", 200, 400, .5) + base * getSurveyBonus(town)); }
    { let town = towns[0]; let base = Math.round(town.getLevel("Secrets") / 2 * acp()); o.LQuests = Math.floor(base * getSkillMod("Spatiomancy", 300, 500, .5) + base * getSurveyBonus(town)); }
    { let town = towns[1]; let base = Math.round((town.getLevel("Forest") * 5 + town.getLevel("Thicket") * 5) * acp()); o.WildMana = Math.floor(base + base * getSurveyBonus(town)); }
    { let town = towns[1]; let base = Math.round((town.getLevel("Forest") * 5 + town.getLevel("Shortcut") * 2 + town.getLevel("Flowers") * 13) * acp()); o.Herbs = Math.floor(base * getSkillMod("Spatiomancy", 500, 700, .5) + base * getSurveyBonus(town)); }
    { let town = towns[1]; let base = Math.round(town.getLevel("Forest") * 2 * acp()); o.Hunt = Math.floor(base * getSkillMod("Spatiomancy", 400, 600, .5) + base * getSurveyBonus(town)); }
    { let town = towns[2]; let base = Math.round(town.getLevel("City") * 3 * acp()); o.Gamble = Math.floor(base * getSkillMod("Spatiomancy", 600, 800, .5) + base * getSurveyBonus(town)); }
    { let town = towns[3]; let base = Math.round(town.getLevel("Mountain") * 10 * acp()); o.Geysers = Math.round(base + base * getSurveyBonus(town)); }
    { let town = towns[3]; let base = Math.round(town.getLevel("Cavern") * 3 * acp()); o.MineSoulstones = Math.floor(base * getSkillMod("Spatiomancy", 700, 900, .5) + base * getSurveyBonus(town)); }
    { let town = towns[3]; let base = Math.round(town.getLevel("Illusions") * 5 * acp()); o.Artifacts = Math.floor(base * getSkillMod("Spatiomancy", 800, 1000, .5) + base * getSurveyBonus(town)); }
    { let town = towns[4]; let base = Math.round(town.getLevel("Canvassed") * 5 * acp()); o.Donations = Math.floor(base * getSkillMod("Spatiomancy", 900, 1100, .5) + base * getSurveyBonus(town)); }
    { let town = towns[5]; let base = Math.round(town.getLevel("Meander") * 10 * acp()); o.Pylons = Math.floor(base * getSkillMod("Spatiomancy", 1000, 1200, .5) + base * getSurveyBonus(town)); }
    { let town = towns[5]; let base = Math.round(town.getLevel("Meander") * 10 * acp()); o.Wells = Math.floor(base + base * getSurveyBonus(town)); }
    return o;
};
globalThis.__computedTotals = function () {
    const o = {};
    for (const { varName, computeTotal } of ActionListXml.getQuantityTotalFns()) o[varName] = computeTotal();
    return o;
};
// Scaling-aware level setter: getLevel(v) returns exactly the requested level
// for both quadratic ("default") and "linear" progress vars, so the sweep has
// precise control over every driving dim (incl. odd levels for LQuests' /2).
// Survey is set independently (getLevel("Survey") reads expSurveyZ{index}).
globalThis.__setProgress = function (L, V) {
    for (const t of towns) {
        for (const v of t.allVarNames) {
            const lvl = v.startsWith("Survey") ? V : L;
            t["exp" + v] = t.progressScaling[v] === "linear" ? lvl * 5050 : t.expFromLevel(lvl);
        }
    }
};
// Distinct per-dim levels, so a swapped/mis-summed coefficient in a multi-term
// var (WildMana, Herbs) can't hide behind equal terms.
globalThis.__setDistinct = function (base, V) {
    let i = 0;
    for (const t of towns) {
        for (const v of t.allVarNames) {
            const lvl = v.startsWith("Survey") ? V : (base + (i++ % 11) * 3);
            t["exp" + v] = t.progressScaling[v] === "linear" ? lvl * 5050 : t.expFromLevel(lvl);
        }
    }
};
globalThis.__runSweep = function (cfg) {
    const mism = [];
    let count = 0;
    const varsSeen = new Set();
    const compare = (tag) => {
        const a = __oracleTotals(), b = __computedTotals();
        for (const k in a) {
            count++;
            varsSeen.add(k);
            if (!Object.is(a[k], b[k])) mism.push({ tag, var: k, oracle: a[k], computed: b[k] });
        }
        return mism.length <= 25;
    };
    outer:
    for (const P of cfg.prestiges) {
        buffs.PrestigeSpatiomancy.amt = P;
        for (const V of cfg.surveys) {
            for (const S of cfg.spatios) {
                skills.Spatiomancy.levelExp.level = S;
                for (const L of cfg.levels) {
                    __setProgress(L, V);
                    if (!compare({ P, V, S, L })) break outer;
                }
            }
        }
    }
    // distinct-dim pass (multi-term coefficient coverage)
    for (const P of [0, 2]) {
        buffs.PrestigeSpatiomancy.amt = P;
        for (const V of [0, 37]) {
            for (const S of [0, 250, 850, 1300]) {
                skills.Spatiomancy.levelExp.level = S;
                for (const base of [1, 6, 60, 500]) {
                    __setDistinct(base, V);
                    if (!compare({ distinct: base, P, V, S })) break;
                }
            }
        }
    }
    return { count, mism, varsSeen: [...varsSeen] };
};
`;

test("getQuantityTotalFns converts exactly the 14 XML-declared quantity vars (HaulZ excluded)", () => {
    const ctx = makeContext(SEED);
    const vars = JSON.parse(ctx.ev("JSON.stringify(ActionListXml.getQuantityTotalFns().map(f => f.varName))"));
    assert.deepEqual(vars, QUANTITY_VARS, "the loop must carry exactly the 14 vars, in order");
    // the 4 soulstone hauls carry <totalDiscovered> but must be skipped
    for (const haul of ["StonesZ1", "StonesZ3", "StonesZ5", "StonesZ6"]) {
        assert.ok(!vars.includes(haul), `${haul} must NOT be in the loop (adjustAllRocks owns it)`);
    }
});

test("computeTotal() === the deleted JS adjust*() at every point in the multiplier space", () => {
    const ctx = makeContext(SEED);
    ctx.ev(ORACLE_SRC);

    // Spatiomancy hitting each skillMod window's boundaries (100..1200) plus
    // below-all and above-all; levels covering odd/large; prestige and survey
    // nonzero to exercise the base round and the additive survey term.
    const spatios = [0, 50,
        99, 100, 101, 199, 200, 201, 299, 300, 301, 399, 400, 401,
        499, 500, 501, 599, 600, 601, 699, 700, 701, 799, 800, 801,
        899, 900, 901, 999, 1000, 1001, 1099, 1100, 1101, 1199, 1200, 1201, 1500];
    const cfg = {
        levels: [0, 1, 2, 3, 5, 7, 13, 25, 50, 100, 250, 1000],
        spatios,
        prestiges: [0, 1, 3],
        surveys: [0, 1, 37, 400],
    };
    const res = JSON.parse(ctx.ev(`JSON.stringify(__runSweep(${JSON.stringify(cfg)}))`));

    // Positive-coverage assertions BEFORE the zero-mismatch assertion, so a
    // vacuously-empty sweep can't pass as green.
    assert.deepEqual(res.varsSeen.sort(), [...QUANTITY_VARS].sort(),
        "sweep must have compared all 14 vars");
    assert.ok(res.count > 50000, `sweep coverage too thin: only ${res.count} comparisons`);

    assert.equal(res.mism.length, 0,
        `computeTotal diverged from the JS oracle:\n${JSON.stringify(res.mism.slice(0, 25), null, 2)}`);
});
