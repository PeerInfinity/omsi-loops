// IdlePlanner selftest — port of the proven v0 experiment selftest, run
// against the fork's planner.js in the headless harness. Covers the
// machinery every planning round leans on: save/restore fidelity,
// perturbation-probe exactness and non-mutation, the predictor as a headless
// queue scorer, micro-eval measurement, and a short deterministic planner
// run.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

function makePlanner(seed) {
    const ctx = makeContext(seed, ["planner.js"]);
    ctx.sandbox.__rngGet = ctx.getRng;
    ctx.sandbox.__rngSet = ctx.setRng;
    ctx.ev("IdlePlanner.setRngHooks({ get: __rngGet, set: __rngSet })");
    return ctx;
}

test("restore+replay is byte-identical to a continuous run", () => {
    const ctx = makePlanner(777);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const play = (queues) => {
        for (const q of queues) { sess.setQueue(q); sess.restart(); sess.runLoop(); }
    };
    const phase1 = Array.from({ length: 12 }, () => [["Wander", 5], ["Smash Pots", 6]]);
    play(phase1);
    const snap = sess.save();
    const phase2 = Array.from({ length: 12 }, (_, i) => [["Wander", 3 + (i % 3)], ["Smash Pots", 8]]);
    play(phase2);
    const liveSnapshot = sess.snapshot();
    sess.restore(snap);
    play(phase2);
    assert.equal(sess.snapshot(), liveSnapshot);
});

test("threshold probing is exact and leaves state untouched", () => {
    const ctx = makePlanner(778);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const before = sess.snapshot();
    const th = sess.probe();
    assert.equal(sess.snapshot(), before, "probe must not mutate state");
    const pl = th["Pick Locks"];
    assert.ok(pl?.probeable, "Pick Locks probeable");
    assert.equal(pl.requires.find(r => r.v === "Wander")?.need, 20, "Pick Locks needs Wander>=20");
    assert.equal(th["Meet People"]?.requires?.find(r => r.v === "Wander")?.need, 22, "Meet People needs Wander>=22");
    assert.ok(th["Start Journey"], "Start Journey probed");
    assert.ok(sess.needs("Start Journey").includes("supplies"), "Start Journey canStart needs supplies");
});

test("predictor scores queues headlessly", async () => {
    const ctx = makePlanner(779);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const p1 = await sess.predict([["Wander", 1]]);
    assert.ok(p1.ok && p1.totalMana === 250 && p1.isValid, `Wander x1: ${JSON.stringify(p1)}`);
    const p2 = await sess.predict([["Wander", 5]]);
    assert.ok(p2.ok && !p2.isValid, `Wander x5 overbudget: ${JSON.stringify(p2)}`);
});

test("micro-eval measurement + restore idempotence", () => {
    const ctx = makePlanner(780);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const know = new Map();
    const state = sess.read();
    const snap = sess.save();
    const wander = state.actions.find(a => a.name === "Wander");
    const pots = state.actions.find(a => a.name === "Smash Pots");
    const IP = ctx.ev("IdlePlanner");
    const pw = IP.measureAction(sess, snap, state, know, wander);
    const pp = IP.measureAction(sess, snap, state, know, pots);
    assert.ok(pw.exec > 0 && pw.goldPerExec === 0, `Wander profile: ${JSON.stringify({ exec: pw.exec })}`);
    assert.ok(pp.exec >= 0, "Smash Pots measured");
    sess.restore(snap);
    const s1 = sess.snapshot();
    sess.restore(snap);
    assert.equal(sess.snapshot(), s1, "restore idempotent");
});

test("short standalone planner run is deterministic and makes progress", async () => {
    const run = async () => {
        const ctx = makePlanner(12345);
        const r = await ctx.ev("IdlePlanner").runStandalone({ maxLoops: 6 });
        return { loops: r.loopsRun, ticks: r.cumTicks, snapshot: r.finalSnapshot };
    };
    const a = await run();
    const b = await run();
    assert.equal(a.loops, 6, "ran 6 loops");
    assert.ok(a.ticks >= 6 * 200, `spent real ticks (${a.ticks})`);
    assert.equal(a.snapshot, b.snapshot, "twin runs byte-identical");
    assert.equal(a.ticks, b.ticks, "twin runs same tick count");
});
