// P2 award carrier (cross-game §2d): a world-data schedule consulted at the
// ONE grant dispatcher in actionListXml.js (grantResource). Strata:
//   1. validation — a bad document is rejected WHOLE and the carrier stays
//      inert (world data must not half-apply);
//   2. routing — local re-route / dummy suppression / vanilla fall-through
//      at exact per-loop grant indices. The re-route case doubles as the
//      anti-vacuous canary: an installed entry must CHANGE what the live
//      compiled action grants;
//   3. per-loop counters — restart() rewinds the grant index (the schedule
//      keys completion-index-WITHIN-LOOP, matching resetResources);
//   4. foreign entries — no hook ⇒ dropped locally (the declared
//      semantics); a registered hook receives the exact payload.
//
// The effect differential can't see any of this (schedules exist only on
// the wired path BY DESIGN — there is no JS arm to compare against), so
// this file is the carrier's dedicated gate per the corpus rule.
import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";
import { WIRED_FILES, WIRED_PREP } from "./field-matrix.lib.mjs";

// Buy Mana Z1: normal-type town-0 action, zero RNG, deterministic reward
// (mana += gold × primaryValue(50), then gold resets) — a clean single
// numericResource grant to steer.
const TARGET = "BuyManaZ1";

function wiredCtx() {
    const ctx = makeContext(12345, WIRED_FILES);
    ctx.ev(WIRED_PREP);
    assert.equal(ctx.ev(`Action.${TARGET}.varName`), TARGET,
        "test premise: Buy Mana Z1's varName");
    // restart() pauses (DOM access) on an empty queue — keep one queued
    ctx.setQueue([["Wander", 1]]);
    return ctx;
}

function setSchedule(ctx, schedule) {
    return ctx.ev(`ActionListXml.setAwardSchedule(${JSON.stringify(schedule)})`);
}

test("no schedule: vanilla grant (baseline for every stratum below)", () => {
    const ctx = wiredCtx();
    ctx.ev("resources.gold = 10");
    const before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before + 500, "10 gold × 50 mana");
    assert.equal(ctx.ev("resources.gold"), 0, "spend-all converter resets gold");
});

test("validation: bad documents are rejected whole, carrier stays inert", () => {
    const ctx = wiredCtx();
    const bad = [
        { awards: { [TARGET]: { mana: [{ name: "glasses", count: 1 }] } } },   // boolean resource
        { awards: { [TARGET]: { glasses: [null] } } },                          // boolean site key
        { awards: { [TARGET]: { mana: [{ name: "gold", count: 0 }] } } },       // non-positive count
        { awards: { [TARGET]: { mana: [{ name: "gold", count: 1.5 }] } } },     // non-integer count
        { awards: { [TARGET]: { mana: [{ substrate: "", type: "x" }] } } },     // empty substrate
        { awards: { [TARGET]: { mana: [{ substrate: "omsi", type: "x" }] } } }, // self-foreign
        { awards: { [TARGET]: { mana: [{ dummy: true, name: "gold" }] } } },    // mixed entry
        { awards: { [TARGET]: { mana: { 0: null } } } },                        // non-array
        { awards: { [TARGET]: { mana: [{}] } } },                               // empty entry
    ];
    for (const schedule of bad) {
        assert.equal(setSchedule(ctx, schedule), false, JSON.stringify(schedule));
        assert.equal(ctx.ev("ActionListXml.getAwardSchedule()"), null);
    }
    // rejected schedule leaves behavior vanilla
    ctx.ev("resources.gold = 10");
    const before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before + 500);
});

test("routing: local re-route, dummy, vanilla fall-through by index", () => {
    const ctx = wiredCtx();
    // grant 1 re-routed to 3 herbs, grant 2 suppressed, grant 3+ vanilla
    assert.equal(setSchedule(ctx, {
        version: 1,
        awards: { [TARGET]: { mana: [{ name: "herbs", count: 3 }, { dummy: true }] } },
    }), true);

    ctx.ev("resources.gold = 10");
    let before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before, "grant 1 re-routed away from mana");
    assert.equal(ctx.ev("resources.herbs"), 3, "grant 1 landed as herbs");

    ctx.ev("resources.gold = 10");
    before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before, "grant 2 suppressed (dummy)");
    assert.equal(ctx.ev("resources.herbs"), 3, "dummy grants nothing anywhere");

    ctx.ev("resources.gold = 10");
    before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before + 500, "beyond schedule end: vanilla");
});

test("counters are per-loop: restart() rewinds the grant index", () => {
    const ctx = wiredCtx();
    assert.equal(setSchedule(ctx, {
        awards: { [TARGET]: { mana: [{ dummy: true }] } },
    }), true);

    ctx.ev("resources.gold = 10");
    let before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before, "loop 1 grant 1 suppressed");

    ctx.restart();

    ctx.ev("resources.gold = 10");
    before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before, "after restart the index rewound: suppressed again");

    ctx.ev("resources.gold = 10");
    before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before + 500, "second grant of the loop: vanilla");
});

test("clearing the schedule restores vanilla and drops counters", () => {
    const ctx = wiredCtx();
    assert.equal(setSchedule(ctx, {
        awards: { [TARGET]: { mana: [{ dummy: true }] } },
    }), true);
    ctx.ev("resources.gold = 10");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(setSchedule(ctx, null), true);
    ctx.ev("resources.gold = 10");
    const before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before + 500);
});

test("foreign entry: dropped locally without a hook; hook gets the payload", () => {
    const ctx = wiredCtx();
    assert.equal(setSchedule(ctx, {
        awards: { [TARGET]: { mana: [{ substrate: "jta", type: "food", count: 2 }] } },
    }), true);

    // no hook: the grant is dropped locally — nothing lands anywhere
    ctx.ev("resources.gold = 10");
    let before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before, "foreign grant drops the local mana");

    ctx.restart();
    ctx.ev("globalThis.__foreignAwards = []; ActionListXml.setForeignAwardHook(i => __foreignAwards.push(i))");
    ctx.ev("resources.gold = 10");
    before = ctx.ev("timeNeeded");
    ctx.ev(`Action.${TARGET}.finish()`);
    assert.equal(ctx.ev("timeNeeded"), before, "foreign grant still drops the local mana");
    const calls = JSON.parse(ctx.ev("JSON.stringify(__foreignAwards)"));
    assert.deepEqual(calls, [{
        varName: TARGET, resource: "mana", index: 0,
        substrate: "jta", type: "food", count: 2,
    }]);

    // a throwing hook must not break the action
    ctx.restart();
    ctx.ev("ActionListXml.setForeignAwardHook(() => { throw new Error('boom'); })");
    ctx.ev("resources.gold = 10");
    ctx.ev(`Action.${TARGET}.finish()`);
});
