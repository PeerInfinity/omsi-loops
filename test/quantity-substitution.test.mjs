// quantity-substitution.test.mjs — U4: AP-managed batch capacity (plan §3.5,
// §9 U4 and the [U4 PLANNING PASS — 2026-07-20] block).
//
// The claim under test: with `Unlocks.qManagedBatches` naming a var, that var's
// `total{Var}` becomes `min(batches, rowCount) x oneInEvery` and STOPS tracking
// progress levels — enforced from ONE choke point, the substitution loop at the
// end of `adjustAll()`. With the Map empty (vanilla, and every world until U5
// wires the AP surface) nothing is substituted, which is what the byte-gate and
// V4 omsi-parity prove behaviourally; leg 1 asserts the precondition.
//
// The two axes stay DECOUPLED by construction (leg 5): capacity is item-driven,
// but location triggers read live LEVELS through the dot product, never totals.
//
// Town-0 constants used throughout (verified against actionList.js:897 and the
// minted rows): Pots = 5/level over a batch of 10 => 50 rows, ratio 10.
// Locks = 1/level over a batch of 10 => 10 rows, ratio 10.
//
// Harness note: `qManagedBatches` is a module-level Map, so — like
// `suppressed`/`granted` in unlock-enforcement.test.mjs — every leg gets its own
// vm context instead of sharing one and cleaning up between legs.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

const SEED = 12345;

/** a booted context; adjustAll has run once, as it does after load() */
function boot() {
    const ctx = makeContext(SEED);
    ctx.ev("adjustAll()");
    return ctx;
}

/** set town-0 Wander to exactly `level` and recompute totals */
function setWander(ctx, level) {
    ctx.ev(`towns[0].expWander = towns[0].expFromLevel(${level}); adjustAll();`);
    assert.equal(ctx.ev("towns[0].getLevel('Wander')"), level, "level recipe missed");
}

const manage = (ctx, varName, batches) =>
    ctx.ev(`Unlocks.qManagedBatches.set(${JSON.stringify(varName)}, ${batches}); adjustAll();`);

const totals = (ctx) => ({
    pots: ctx.ev("towns[0].totalPots"),
    locks: ctx.ev("towns[0].totalLocks"),
});

test("leg 1: vanilla — an empty Map leaves totals tracking levels exactly", () => {
    const ctx = boot();
    assert.equal(ctx.ev("Unlocks.qManagedBatches.size"), 0);
    for (const L of [0, 1, 2, 7, 23, 50, 99, 100]) {
        setWander(ctx, L);
        const t = totals(ctx);
        assert.equal(t.pots, L * 5, `totalPots at Wander ${L}`);
        assert.equal(t.locks, L, `totalLocks at Wander ${L}`);
    }
});

test("leg 2: managed Pots — total is min(k,50)x10 regardless of level", () => {
    for (const k of [0, 1, 7, 50, 51, 999]) {
        const ctx = boot();
        manage(ctx, "Pots", k);
        const expected = Math.min(k, 50) * 10;
        for (const L of [0, 37, 100]) {
            setWander(ctx, L);
            const t = totals(ctx);
            assert.equal(t.pots, expected, `managed Pots at ${k} batches, Wander ${L}`);
            // ...and the unmanaged var beside it is untouched vanilla
            assert.equal(t.locks, L, `unmanaged Locks perturbed at Wander ${L}`);
        }
    }
});

test("leg 3: level growth re-pins — finishProgress crossings do not leak capacity", () => {
    const ctx = boot();
    setWander(ctx, 0);
    manage(ctx, "Pots", 3);
    assert.equal(ctx.ev("towns[0].totalPots"), 30);
    // drive real progress across several level crossings: finishProgress calls
    // adjustAll() on each one, so the substitution has to hold every time
    ctx.ev(`(() => {
        const town = towns[0];
        for (let L = 1; L <= 12; L++) town.finishProgress("Wander", town.expFromLevel(L) - town.expWander);
    })()`);
    assert.equal(ctx.ev("towns[0].getLevel('Wander')"), 12, "the climb did not reach level 12");
    assert.equal(ctx.ev("towns[0].totalPots"), 30, "managed capacity drifted across level crossings");
    assert.equal(ctx.ev("towns[0].totalLocks"), 12, "unmanaged Locks did not track its level");
});

test("leg 4: the guaranteed-one-per-batch invariant holds on granted capacity", () => {
    const ctx = boot();
    setWander(ctx, 0);
    manage(ctx, "Pots", 3);       // 30 pots = 3 complete batches of 10
    // the REAL path: Action.SmashPots.finish() -> town.finishRegular(varName, 10, ...)
    const goods = [];
    for (let i = 1; i <= 30; i++) {
        ctx.ev("Action.SmashPots.finish()");
        goods.push([ctx.ev("towns[0].checkedPots"), ctx.ev("towns[0].goodPots")]);
    }
    for (const [checked, good] of goods) {
        assert.equal(good, Math.floor(checked / 10), `good/checked mismatch at checked=${checked}`);
    }
    assert.equal(ctx.ev("towns[0].checkedPots"), 30, "the walk did not consume all granted capacity");
    assert.equal(ctx.ev("towns[0].goodPots"), 3, "3 granted batches did not yield 3 goods");
    // and the capacity is exhausted: further checks mint nothing new
    ctx.ev("Action.SmashPots.finish()");
    assert.equal(ctx.ev("towns[0].checkedPots"), 30, "checked exceeded the substituted total");
});

test("leg 5: decoupling — locations fire on LEVELS even at zero granted capacity", () => {
    const ctx = makeContext(SEED);
    ctx.ev(`
        globalThis.__events = [];
        Unlocks.onQuantityStep = (id) => __events.push(id);
        Unlocks.check();
        __events.length = 0;
    `);
    ctx.ev("adjustAll()");
    manage(ctx, "Pots", 0);
    // Wander 2 = base total 10 = the q:0:Pots:1 trigger, driven through the
    // real finishProgress so the diff pass runs the way the game runs it
    ctx.ev(`(() => {
        const town = towns[0];
        for (let L = 1; L <= 2; L++) town.finishProgress("Wander", town.expFromLevel(L) - town.expWander);
    })()`);
    const log = JSON.parse(ctx.ev("JSON.stringify(__events)"));
    assert.ok(log.includes("q:0:Pots:1"),
        `the location trigger must fire on levels, not capacity (got ${JSON.stringify(log)})`);
    assert.equal(ctx.ev("towns[0].totalPots"), 0, "managed capacity leaked from the location trigger");
});

test("leg 6: shrink — a total below `checked` is absorbed by the existing clamp", () => {
    // Observational, not a fix: installing a smaller grant mid-session leaves a
    // transient good > total, the same one-loop-approximation class as P2's
    // mid-loop install. What must NOT happen is a throw or a negative walk.
    const ctx = boot();
    setWander(ctx, 20);                        // 100 pots, vanilla
    for (let i = 0; i < 40; i++) ctx.ev("Action.SmashPots.finish()");
    assert.equal(ctx.ev("towns[0].checkedPots"), 40);
    assert.equal(ctx.ev("towns[0].goodPots"), 4);
    manage(ctx, "Pots", 1);                    // shrink to 10
    assert.equal(ctx.ev("towns[0].totalPots"), 10);
    assert.doesNotThrow(() => ctx.ev("Action.SmashPots.finish()"),
        "finishRegular threw on a shrunk total");
    // the game's own error-state clamp (town.js:130) pulled checked down to the
    // new total and recomputed good from it
    assert.equal(ctx.ev("towns[0].checkedPots"), 10, "the clamp did not pull checked down");
    assert.equal(ctx.ev("towns[0].goodPots"), 1, "good was not recomputed from the clamped total");
    assert.ok(ctx.ev("towns[0].totalPots - towns[0].checkedPots") >= 0, "negative walk state survived");
});

test("leg 7: excluded vars can never be managed", () => {
    const ctx = boot();
    for (const v of ctx.ev("JSON.parse(JSON.stringify(Unlocks.QUANTITY_EXCLUDED_VARS))")) {
        const fresh = boot();
        assert.throws(() => manage(fresh, v, 3), /excluded from randomization/,
            `managing excluded var ${v} did not throw`);
    }
    // and an unknown var is a hard error too, not a silent no-op
    assert.throws(() => manage(ctx, "NotAVar", 1), /no quantity rows/);
});
