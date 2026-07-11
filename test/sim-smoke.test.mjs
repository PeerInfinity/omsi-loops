// Sim smoke test: the engine runs headlessly, deterministically, and
// actually ticks.
//
// The tick-counter assertion is load-bearing: an early prototype reported
// "reproducible: YES" while executing ZERO ticks (singleTick threw on tick 1,
// the error was swallowed, and two identical INITIAL states hashed equal).
// Never compare hashes without also asserting work happened.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

function play(seed, steps) {
    const ctx = makeContext(seed);
    const queue = [["Smash Pots", 6], ["Wander", 3]];
    ctx.setQueue(queue);
    ctx.restart();
    let spent = 0, loops = 0;
    for (let i = 0; i < steps; i++) {
        const r = ctx.step(1);
        spent += r.spent;
        if (r.ended) {
            loops++;
            ctx.setQueue(queue);
            ctx.restart();
        }
    }
    return { spent, loops, hash: ctx.hash(), rng: ctx.rngCount() };
}

test("2000 headless steps run, loop, and are deterministic", () => {
    const a = play(777, 2000);
    const b = play(777, 2000);
    assert.ok(a.spent >= 2000, `tick counter must advance (spent ${a.spent})`);
    assert.ok(a.loops >= 4, `loops must reset (got ${a.loops})`);
    assert.equal(a.hash, b.hash, "same seed must produce identical state");
    assert.equal(a.spent, b.spent, "same seed must spend identical mana");
    assert.equal(a.rng, b.rng, "same seed must consume identical RNG count");
});

test("all 9 towns and the full action list construct", () => {
    const ctx = makeContext();
    assert.equal(ctx.ev("towns.length"), 9);
    assert.ok(ctx.ev("totalActionList.length") >= 150,
        `expected the full action list, got ${ctx.ev("totalActionList.length")}`);
});
