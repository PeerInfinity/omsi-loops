// JS-vs-XML differential (XML migration Phase 4).
//
// actionList.js is the oracle: every action defined in data/actionList.xml is
// compiled by actionListXml.js and compared field-by-field against its
// hand-written JS implementation across the full Phase-3 state corpus
// (thresholds + random sweeps + load() fixtures). Numeric fields compare ===,
// boolean fields by truthiness, missing fields never equal present ones.
//
// The perturbation canaries are the anti-vacuity stratum (the JtA gate
// triple's third leg): a NON-vanilla value in the XML must produce a
// divergence, proving the XML data path is live for that action — a compiled
// field that silently fell back to JS would pass the equality gate vacuously.
import test from "node:test";
import assert from "node:assert/strict";
import { buildXmlDifferential } from "./field-matrix.lib.mjs";

test("every XML-defined action matches its JS implementation across the corpus", () => {
    const d = buildXmlDifferential();
    assert.ok(d.names.length >= 4, `expected at least the 4 upstream-migrated actions, got ${d.names.length}`);
    assert.equal(d.rngConsumed, 0, "the differential must not consume RNG");
    assert.deepEqual(d.statics, [], "static field mismatches (varName/townNum/type/expMult/stats/affectedBy)");
    assert.deepEqual(d.mismatches, [],
        `field mismatches JS vs XML (first: ${JSON.stringify(d.mismatches[0])})`);
});

test("canary: a non-vanilla effortCost diverges for every migrated action", () => {
    // discover the migrated set once, cheaply
    const names = buildXmlDifferential({ probe: false, randomStates: 0, fixtures: false }).names;
    for (const name of names) {
        const d = buildXmlDifferential({
            probe: false, randomStates: 4, fixtures: false, maxMismatches: 1,
            mutate: (doc) => {
                const ec = doc.actions[name].children.find(c => c.tag === "effortCost");
                if ("value" in ec.attrs) ec.attrs.value = String(Number(ec.attrs.value) + 1);
                else ec.text = String(Number(ec.text.trim()) + 1);
            },
        });
        assert.ok(d.mismatches.some(m => m.name === name && m.col === "manaCost"),
            `${name}: effortCost+1 in the XML produced no manaCost divergence — its XML path is dead`);
    }
});

// targeted canaries: one per vocabulary family, proving the corpus can
// distinguish a wrong translation through that construct
// MOVED, not dropped: the `unlock threshold (Pick Locks, ifProgress 20 -> 21)`
// canary lived here until the unlock cutover (2026-07-19). <visible>/<unlocked>
// are no longer compiled into fields — unlocks.js walks them into the unlock
// table instead — so mutating the compiled doc cannot move this differential.
// The identical mutation now lives in test/unlock-table.test.mjs ("canary —
// mutating an XML threshold moves the table"), which is where the ifProgress
// predicate path is actually read; that file also carries a canary proving its
// differential catches a corrupted row.
const TARGETED_CANARIES = [
    {
        label: "talentLevel (Train Strength story 2, 100 -> 200)",
        expect: { name: "Train Strength", col: "storyReqs(2)" },
        mutate: (doc) => {
            const sr = doc.actions["Train Strength"].children.find(c => c.tag === "storyReqs");
            sr.children.find(s => s.attrs.num === "2").children.find(c => c.tag === "if").attrs.min = "200";
        },
    },
    {
        label: "townValue (Buy Supplies cost, suppliesCost -> bogus field)",
        expect: { name: "Buy Supplies", col: "canStart" },
        mutate: (doc) => {
            const cost = doc.actions["Buy Supplies"].children.find(c => c.tag === "cost");
            cost.children[0].children.find(c => c.tag === "townValue").attrs.name = "noSuchField";
        },
    },
    {
        label: "anyOf arm (SurveyZ0 canStart, equals 100 -> 99)",
        expect: { name: "SurveyZ0", col: "canStart" },
        mutate: (doc) => {
            const cs = doc.actions["SurveyZ0"].children.find(c => c.tag === "canStart");
            cs.children.find(c => c.tag === "anyOf").children.find(c => c.tag === "ifProgress").attrs.equals = "99";
        },
    },
    {
        label: "globalValue (Train Strength allowed, trainingLimits -> storyMax)",
        expect: { name: "Train Strength", col: "allowed" },
        mutate: (doc) => {
            const allowed = doc.actions["Train Strength"].children.find(c => c.tag === "allowed");
            allowed.children.find(c => c.tag === "globalValue").attrs.name = "storyMax";
        },
    },
    {
        label: "skillExp (Learn Alchemy story 1, 50 -> 51)",
        expect: { name: "Learn Alchemy", col: "storyReqs(1)" },
        mutate: (doc) => {
            const sr = doc.actions["Learn Alchemy"].children.find(c => c.tag === "storyReqs");
            sr.children.find(s => s.attrs.num === "1").children.find(c => c.tag === "if").attrs.min = "51";
        },
    },
    {
        label: "stonesUsed (HaulZ1 canStart, < 250 -> < 249)",
        expect: { name: "HaulZ1", col: "canStart" },
        mutate: (doc) => {
            const cs = doc.actions["HaulZ1"].children.find(c => c.tag === "canStart");
            cs.children.find(c => c.tag === "if").attrs.maxExclusive = "249";
        },
    },
    {
        label: "cost implied=none (Dark Magic: dropping it re-implies reputation >= 1)",
        expect: { name: "Dark Magic", col: "canStart" },
        mutate: (doc) => {
            delete doc.actions["Dark Magic"].children.find(c => c.tag === "cost").attrs.implied;
        },
    },
    {
        label: "ifTownUnlocked (Start Journey story 1, town 1 -> 2)",
        expect: { name: "Start Journey", col: "storyReqs(1)" },
        mutate: (doc) => {
            const sr = doc.actions["Start Journey"].children.find(c => c.tag === "storyReqs");
            sr.children[0].children.find(c => c.tag === "ifTownUnlocked").attrs.townNum = "2";
        },
    },
    {
        label: "ifGuild (Apprentice canStart, Crafting -> Thieves)",
        expect: { name: "Apprentice", col: "canStart" },
        mutate: (doc) => {
            const cs = doc.actions["Apprentice"].children.find(c => c.tag === "canStart");
            cs.children.find(c => c.tag === "ifGuild").attrs.guild = "Thieves";
        },
    },
    {
        label: "ifGlobalFlag (Buy Mana Z3 canStart, dropping inverted flips the portalUsed gate)",
        expect: { name: "Buy Mana Z3", col: "canStart" },
        mutate: (doc) => {
            const cs = doc.actions["Buy Mana Z3"].children.find(c => c.tag === "canStart");
            delete cs.children.find(c => c.tag === "ifGlobalFlag").attrs.inverted;
        },
    },
    {
        label: "globalValue effectiveTime (Mana Well drain rate, x10 -> x11)",
        expect: { name: "Mana Well", col: "goldCost" },
        mutate: (doc) => {
            const pv = doc.actions["Mana Well"].children.find(c => c.tag === "primaryValue");
            pv.children.find(c => c.tag === "subtraction").children.find(c => c.tag === "multiplier").attrs.value = "11";
        },
    },
    {
        label: "storyVar (Raise Zombie story 3, maxZombiesRaised 10 -> 11)",
        expect: { name: "Raise Zombie", col: "storyReqs(3)" },
        mutate: (doc) => {
            const sr = doc.actions["Raise Zombie"].children.find(c => c.tag === "storyReqs");
            sr.children.find(s => s.attrs.num === "3").children.find(c => c.tag === "if").attrs.min = "11";
        },
    },
    {
        label: "function getWizCollegeRankBonus (Restoration effortCost divisor -> craft bonus)",
        expect: { name: "Restoration", col: "manaCost" },
        mutate: (doc) => {
            const ec = doc.actions["Restoration"].children.find(c => c.tag === "effortCost");
            ec.children.find(c => c.tag === "divisor").children[0].attrs.name = "getCraftGuildRankBonus";
        },
    },
    {
        label: "function getCraftGuildRankBonus (Build Housing maxHouses -> wiz bonus)",
        expect: { name: "Build Housing", col: "canStart" },
        mutate: (doc) => {
            const cs = doc.actions["Build Housing"].children.find(c => c.tag === "canStart");
            cs.children.find(c => c.tag === "if").children.find(c => c.tag === "value")
                .children.find(c => c.tag === "function").attrs.name = "getWizCollegeRankBonus";
        },
    },
    {
        label: "function fullyExploredZones (Explorers Guild story 4, 4 -> 5)",
        expect: { name: "Explorers Guild", col: "storyReqs(4)" },
        mutate: (doc) => {
            const sr = doc.actions["Explorers Guild"].children.find(c => c.tag === "storyReqs");
            sr.children.find(s => s.attrs.num === "4").children.find(c => c.tag === "if").attrs.min = "5";
        },
    },
    {
        label: "function totalAssassinations (Guild Assassin story 3, 4 -> 5)",
        expect: { name: "Guild Assassin", col: "storyReqs(3)" },
        mutate: (doc) => {
            const sr = doc.actions["Guild Assassin"].children.find(c => c.tag === "storyReqs");
            sr.children.find(s => s.attrs.num === "3").children.find(c => c.tag === "if").attrs.min = "5";
        },
    },
    {
        label: "setValue guild-pricing arm (Excursion, member price 2 -> 3)",
        expect: { name: "Excursion", col: "goldCost" },
        mutate: (doc) => {
            const pv = doc.actions["Excursion"].children.find(c => c.tag === "primaryValue");
            pv.children.find(c => c.tag === "setValue").attrs.value = "3";
        },
    },
    {
        label: "multipart segment/loopCounter plumbing (Fight Monsters loopCost, lc/3 -> lc/4)",
        expect: { name: "Fight Monsters", col: "loopCost[" },
        mutate: (doc) => {
            const lc = doc.actions["Fight Monsters"].children.find(c => c.tag === "loopCost");
            lc.children.find(c => c.tag === "fibonacci").children
                .find(c => c.tag === "subtraction").children.find(c => c.tag === "divisor").attrs.value = "4";
        },
    },
    {
        label: "multipart fibonacci base (Heal The Sick loopCost, 2 -> 3)",
        expect: { name: "Heal The Sick", col: "loopCost[" },
        mutate: (doc) => {
            const lc = doc.actions["Heal The Sick"].children.find(c => c.tag === "loopCost");
            lc.children.find(c => c.tag === "fibonacci").children.find(c => c.tag === "value").attrs.value = "3";
        },
    },
    {
        label: "multipart totalCompletions (Heal The Sick tickProgress, /100 -> /101)",
        expect: { name: "Heal The Sick", col: "tick[" },
        mutate: (doc) => {
            const tp = doc.actions["Heal The Sick"].children.find(c => c.tag === "tickProgress");
            tp.children.filter(c => c.tag === "multiplier")[1].children[0].children
                .find(c => c.tag === "addition").children.find(c => c.tag === "divisor").attrs.value = "101";
        },
    },
    {
        label: "multipart canStart(loopCounter) (AssassinZ0, equals 0 -> 1)",
        expect: { name: "AssassinZ0", col: "canStartAt[" },
        mutate: (doc) => {
            const cs = doc.actions["AssassinZ0"].children.find(c => c.tag === "canStart");
            cs.children.find(c => c.tag === "if").attrs.equals = "1";
        },
    },
    {
        label: "multipart abs/clampMin penalty (AssassinZ3 tickProgress, rep clamp 1 -> 2)",
        expect: { name: "AssassinZ3", col: "tick[" },
        mutate: (doc) => {
            const tp = doc.actions["AssassinZ3"].children.find(c => c.tag === "tickProgress");
            tp.children.filter(c => c.tag === "divisor")[0].children
                .find(c => c.tag === "clampMin").attrs.value = "2";
        },
    },
    {
        label: "ifSoulstoneSac (Dark Ritual canStart, amount -> 999999999999)",
        expect: { name: "Dark Ritual", col: "canStart" },
        mutate: (doc) => {
            const cs = doc.actions["Dark Ritual"].children.find(c => c.tag === "canStart");
            const sac = cs.children.find(c => c.tag === "ifSoulstoneSac");
            sac.attrs.value = "999999999999";
            sac.children = [];   // drop the <primaryValue/> base the attr replaces
        },
    },
    {
        label: "buffCap path (Dark Ritual canStart, Ritual -> Imbuement cap changes the throw)",
        expect: { name: "Dark Ritual", col: "canStart" },
        mutate: (doc) => {
            const cs = doc.actions["Dark Ritual"].children.find(c => c.tag === "canStart");
            cs.children.filter(c => c.tag === "if").at(-1).children
                .find(c => c.tag === "buffCap").attrs.buffName = "Imbuement";
        },
    },
    {
        label: "dungeonCompleted (Small Dungeon tickProgress, /200 -> /201)",
        expect: { name: "Small Dungeon", col: "tick[" },
        mutate: (doc) => {
            const tp = doc.actions["Small Dungeon"].children.find(c => c.tag === "tickProgress");
            tp.children.find(c => c.tag === "multiplier").children[0].children
                .find(c => c.tag === "addition").children.find(c => c.tag === "divisor").attrs.value = "201";
        },
    },
    {
        label: "trialFloors + town-sourced loopCounter (Heroes Trial canStart, trial 0 -> 2)",
        expect: { name: "Heroes Trial", col: "canStart" },
        mutate: (doc) => {
            const cs = doc.actions["Heroes Trial"].children.find(c => c.tag === "canStart");
            cs.children.find(c => c.tag === "if").children
                .find(c => c.tag === "trialFloors").attrs.trialNum = "2";
        },
    },
    {
        label: "trial power-base loopCost (Secret Trial, 1.25 -> 1.3)",
        expect: { name: "Secret Trial", col: "loopCost[" },
        mutate: (doc) => {
            const lc = doc.actions["Secret Trial"].children.find(c => c.tag === "loopCost");
            lc.children.find(c => c.tag === "power").attrs.base = "1.3";
        },
    },
];

for (const { label, expect, mutate } of TARGETED_CANARIES) {
    test(`canary: ${label} diverges`, () => {
        const d = buildXmlDifferential({ maxMismatches: 5, mutate });
        // sweep columns carry an index ("loopCost[3]"): expect.col matches as a prefix
        assert.ok(d.mismatches.some(m => m.name === expect.name && m.col.startsWith(expect.col)),
            `mutation produced no ${expect.col} divergence for ${expect.name} — `
            + `the corpus cannot see through this construct (got: ${JSON.stringify(d.mismatches.slice(0, 3))})`);
    });
}
