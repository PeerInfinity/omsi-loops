// P2 automation transport (cross-game P2-A slice 2): what a sim context that
// RECEIVED a worldConfig actually measures. The planner and predictor workers
// run private engine copies; slice 2 makes the award schedule + priority prefs
// ride every request, and these are the behavioural consequences that makes
// planning self-correcting with zero scoring changes:
//   1. yield — a pool whose contents are mostly foreign measures its TRUE
//      (reduced) mana-per-execution, not the vanilla number the planner would
//      otherwise keep paying for;
//   2. branch — a disabled category changes ENGINE BEHAVIOUR, not just the
//      yield: when nothing enabled remains the walk falls back to checking,
//      so a tick-accurate sim needs the prefs, not just the schedule;
//   3. inertness — a null worldConfig (the standalone/unscheduled default in
//      every worker) leaves the context measuring exactly the vanilla world.
//
// The install call under test is the SAME ActionListXml.installWorldConfig the
// planner-worker "plan"/"optimize" handlers and the predictor-worker
// "setOptions" handler invoke — this file exercises the contract those three
// call sites depend on. The effect differential is blind to schedules by
// design (no JS arm), so this is a dedicated gate per the corpus rule.
import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";
import { WIRED_FILES, WIRED_PREP } from "./field-matrix.lib.mjs";

// Smash Pots: varName Pots, oneInEvery 10, vanilla loot = 100 mana.
const POOL_SIZE = 10;

// k0 stays vanilla; every other instance is awarded to another game. A local
// player harvesting this pool receives one tenth of the vanilla mana.
const MOSTLY_FOREIGN = [
    null,
    ...Array.from({ length: POOL_SIZE - 1 },
        (_, i) => ({ substrate: "jta", type: `Item${i + 1}`, count: 1 })),
];

function ctxWith(cfg) {
    const ctx = makeContext(12345, WIRED_FILES);
    ctx.ev(WIRED_PREP);
    ctx.setQueue([["Wander", 1]]);   // restart() pauses (DOM) on an empty queue
    // the install path the worker handlers use, verbatim
    assert.equal(ctx.ev(`ActionListXml.installWorldConfig(${JSON.stringify(cfg)})`), true);
    return ctx;
}

// Seed a discovered pool and open a fresh loop's walk over it, the state a
// worker inherits when it restores a mid-game snapshot at a loop boundary.
function seedPool(ctx, good = POOL_SIZE) {
    ctx.ev(`towns[0].totalPots = ${good * 10}`);
    ctx.ev(`towns[0].checkedPots = ${good * 10}`);
    ctx.ev(`towns[0].goodPots = ${good}`);
    ctx.ev(`towns[0].goodTempPots = ${good}`);
    ctx.ev("ActionListXml.onLoopRestart()");
}

/** Mana yielded by `n` re-harvests — the planner's measured manaPerExec input. */
function harvest(ctx, n) {
    const before = ctx.ev("timeNeeded");
    for (let i = 0; i < n; i++) ctx.ev("Action.SmashPots.finish()");
    return ctx.ev("timeNeeded") - before;
}

const ledger = (ctx) => JSON.parse(ctx.ev(
    `JSON.stringify({checked: towns[0].checkedPots, good: towns[0].goodPots, goodTemp: towns[0].goodTempPots})`));

test("scheduled world: the sim measures the TRUE reduced pool yield", () => {
    const vanilla = ctxWith(null);
    seedPool(vanilla);
    const vanillaMana = harvest(vanilla, POOL_SIZE);
    assert.ok(vanillaMana > 0, "test premise: the vanilla pool yields mana");

    const scheduled = ctxWith({
        awardSchedule: { version: 1, lootables: { Pots: { contents: MOSTLY_FOREIGN } } },
        lootPrefs: {},
    });
    seedPool(scheduled);
    const scheduledMana = harvest(scheduled, POOL_SIZE);

    // 1 of 10 instances is still the local player's; the other 9 are awarded
    // to another game and yield the local sim nothing
    assert.equal(scheduledMana, vanillaMana / POOL_SIZE,
        "a mostly-foreign pool measures one tenth of the vanilla yield");
    // the anti-vacuous half: the pool was really walked, not skipped
    assert.equal(ledger(scheduled).goodTemp, 0, "every instance was consumed");
});

test("disabled categories flip the check-vs-harvest branch, not just the yield", () => {
    // vanilla-only pool, so the ONLY difference between the two arms is the
    // priority pref — the walk's own behaviour is what is under test
    const schedule = { version: 1, lootables: { Pots: { contents: [null] } } };

    const enabled = ctxWith({ awardSchedule: schedule, lootPrefs: {} });
    seedPool(enabled, 3);
    const enabledMana = harvest(enabled, 3);
    const afterEnabled = ledger(enabled);
    assert.equal(afterEnabled.goodTemp, 0, "the walk consumed the known goods");
    assert.equal(afterEnabled.checked, 30, "no new checking was needed");

    const disabled = ctxWith({
        awardSchedule: schedule,
        lootPrefs: { Pots: { order: [], disabled: ["vanilla"] } },
    });
    seedPool(disabled, 3);
    disabled.ev("towns[0].totalPots = 500");   // leave something to check
    const disabledMana = harvest(disabled, 3);
    const afterDisabled = ledger(disabled);

    assert.equal(afterDisabled.goodTemp, 3, "no known good was re-harvested");
    assert.equal(afterDisabled.checked, 33, "the walk fell back to CHECKING");
    assert.notEqual(disabledMana, enabledMana,
        "the prefs changed what the sim measures");
});

test("null worldConfig: the context measures the vanilla world exactly", () => {
    // the default in every worker — this is the byte-inertness the whole
    // transport rests on
    const plain = makeContext(12345, WIRED_FILES);
    plain.ev(WIRED_PREP);
    plain.setQueue([["Wander", 1]]);
    seedPool(plain);
    const plainMana = harvest(plain, POOL_SIZE);
    const plainLedger = ledger(plain);

    const installed = ctxWith(null);
    seedPool(installed);
    assert.equal(harvest(installed, POOL_SIZE), plainMana);
    assert.deepEqual(ledger(installed), plainLedger);
    assert.equal(installed.ev("ActionListXml.getAwardSchedule()"), null,
        "no schedule state was created");
});

test("clearing mid-session restores the vanilla measurement (self-healing)", () => {
    // the worker is long-lived: the player can install a schedule and clear it
    // without the worker being recreated, so install must be stateless per
    // request rather than once-at-boot
    const ctx = ctxWith({
        awardSchedule: { version: 1, lootables: { Pots: { contents: MOSTLY_FOREIGN } } },
        lootPrefs: {},
    });
    seedPool(ctx);
    const scheduledMana = harvest(ctx, POOL_SIZE);

    assert.equal(ctx.ev("ActionListXml.installWorldConfig(null)"), true);
    seedPool(ctx);
    const clearedMana = harvest(ctx, POOL_SIZE);
    assert.equal(clearedMana, scheduledMana * POOL_SIZE,
        "the cleared context is back to full vanilla yield");
});
