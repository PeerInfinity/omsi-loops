// unlock-events.test.mjs — the U2 event surface (plan §5.3, §7.4).
//
// The load-bearing test is the EMISSION ORDER one: a single progress var driven
// through a long climb must announce its milestone rows in a deterministic
// sequence, because the AP host turns each one into a location check. Order
// within a same-level wave is table order (predicate rows in XML action order,
// then quantity rows) — asserted here so it cannot drift silently.
//
// Nothing consumes these events yet; U5 wires the AP surface.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

/** a context with both callbacks recording into one ordered log */
function recordingContext() {
    const ctx = makeContext(12345);
    ctx.ev(`
        globalThis.__events = [];
        Unlocks.onUnlockAchieved = (id) => __events.push(id);
        Unlocks.onQuantityStep   = (id) => __events.push(id);
        Unlocks.check();                       // baseline: fresh game
        __events.length = 0;                   // drop the fresh-boot ALWAYS rows
    `);
    return ctx;
}

/** drive town-0 Wander to `level`, one level at a time, through finishProgress */
const climbWander = (ctx, level) => ctx.ev(`(() => {
    const town = towns[0];
    for (let L = 1; L <= ${level}; L++) {
        town.finishProgress("Wander", 100 * L * (L + 1) / 2 - town.expWander);
    }
})()`);

const events = (ctx) => JSON.parse(ctx.ev("JSON.stringify(__events)"));

test("event order: the Wander 0 -> 22 climb emits its milestones in order", () => {
    const ctx = recordingContext();
    climbWander(ctx, 22);
    const log = events(ctx);

    // Pots: 5 capacity/level over a batch of 10 => a batch every 2 levels.
    // Locks: 1 capacity/level over a batch of 10 => a batch every 10 levels.
    // The predicate milestones land at Wander 20 (Buy Glasses, Buy Mana, Pick
    // Locks) and 22 (Met).
    assert.deepEqual(log, [
        "q:0:Pots:1",   // level 2
        "q:0:Pots:2",   // 4
        "q:0:Pots:3",   // 6
        "q:0:Pots:4",   // 8
        "q:0:Pots:5", "q:0:Locks:1",   // 10 — Pots batch 5 and Locks batch 1
        "q:0:Pots:6",   // 12
        "q:0:Pots:7",   // 14
        "q:0:Pots:8",   // 16
        "q:0:Pots:9",   // 18
        // Level 20: predicate rows first, then the quantity rows, each family in
        // TABLE order. Note Pick Locks precedes Buy Glasses — that is the XML's
        // own action order (Wander, Pots, Locks, BuyGlasses, ... BuyManaZ1), not
        // the threshold order, and it is the documented tiebreak for a wave.
        "u:Locks", "u:BuyGlasses", "u:BuyManaZ1", "q:0:Pots:10", "q:0:Locks:2",
        "u:Met",        // 22
        "q:0:Pots:11",  // 22
    ]);
});

test("event order: only `unlocked` rows fire; visible rows are silent", () => {
    const ctx = recordingContext();
    climbWander(ctx, 22);
    for (const id of events(ctx)) {
        assert.ok(!id.startsWith("v:"), `visible row ${id} must not emit (plan §3.2)`);
    }
});

test("a SUPPRESSED row still emits — suppression gates effect, not the check", () => {
    // plan §7.1: an AP-suppressed row whose local conditions are met has still
    // been achieved locally, and that IS the location trigger. If suppression
    // silenced the event, an AP world would never check the location that
    // grants the very item it is waiting for.
    const ctx = recordingContext();
    ctx.ev(`Unlocks.suppressed.add("u:Locks")`);
    climbWander(ctx, 22);
    const log = events(ctx);
    assert.ok(log.includes("u:Locks"), "a suppressed row must still announce local achievement");
    // and the suppression really is in force on the EFFECT side
    assert.equal(ctx.ev(`String(Unlocks.predicate("Locks", "unlocked"))`), "false");
});

test("a re-seeded id does not re-emit", () => {
    const ctx = recordingContext();
    ctx.ev(`Unlocks.seedReported(["u:Locks", "q:0:Pots:1"])`);
    climbWander(ctx, 22);
    const log = events(ctx);
    assert.ok(!log.includes("u:Locks"), "the host already holds u:Locks");
    assert.ok(!log.includes("q:0:Pots:1"), "the host already holds q:0:Pots:1");
    // unseeded siblings are unaffected
    assert.ok(log.includes("u:BuyGlasses"));
    assert.ok(log.includes("q:0:Pots:2"));
});

test("after a wipe, an UNSEEDED row re-emits and a seeded one does not", () => {
    // Prestige re-crossing must re-fire (server-side dedupe makes it harmless,
    // and AP own-world re-completion depends on it), but a row the host has
    // confirmed stays suppressed across the wipe — the reported set is
    // deliberately not cleared.
    const ctx = recordingContext();
    climbWander(ctx, 22);
    assert.ok(events(ctx).includes("u:Locks"));

    ctx.ev(`
        Unlocks.seedReported(["u:BuyGlasses"]);   // the host banks one of them
        towns[0].expWander = 0;                   // the wipe
        Unlocks.check();
        __events.length = 0;
    `);
    // the rows really did relock
    assert.equal(ctx.ev(`String(Unlocks.achieved.has("u:Locks"))`), "false");

    climbWander(ctx, 22);
    const log = events(ctx);
    assert.ok(log.includes("u:Locks"), "an unseeded row must re-fire after a wipe");
    assert.ok(log.includes("q:0:Pots:1"), "quantity rows re-fire on regrowth too");
    assert.ok(!log.includes("u:BuyGlasses"), "a host-confirmed row stays suppressed across the wipe");
});

test("onActionCompleted fires at the real completion sites", () => {
    const ctx = makeContext(12345);
    ctx.ev(`
        globalThis.__completed = [];
        Unlocks.onActionCompleted = (name, kind) => __completed.push(name + ":" + kind);
    `);
    // run a real loop through the chunk driver — never getNextValidAction,
    // which MUTATES (standing fork trap)
    ctx.setQueue([["Wander", 3], ["Smash Pots", 5]]);
    ctx.restart();
    ctx.ev(`addMana(5000)`);
    for (let i = 0; i < 100_000; i++) if (ctx.step(0).ended) break;

    const completed = JSON.parse(ctx.ev("JSON.stringify(__completed)"));
    assert.ok(completed.length > 0, "no action completions were dispatched");
    assert.ok(completed.some(c => c.startsWith("Wander:")), `expected Wander completions, got ${completed.slice(0, 5)}`);
    // the kinds are the four dispatch sites' vocabulary
    for (const c of completed) {
        assert.match(c, /:(segment|loop|finish)$/);
    }
});

test("with no callbacks installed the pass is inert", () => {
    // the byte-gate's claim, asserted directly: check() with null callbacks
    // computes and records but reaches nothing observable
    const ctx = makeContext(12345);
    const before = ctx.ev(`JSON.stringify({ pots: towns[0].totalPots, exp: towns[0].expWander })`);
    ctx.ev(`Unlocks.check()`);
    climbWander(ctx, 5);
    ctx.ev(`Unlocks.check()`);
    assert.equal(ctx.ev(`String(Unlocks.onUnlockAchieved)`), "null");
    assert.equal(ctx.ev(`String(Unlocks.achievedReported.size)`), "0",
        "emission must not write to the reported set — that is the host's to seed");
    assert.notEqual(ctx.ev(`JSON.stringify({ pots: towns[0].totalPots, exp: towns[0].expWander })`), before);
});
