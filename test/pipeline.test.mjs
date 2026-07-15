// §11.7 Design B (live no-pause pipelining) — planner-side unit tests.
//
// Covers the pieces the live pipeline leans on:
//   - boundaryHash is a pure, restart-stable digest of persistent state;
//   - planPipeline's PREDICTED boundary hash equals the hash the game actually
//     reaches by playing the committed queue that many loops (the determinism
//     that lets the live game swap plans with no pause and no error);
//   - runStandalone's replanEvery reuses a plan across a window (fewer plan
//     rounds, more loops per plan) and stays deterministic; replanEvery=1 is
//     the byte-exact today path (no reuse).
//
// The live-vs-worker effectiveTime divergence (Bonus Seconds) that boundaryHash
// strips cannot be reproduced headless — both sides here are headless — so that
// stripping is validated by the full byte-gate + live check, not this file.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

function makePlanner(seed) {
    const ctx = makeContext(seed, ["planner-metadata.js", "planner.js"]);
    ctx.sandbox.__rngGet = ctx.getRng;
    ctx.sandbox.__rngSet = ctx.setRng;
    ctx.ev("IdlePlanner.setRngHooks({ get: __rngGet, set: __rngSet })");
    return ctx;
}

test("boundaryHash is pure and stable across restart()", () => {
    const ctx = makePlanner(4242);
    // play a loop so persistent state is non-trivial, then read the hash
    // post-loop and again after a restart (which re-initialises the per-loop
    // volatile fields the hash deliberately excludes).
    ctx.ev(`(() => { const s = new IdlePlanner.Session();
        s.setQueue([['Wander',2],['Smash Pots',4]]); s.restart(); s.runLoop();
        globalThis.__s = s; })()`);
    const h1 = ctx.ev("IdlePlanner.boundaryHash()");
    const h2 = ctx.ev("IdlePlanner.boundaryHash()");
    assert.equal(h1, h2, "boundaryHash is a pure function of state");
    ctx.ev("__s.restart()");
    const h3 = ctx.ev("IdlePlanner.boundaryHash()");
    assert.equal(h1, h3, "restart() leaves the persistent boundary hash unchanged");
    assert.match(h1, /^[0-9a-f]{16}$/, "boundaryHash is 16 hex chars");
});

test("boundaryHash changes when persistent state changes", () => {
    const ctx = makePlanner(4243);
    ctx.ev(`(() => { const s = new IdlePlanner.Session();
        s.setQueue([['Wander',1]]); s.restart(); s.runLoop(); globalThis.__s = s; })()`);
    const before = ctx.ev("IdlePlanner.boundaryHash()");
    ctx.ev("(() => { __s.setQueue([['Wander',1],['Smash Pots',5]]); __s.restart(); __s.runLoop(); })()");
    const after = ctx.ev("IdlePlanner.boundaryHash()");
    assert.notEqual(before, after, "a completed loop that gains exp/pots changes the hash");
});

test("planPipeline predicts the boundary the committed queue actually reaches", async () => {
    const ctx = makePlanner(9001);
    const K = 3;
    // set up a starting snapshot after a few loops of a fixed committed queue
    ctx.ev(`(() => { const sess = new IdlePlanner.Session();
        const Q = [['Wander',1],['Smash Pots',3]];
        for (let i=0;i<3;i++){ sess.setQueue(Q); sess.restart(); sess.runLoop(); }
        globalThis.__pipe = { sess, Q, snap: sess.save() }; })()`);

    // reference: from the snapshot, ACTUALLY play Q for K loops, hash the boundary
    const refHash = ctx.ev(`(() => { const { sess, Q, snap } = __pipe;
        sess.restore(snap);
        for (let i=0;i<${K};i++){ sess.setQueue(Q); sess.restart(); sess.runLoop(); }
        return IdlePlanner.boundaryHash(); })()`);

    // planPipeline: from the same snapshot, simulate K ahead + plan; its
    // returned boundaryHash is the state the live game must still match.
    const predHash = await ctx.ev(`(async () => { const { sess, Q, snap } = __pipe;
        sess.restore(snap);
        const P = IdlePlanner.newPlanningState({ screenK: 4 });
        const res = await IdlePlanner.planPipeline(sess, P, Q, ${K});
        return res.boundaryHash; })()`);

    assert.equal(predHash, refHash,
        "planPipeline's predicted boundary hash == playing the committed queue K loops");
});

test("runStandalone replanEvery reuses a plan across a window and stays deterministic", async () => {
    // Each run needs its OWN context: runStandalone drives the shared sim
    // globals, so two runs in one context would accumulate (loops 8 -> 16).
    const run = async (K, max) => JSON.parse(await makePlanner(12345).ev(
        `(async () => JSON.stringify(await IdlePlanner.runStandalone(` +
        `{ maxLoops:${max}, screenK:4, targetTown:9, replanEvery:${K} })))()`));

    const a = await run(1, 8);
    const b = await run(1, 8);
    assert.equal(a.finalSnapshot, b.finalSnapshot, "replanEvery=1 is deterministic");
    assert.equal(a.loopsRun, 8, "runs the full loop budget (town 9 never reached)");
    assert.ok(!a.trace.some(t => t.reused), "replanEvery=1 never reuses (byte-exact path)");

    const c = await run(3, 9);
    assert.equal(c.loopsRun, 9, "replanEvery=3 still runs the full budget");
    assert.ok(c.trace.some(t => t.reused), "replanEvery=3 marks reused loops");
    const planned = c.trace.filter(t => !t.reused).length;
    assert.equal(planned, 3, "one planned loop per window of 3 (9 loops => 3 plan rounds)");
});
