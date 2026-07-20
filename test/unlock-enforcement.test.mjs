// test/unlock-enforcement.test.mjs — U3: runtime enforcement of AP-suppressed
// unlocks (unlock-discretization plan §6.4).
//
// The claim under test: `Unlocks.blocked(action)` gates EXECUTION at the one
// choke point the runtime actually uses (`getNextValidAction`'s skip loop), and
// it gates on AP SUPPRESSION rather than on local unlock state. So:
//
//   suppressed & !granted  ->  never executes, whatever the local conditions say
//   suppressed &  granted  ->  executes, whatever the local conditions say
//   !suppressed            ->  exactly vanilla (the inertness leg)
//
// Both directions matter: the item is authoritative, not the town level.
//
// Harness notes (standing rules, learned the hard way):
//   - drive with the `tick-goldens.lib.mjs` driver (`ctx.step`), never call
//     `getNextValidAction` directly — it MUTATES currentPos/currentAction.
//   - a fully-skipped queue is a degenerate 0-mana loop: `totals.loops` does
//     NOT advance, so loop termination is asserted from the step driver's
//     `ended` flag (which is `shouldRestart`), not from a loop counter.
//   - `Unlocks.suppressed`/`granted` are module-level Sets, so every leg gets
//     its own vm context rather than sharing and cleaning up.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

const SEED = 12345;

/** a fresh context with optional persistent-state recipe, queue installed */
function boot({ recipe = "", post = "", queue = [], suppressed = [], granted = [] } = {}) {
    const ctx = makeContext(SEED);
    if (recipe) ctx.ev(recipe);
    // load() runs adjustAll() once after restoring state; limited actions'
    // allowed() reads the ledgers it populates (total{Var}), so without it a
    // limited action is refused before the skip loop is ever reached.
    ctx.ev("adjustAll()");
    // anything that must survive adjustAll's recomputation goes here
    if (post) ctx.ev(post);
    for (const id of suppressed) ctx.ev(`Unlocks.suppressed.add(${JSON.stringify(id)})`);
    for (const id of granted) ctx.ev(`Unlocks.granted.add(${JSON.stringify(id)})`);
    ctx.setQueue(queue);
    ctx.restart();
    return ctx;
}

/**
 * One engine tick, the real entry point (`actions.tick` is what the driver
 * calls; `getNextValidAction` MUTATES and is never called directly here).
 *
 * Read the head action's state from INSIDE the loop: `ctx.step` would run
 * loopEnd()/prepareRestart() on the same iteration a fully-skipped queue ends
 * the loop, rebuilding `actions.current` and erasing both the error message and
 * the tick count.
 */
function tick(ctx, mana = 500) {
    const spent = ctx.ev(`actions.tick(${mana})`);
    return {
        spent,
        // completions, not `ticks`: a 400-mana action finishes inside a single
        // 500-mana tick and its tick counter is reset on completion
        done: ctx.ev("totals.actions"),
        error: ctx.ev("actions.current[0]?.errorMessage"),
        // tick() sets shouldRestart when the queue yields no valid action —
        // this is the loop-termination signal. totals.loops is NOT usable: a
        // degenerate 0-mana loop never advances it (standing harness rule).
        shouldRestart: ctx.ev("shouldRestart"),
    };
}

/** the full driver, for the legs that care about the loop actually ending */
function runOneLoop(ctx, { steps = 40, cap = 500 } = {}) {
    let spent = 0, ended = false, used = 0;
    for (let i = 0; i < steps; i++) {
        const r = ctx.step(cap);
        spent += r.spent;
        used++;
        if (r.ended) { ended = true; break; }
    }
    return { spent, ended, steps: used };
}

// Wander exp high enough to clear the u:Locks threshold (townLevel >= 20).
const WANDER_20 = "towns[0].expWander = 25250;";
const LOCKS_QUEUE = [["Pick Locks", 1]];

test("leg 1: fresh boot, an ALWAYS-row action executes (harness path)", () => {
    const ctx = boot({ queue: [["Wander", 1]] });
    assert.equal(ctx.ev("Unlocks.blocked(Action.Wander)"), false);
    const r = tick(ctx);
    assert.ok(r.spent > 0, "Wander spent no mana");
    assert.ok(r.done > 0, "Wander made no progress");
    assert.equal(r.shouldRestart, false, "the loop ended without running Wander");
});

test("leg 2: vanilla baseline — Pick Locks at Wander 20 executes", () => {
    const ctx = boot({ recipe: WANDER_20, queue: LOCKS_QUEUE });
    assert.ok(ctx.ev("towns[0].getLevel('Wander')") >= 20, "recipe did not reach Wander 20");
    assert.equal(ctx.ev("Action.PickLocks.unlocked()"), true);
    assert.equal(ctx.ev("Unlocks.blocked(Action.PickLocks)"), false);
    const r = tick(ctx);
    assert.ok(r.spent > 0, "Pick Locks spent no mana");
    assert.ok(r.done > 0, "Pick Locks made no progress");
});

test("leg 3: suppressed — skipped for the whole loop, locked message, loop terminates", () => {
    const ctx = boot({ recipe: WANDER_20, queue: LOCKS_QUEUE, suppressed: ["u:Locks"] });
    assert.equal(ctx.ev("Unlocks.blocked(Action.PickLocks)"), true);
    const r = tick(ctx);
    assert.equal(r.spent, 0, "a suppressed action spent mana");
    assert.equal(r.done, 0, "a suppressed action made progress");
    assert.equal(r.error, "This action is locked.");
    assert.equal(r.shouldRestart, true, "the loop did not terminate");
    // and through the full driver: the whole queue is skipped, the loop ends on
    // the first iteration, and the 0-mana step does not stall the driver
    const drv = runOneLoop(boot({ recipe: WANDER_20, queue: LOCKS_QUEUE, suppressed: ["u:Locks"] }));
    assert.equal(drv.spent, 0);
    assert.equal(drv.ended, true, "the driver loop did not terminate");
    assert.equal(drv.steps, 1, "termination took more than one driver step");
});

test("leg 4: suppressed + granted — executes again", () => {
    const ctx = boot({
        recipe: WANDER_20, queue: LOCKS_QUEUE,
        suppressed: ["u:Locks"], granted: ["u:Locks"],
    });
    assert.equal(ctx.ev("Unlocks.blocked(Action.PickLocks)"), false);
    const r = tick(ctx);
    assert.ok(r.spent > 0, "a granted action spent no mana");
    assert.ok(r.done > 0, "a granted action made no progress");
});

test("leg 5: the item is authoritative in both directions", () => {
    // below the local threshold, but granted -> executes anyway
    const below = boot({
        queue: LOCKS_QUEUE, suppressed: ["u:Locks"], granted: ["u:Locks"],
        // Pick Locks is a limited action: without discovered locks, allowed()
        // refuses it before the skip loop is ever reached. Seed the ledger
        // AFTER adjustAll (which would recompute it from Wander exp) so the
        // leg isolates the unlock axis from the discovery axis.
        post: "towns[0].totalLocks = 10;",
    });
    assert.equal(below.ev("towns[0].getLevel('Wander')"), 0, "Wander should be at level 0");
    assert.equal(below.ev("Unlocks.blocked(Action.PickLocks)"), false);
    assert.ok(tick(below).spent > 0, "granted-but-locally-locked did not execute");

    // locally satisfied, but suppressed and not granted -> does not execute
    const above = boot({ recipe: WANDER_20, queue: LOCKS_QUEUE, suppressed: ["u:Locks"] });
    assert.equal(above.ev("Unlocks.achievedNow(Unlocks.getRows().find(r => r.id === 'u:Locks'))"), true,
        "local conditions should be satisfied in this arm");
    assert.equal(above.ev("Unlocks.blocked(Action.PickLocks)"), true);
    assert.equal(tick(above).spent, 0, "suppressed-but-locally-unlocked executed");
});

test("leg 6: inertness — with suppression empty nothing is blocked", () => {
    // The behavioural half of this leg is carried by the existing suites: the
    // 10 tick goldens (unchanged), the V3 byte-gate (EXACT) and V4 omsi-parity.
    // What this asserts is the precondition those rest on — blocked() is a
    // constant-false Set miss for every action in the game, including the ones
    // with no unlock row at all.
    const ctx = boot({ queue: [["Wander", 1]] });
    assert.equal(ctx.ev("Unlocks.suppressed.size"), 0);
    assert.equal(ctx.ev("Unlocks.granted.size"), 0);
    assert.equal(ctx.ev("totalActionList.filter(a => Unlocks.blocked(a)).length"), 0);
    // and the defensive path: an action-shaped object with no row
    assert.equal(ctx.ev("Unlocks.blocked({ varName: 'NotAnAction' })"), false);
    assert.equal(ctx.ev("Unlocks.blocked(undefined)"), false);
});
