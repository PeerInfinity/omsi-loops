// Buy Mana / zone-1 economy optimiser (IdlePlanner.optimizeEconomy, §11.6
// assist-ladder, user scope 2026-07-13) — headless tests for the pure engine
// function. Ports the L0 harness fixtures (CC/scripts/omsi-stats/buy-mana-opt.mjs):
// each sets a town-0 economy state, hands the optimiser a mis-shaped queue, and
// asserts it reaches the economical optimum (full harvest, all gold converted,
// fewest conversions). The DOM/apply path is covered by ui-smoke, not here.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

// Run the optimiser entirely inside the sim vm (avoids cross-realm array
// quirks): set a town-0 economy state, snapshot, optimise `queue`.
function runOpt({ pots, locks, queue }) {
    const ctx = makeContext(12345, ["planner-metadata.js", "planner.js"]);
    const out = ctx.ev(`(() => {
        const sess = new IdlePlanner.Session();
        actions.clearActions(); actions.addAction("Wander", 1); restart();
        towns[0].expWander = getExpOfLevel(30);
        towns[0].totalPots = ${pots}; towns[0].checkedPots = ${pots};
        towns[0].goodPots = ${pots}; towns[0].goodTempPots = ${pots};
        towns[0].totalLocks = ${locks}; towns[0].checkedLocks = ${locks};
        towns[0].goodLocks = ${locks}; towns[0].goodTempLocks = ${locks};
        adjustAll(); restart();
        const snap = sess.save();
        const res = IdlePlanner.optimizeEconomy(sess, snap, ${JSON.stringify(queue)});
        return JSON.stringify({ queue: res.queue, report: res.report });
    })()`);
    return JSON.parse(out);
}
const nBuyMana = (q) => q.filter(([n]) => n === "Buy Mana Z1").reduce((s, [, l]) => s + l, 0);

test("REMOVE — drops redundant Buy Mana conversions (3 -> 1)", () => {
    const { queue, report } = runOpt({ pots: 100, locks: 5, queue: [
        ["Buy Mana Z1", 1], ["Smash Pots", 100], ["Pick Locks", 5], ["Buy Mana Z1", 1], ["Buy Mana Z1", 1],
    ] });
    assert.equal(report.after.failed, 0);
    assert.equal(report.after.unconvGold, 0);
    assert.equal(report.after.convExecs, 1, "one conversion suffices");
    assert.equal(nBuyMana(queue), 1);
});

test("REORDER — moves converter after its income (no unconverted gold)", () => {
    const { queue, report } = runOpt({ pots: 100, locks: 5, queue: [
        ["Buy Mana Z1", 1], ["Smash Pots", 100], ["Pick Locks", 5],
    ] });
    assert.equal(report.before.unconvGold > 0, true, "starts with unconverted gold");
    assert.equal(report.after.unconvGold, 0);
    assert.equal(report.after.convExecs, 1);
    assert.equal(queue.at(-1)[0], "Buy Mana Z1", "converter ends up last (after income)");
});

test("MERGE — coalesces unnecessarily-split harvest entries", () => {
    const { queue } = runOpt({ pots: 100, locks: 5, queue: [
        ["Smash Pots", 100], ["Pick Locks", 2], ["Pick Locks", 3], ["Buy Mana Z1", 1],
    ] });
    // Pick Locks x2 + x3 -> a single x5 entry in the output
    const picks = queue.filter(([n]) => n === "Pick Locks");
    assert.equal(picks.length, 1);
    assert.equal(picks[0][1], 5);
});

test("RESERVE GOLD — funds a downstream purchase before converting", () => {
    const { queue, report } = runOpt({ pots: 100, locks: 5, queue: [
        ["Smash Pots", 100], ["Pick Locks", 5], ["Buy Mana Z1", 1], ["Buy Glasses", 1],
    ] });
    assert.equal(report.before.failed, 1, "purchase starved before optimisation");
    assert.equal(report.after.failed, 0, "purchase funded after optimisation");
    // converter now sits after Buy Glasses so the 10 gold it needs survives
    const gi = queue.findIndex(([n]) => n === "Buy Glasses");
    const ci = queue.findIndex(([n]) => n === "Buy Mana Z1");
    assert.equal(gi >= 0 && ci > gi, true, "converter after the purchase");
});

test("SPLIT+INSERT — inserts a mid-harvest conversion when the budget starves", () => {
    const { queue, report } = runOpt({ pots: 22, locks: 6, queue: [
        ["Smash Pots", 22], ["Pick Locks", 6], ["Buy Mana Z1", 1],
    ] });
    assert.equal(report.before.failed > 0, true, "one harvest block starves");
    assert.equal(report.after.failed, 0, "split + intermediate conversion recovers the harvest");
    assert.equal(report.after.convExecs, 2, "keeps two load-bearing conversions");
    assert.equal(nBuyMana(queue), 2);
});

test("SPLIT+INSERT+REMOVE — keeps load-bearing conversions, drops the redundant one", () => {
    const { report } = runOpt({ pots: 22, locks: 6, queue: [
        ["Smash Pots", 22], ["Pick Locks", 3], ["Buy Mana Z1", 1], ["Buy Mana Z1", 1], ["Pick Locks", 3], ["Buy Mana Z1", 1],
    ] });
    assert.equal(report.after.failed, 0);
    assert.equal(report.after.unconvGold, 0);
    assert.equal(report.after.convExecs, 2, "3 queued -> 2 executed (dropped the redundant)");
});

test("byte-inert shape — returns coalesced [name, loops] entries", () => {
    const { queue } = runOpt({ pots: 100, locks: 5, queue: [
        ["Smash Pots", 100], ["Pick Locks", 5], ["Buy Mana Z1", 1],
    ] });
    for (const e of queue) {
        assert.equal(Array.isArray(e), true);
        assert.equal(typeof e[0], "string");
        assert.equal(typeof e[1], "number");
    }
});
