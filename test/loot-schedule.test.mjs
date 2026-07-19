// P2 lootable contents schedule (cross-game §9b-pre): k-th-good keying,
// discovery memory, and the priority-ordered re-harvest walk. Strata:
//   1. discovery — the k-th good is revealed and harvested per contents[k]
//      in vanilla order, minting the persistent category census;
//   2. re-harvest — the goodTemp walk consumes known goods per category
//      priority (default: vanilla first, dummy last), ascending k inside a
//      category; disables skip; exhausted-enabled falls through to nothing
//      when no unchecked remain;
//   3. per-loop — restart() rebuilds the walk from (contents, good) and
//      reconciles the census (an old save entering a scheduled world);
//   4. persistence — the census saves beside the ledger vars and restores
//      assign-or-DELETE;
//   5. inertness — no lootables schedule ⇒ Town.finishRegular's vanilla
//      body runs (the delegation guard is the only touched line).
//
// Smash Pots is the exemplar: varName Pots, oneInEvery 10, vanilla loot =
// 100 mana (goldCost at default skills).
import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";
import { WIRED_FILES, WIRED_PREP } from "./field-matrix.lib.mjs";

const CONTENTS = [
    null,                                        // k0 vanilla (mana)
    { name: "gold", count: 5 },                  // k1 local re-route
    { dummy: true },                             // k2 dummy
    { substrate: "jta", type: "Food", count: 1 }, // k3 foreign
];

function wiredCtx() {
    const ctx = makeContext(12345, WIRED_FILES);
    ctx.ev(WIRED_PREP);
    ctx.setQueue([["Wander", 1]]);   // restart() pauses (DOM) on an empty queue
    return ctx;
}

function withSchedule(ctx) {
    assert.equal(ctx.ev(`ActionListXml.setAwardSchedule(${JSON.stringify({
        version: 1,
        lootables: { Pots: { contents: CONTENTS } },
    })})`), true);
}

const pots = (ctx, k) => ctx.ev(`towns[0].${k}Pots`);
const finish = (ctx, n = 1) => { for (let i = 0; i < n; i++) ctx.ev("Action.SmashPots.finish()"); };

test("discovery: contents revealed at the k-th good, census minted", () => {
    const ctx = wiredCtx();
    withSchedule(ctx);
    ctx.ev("globalThis.__foreign = []; ActionListXml.setForeignAwardHook(i => __foreign.push(i))");
    ctx.ev("towns[0].totalPots = 100");

    let before = ctx.ev("timeNeeded");
    finish(ctx, 10);   // checks 1..10 -> good 0 minted: vanilla mana
    assert.equal(ctx.ev("timeNeeded"), before + 100, "k0 vanilla loot = 100 mana");
    assert.equal(pots(ctx, "good"), 1);
    assert.equal(pots(ctx, "lootFrom"), 100, "vanilla harvest feeds lootFrom");

    before = ctx.ev("timeNeeded");
    finish(ctx, 10);   // good 1: local gold x5
    assert.equal(ctx.ev("timeNeeded"), before, "re-routed good grants no mana");
    assert.equal(ctx.ev("resources.gold"), 5, "k1 landed as gold x5");
    assert.equal(pots(ctx, "lootFrom"), 100, "re-route contributes 0 to lootFrom");

    finish(ctx, 10);   // good 2: dummy
    assert.equal(ctx.ev("resources.gold"), 5, "dummy grants nothing");

    finish(ctx, 10);   // good 3: foreign
    const calls = JSON.parse(ctx.ev("JSON.stringify(__foreign)"));
    assert.deepEqual(calls, [{
        varName: "Pots", resource: "loot", index: 3,
        substrate: "jta", type: "Food", count: 1,
    }]);

    finish(ctx, 10);   // good 4: past schedule end -> vanilla
    assert.equal(pots(ctx, "lootFrom"), 200, "k4 beyond contents is vanilla");

    assert.deepEqual(JSON.parse(ctx.ev("JSON.stringify(towns[0].lootCensusPots)")), {
        "vanilla": 2, "local:gold": 1, "dummy": 1, "foreign:jta/Food": 1,
    });
});

test("re-harvest: default priority = vanilla, locals/foreign by first k, dummy last", () => {
    const ctx = wiredCtx();
    withSchedule(ctx);
    ctx.ev("globalThis.__foreign = []; ActionListXml.setForeignAwardHook(i => __foreign.push(i))");
    // all four goods discovered in an earlier session; nothing unchecked
    ctx.ev("towns[0].totalPots = 40; towns[0].checkedPots = 40; towns[0].goodPots = 4");
    ctx.restart();     // goodTemp := good, walk state rebuilds

    assert.equal(pots(ctx, "goodTemp"), 4);
    let before = ctx.ev("timeNeeded");
    finish(ctx);       // 1st: vanilla (k0)
    assert.equal(ctx.ev("timeNeeded"), before + 100);
    finish(ctx);       // 2nd: local:gold (k1)
    assert.equal(ctx.ev("resources.gold"), 5);
    finish(ctx);       // 3rd: foreign (k3) — others before dummy
    assert.equal(JSON.parse(ctx.ev("JSON.stringify(__foreign)")).length, 1);
    before = ctx.ev("timeNeeded");
    finish(ctx);       // 4th: dummy (k2) last
    assert.equal(ctx.ev("timeNeeded"), before, "dummy grants nothing");
    assert.equal(pots(ctx, "goodTemp"), 0);

    // census reconciled from world data at the rebuild
    assert.deepEqual(JSON.parse(ctx.ev("JSON.stringify(towns[0].lootCensusPots)")), {
        "vanilla": 1, "local:gold": 1, "dummy": 1, "foreign:jta/Food": 1,
    });
});

test("re-harvest: user priority order and disables", () => {
    const ctx = wiredCtx();
    withSchedule(ctx);
    ctx.ev("globalThis.__foreign = []; ActionListXml.setForeignAwardHook(i => __foreign.push(i))");
    ctx.ev("towns[0].totalPots = 40; towns[0].checkedPots = 40; towns[0].goodPots = 4");
    ctx.restart();
    ctx.ev(`ActionListXml.setLootPriority("Pots", ["local:gold"], ["dummy"])`);

    finish(ctx);       // 1st: local:gold (user priority)
    assert.equal(ctx.ev("resources.gold"), 5);
    const before = ctx.ev("timeNeeded");
    finish(ctx);       // 2nd: vanilla (default order after prefs)
    assert.equal(ctx.ev("timeNeeded"), before + 100);
    finish(ctx);       // 3rd: foreign
    assert.equal(JSON.parse(ctx.ev("JSON.stringify(__foreign)")).length, 1);
    finish(ctx);       // 4th: dummy disabled + nothing unchecked -> no-op
    assert.equal(pots(ctx, "goodTemp"), 1, "disabled category is never harvested");
    assert.equal(JSON.parse(ctx.ev("JSON.stringify(__foreign)")).length, 1);

    // getLootView reflects order, census and remaining
    const view = JSON.parse(ctx.ev(`JSON.stringify(ActionListXml.getLootView("Pots"))`));
    assert.deepEqual(view.map((v) => v.category),
        ["local:gold", "vanilla", "foreign:jta/Food", "dummy"]);
    assert.deepEqual(view.map((v) => v.remaining), [0, 0, 0, 1]);
    assert.equal(view.find((v) => v.category === "dummy").disabled, true);
});

test("restart rewinds the walk; priorities persist for the session", () => {
    const ctx = wiredCtx();
    withSchedule(ctx);
    ctx.ev("towns[0].totalPots = 40; towns[0].checkedPots = 40; towns[0].goodPots = 4");
    ctx.restart();
    ctx.ev(`ActionListXml.setLootPriority("Pots", ["local:gold"], [])`);
    finish(ctx);
    assert.equal(ctx.ev("resources.gold"), 5);
    ctx.restart();     // resources wiped, walk rebuilt
    assert.equal(ctx.ev("resources.gold"), 0, "restart wiped the grant (D4)");
    finish(ctx);
    assert.equal(ctx.ev("resources.gold"), 5, "walk rewound: gold again");
});

test("census persists in the save and restores assign-or-DELETE", () => {
    const ctx = wiredCtx();
    withSchedule(ctx);
    ctx.ev("towns[0].totalPots = 100");
    finish(ctx, 20);   // two goods discovered -> census {vanilla:1, local:gold:1}
    const saved = ctx.ev("JSON.stringify(doSave())");
    const doc = JSON.parse(saved);
    assert.deepEqual(doc.lootCensusPots, { "vanilla": 1, "local:gold": 1 },
        "census rides the save beside the ledger vars");

    // stale census must not survive a load that lacks one (old save)
    ctx.ev("towns[0].lootCensusPots = { stale: 9 }");
    const noCensus = JSON.stringify((({ lootCensusPots, ...rest }) => rest)(doc));
    ctx.ev(`(function(){ const toLoad = ${noCensus};
        for (const town of towns) for (const action of town.totalActionList) {
            if (action.type !== "limited") continue;
            const varName = action.varName;
            if (toLoad["lootCensus" + varName] !== undefined)
                town["lootCensus" + varName] = toLoad["lootCensus" + varName];
            else
                delete town["lootCensus" + varName];
        } })()`);
    assert.equal(ctx.ev("towns[0].lootCensusPots"), undefined,
        "absent census deletes the stale one");
});

test("inertness: no lootables schedule leaves the vanilla walk untouched", () => {
    const ctx = wiredCtx();
    // a schedule WITHOUT lootables must not delegate finishRegular
    assert.equal(ctx.ev(`ActionListXml.setAwardSchedule({ version: 1 })`), true);
    ctx.ev("towns[0].totalPots = 100");
    const before = ctx.ev("timeNeeded");
    finish(ctx, 10);
    assert.equal(ctx.ev("timeNeeded"), before + 100, "vanilla discovery loot");
    assert.equal(ctx.ev("towns[0].lootCensusPots"), undefined, "no census minted");
});
