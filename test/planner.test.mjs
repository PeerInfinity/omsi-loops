// IdlePlanner selftest — port of the proven v0 experiment selftest, run
// against the fork's planner.js in the headless harness. Covers the
// machinery every planning round leans on: save/restore fidelity,
// perturbation-probe exactness and non-mutation, the predictor as a headless
// queue scorer, micro-eval measurement, and a short deterministic planner
// run.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

// vm-returned structures are cross-realm (different Array prototype), so
// deepStrictEqual needs a JSON round-trip first
const j = (x) => JSON.parse(JSON.stringify(x));

test("travel graph: destination edges from getPossibleTravel, dynamic flagged", () => {
    const ctx = makePlanner(781);
    ctx.ev("townsUnlocked = [0,1,2,3,4,5,6,7,8]");
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    const edges = j(IP.travelEdges(sess.read()));
    const of = (name) => edges.filter(e => e.action.name === name);
    // destination = townNum + delta, NOT the delta (the Round-5 wall)
    assert.deepEqual(of("Continue On").map(e => [e.from, e.to]), [[1, 2]], "Continue On is 1->2");
    assert.deepEqual(of("Hitch Ride").map(e => [e.from, e.to]), [[0, 2]], "Hitch Ride skips to town 2");
    assert.deepEqual(of("Open Portal").map(e => [e.from, e.to]), [[6, 1]], "Open Portal travels BACKWARD");
    const fj = of("Face Judgement");
    assert.equal(fj.length, 2, "Face Judgement has two possible destinations");
    assert.deepEqual(fj.map(e => e.to).sort(), [4, 5]);
    assert.ok(fj.every(e => e.dynamic), "dynamic destinations flagged");
    assert.ok(edges.filter(e => e.action.name !== "Face Judgement").every(e => !e.dynamic));
});

test("routeTo: BFS by hop count over usable edges; dynamic edges excluded", () => {
    const ctx = makePlanner(781);
    const IP = ctx.ev("IdlePlanner");
    // routeTo is a pure function of the read-state shape — synthetic fixture
    const A = (name, townNum, dests, opts = {}) => ({
        name, townNum, travelDests: dests, visible: opts.visible ?? true,
        unlocked: opts.unlocked ?? true, cost: opts.cost ?? 100,
    });
    const mkState = (hitchUnlocked) => ({ townsUnlocked: [0, 1, 2], actions: [
        A("Start Journey", 0, [1]),
        A("Hitch Ride", 0, [2], { unlocked: hitchUnlocked, cost: 5000 }),
        A("Continue On", 1, [2]),
        A("Fake Judgement", 2, [3, 4]),        // dynamic (two dests): never routed
    ] });
    const sess = { needs: (name) => name === "Start Journey" ? ["supplies", "mana"] : [] };

    const r0 = j(IP.routeTo(mkState(false), sess, 0));
    assert.deepEqual(r0, { hops: [], entries: [], needs: [], ticksEst: 0 }, "town 0 = empty route");
    const r2 = j(IP.routeTo(mkState(false), sess, 2));
    assert.deepEqual(r2.entries, [["Start Journey", 1], ["Continue On", 1]], "two hops when the skip edge is locked");
    assert.deepEqual(r2.needs, ["supplies"], "hop canStart needs collected, mana filtered");
    assert.equal(r2.ticksEst, 200);
    const r2b = j(IP.routeTo(mkState(true), sess, 2));
    assert.deepEqual(r2b.entries, [["Hitch Ride", 1]], "fewer hops beat lower cost (BFS by hop count)");
    assert.equal(IP.routeTo(mkState(true), sess, 3), null, "dynamic-only destinations are unroutable in v1");
});

test("buildPushes is destination-aware: Continue On (1->2) yields a two-hop push", () => {
    const ctx = makePlanner(782);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    // bootstrap one restart (initializes per-loop state incl. suppliesCost);
    // restart() needs a non-empty queue headlessly (pauseGame touches the DOM)
    sess.setQueue([["Wander", 1]]);
    sess.restart();
    ctx.ev("townsUnlocked = [0, 1]");
    // unlock the travel chain the way real play would have: raise exactly the
    // dims the threshold probe reports (no hand-coded game values)
    const th = sess.probe();
    for (const name of ["Start Journey", "Buy Supplies"]) {
        for (const r of th[name]?.requires ?? []) {
            assert.equal(r.kind, "s", `${name} requirement probed as a skill dim`);
            ctx.ev(`skills[${JSON.stringify(r.v)}].levelExp.level = ${r.need}`);
        }
    }
    ctx.ev("adjustAll()");
    const state = sess.read();
    const snap = sess.save();
    // v0's delta filter would have rejected Continue On (delta +1, town 1
    // already unlocked); the destination filter must admit it
    const co = state.actions.find(a => a.name === "Continue On");
    assert.ok(co?.visible && co?.unlocked, "Continue On usable");
    assert.deepEqual(j(co.travelDests), [2]);
    // measure the supplies grantor so the push's needs resolve
    const bs = state.actions.find(a => a.name === "Buy Supplies");
    const p = IP.measureAction(sess, snap, state, new Map(), bs, sess.needs("Buy Supplies"));
    assert.ok(p.exec > 0 && (p.grants.supplies ?? 0) > 0, "Buy Supplies grants supplies");
    const know = new Map([["Buy Supplies", p]]);
    sess.restore(snap);
    const pushes = IP.buildPushes(state, know, sess);
    const twoHop = pushes.find(c => c.label === "push2:Start Journey>Continue On:h0");
    assert.ok(twoHop, `two-hop push generated (got: ${pushes.map(c => c.label).join(", ")})`);
    assert.deepEqual(j(twoHop.q).slice(-3), [["Buy Supplies", 1], ["Start Journey", 1], ["Continue On", 1]],
        "grantor precedes the hops; the travel chain is queue-terminal");
});

test("travel-prefixed measurement: town-1 profiles form (the Round-5 wall falls)", () => {
    const ctx = makePlanner(783);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    sess.setQueue([["Wander", 1]]);
    sess.restart();
    ctx.ev("townsUnlocked = [0, 1]");
    const th = sess.probe();
    for (const r of th["Start Journey"]?.requires ?? []) {
        assert.equal(r.kind, "s", "Start Journey requirement probed as a skill dim");
        ctx.ev(`skills[${JSON.stringify(r.v)}].levelExp.level = ${r.need}`);
    }
    ctx.ev("adjustAll()");
    const state = sess.read();
    const snap = sess.save();
    const ef = state.actions.find(a => a.name === "Explore Forest");
    assert.ok(ef, "Explore Forest in read state once town 1 unlocks");
    const know = new Map();
    const cache = new Map();
    const p = IP.measureAction(sess, snap, state, know, ef, sess.needs("Explore Forest"), { baselineCache: cache });
    assert.equal(p.exec, 12, "prefixed probe executes (v0 single-action probes measured exec=0 here)");
    assert.equal(p.townNum, 1);
    assert.equal(p.routeKey, "Start Journey");
    assert.equal(cache.size, 1, "prefix baseline cached per (route, injection-signature)");
    // prefix-baseline subtraction: only the action's own deltas survive
    assert.ok(p.progressExpPerExec > 0, `Forest progress attributed to the action (${p.progressExpPerExec})`);
    assert.ok(Math.abs(p.manaPerExec) < 1, `travel prefix does not leak into manaPerExec (${p.manaPerExec})`);
    assert.ok(Object.keys(p.discovers).length > 0, "town-1 pool discovery attributed");
    // a second same-town probe with the same injections reuses the baseline
    IP.measureAction(sess, snap, state, know, ef, sess.needs("Explore Forest"), { baselineCache: cache });
    assert.equal(cache.size, 1, "baseline cache hit on re-measure");
});

test("measureAction degrades gracefully when no usable route exists", () => {
    const ctx = makePlanner(784);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    sess.setQueue([["Wander", 1]]);
    sess.restart();
    // town 1 nominally unlocked but the whole travel chain still locked
    ctx.ev("townsUnlocked = [0, 1]");
    const state = sess.read();
    const snap = sess.save();
    const ef = state.actions.find(a => a.name === "Explore Forest");
    const p = IP.measureAction(sess, snap, state, new Map(), ef, []);
    assert.equal(p.exec, 0, "unroutable town measures as a failed probe, not a crash");
    assert.equal(p.routeKey, null);
});

test("composed multi-town queue order survives plSetQueue (tail-pinning)", () => {
    const ctx = makePlanner(785);
    const sess = ctx.ev("new IdlePlanner.Session()");
    sess.setQueue([["Wander", 1]]);
    sess.restart();
    ctx.ev("townsUnlocked = [0, 1]");
    // grantor -> hop -> town-1 work -> hop: addAction's addAtClosestValidIndex
    // must not relocate anything when the queue is built in route order
    const composed = [["Wander", 2], ["Buy Supplies", 1], ["Start Journey", 1], ["Explore Forest", 4], ["Continue On", 1]];
    sess.setQueue(composed);
    assert.deepEqual(j(sess.getQueue()), composed, "engine kept the composed order verbatim");
});

test("inertness: candidate labels+queues at townsUnlocked=[0] equal the v0 golden", async () => {
    // golden captured from the pre-multi-town planner (automation @ 4e664d6)
    // by NewDocs gen-candidates-golden procedure; inertness is a STATE
    // property — while only town 0 is unlocked every candidate must be
    // byte-identical to v0's
    const golden = JSON.parse(fs.readFileSync(new URL("./goldens/candidates-town0.json", import.meta.url), "utf8"));
    const ctx = makePlanner(31337);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    const play = (queues) => { for (const q of queues) { sess.setQueue(q); sess.restart(); sess.runLoop(); } };
    play(Array.from({ length: 12 }, () => [["Wander", 5], ["Smash Pots", 6]]));
    play(Array.from({ length: 12 }, (_, i) => [["Wander", 3 + (i % 3)], ["Smash Pots", 8]]));
    const states = [
        ["plain", null],
        ["travelReady", () => {
            const th = sess.probe();
            for (const name of ["Start Journey", "Buy Supplies"])
                for (const r of th[name]?.requires ?? [])
                    ctx.ev(`skills[${JSON.stringify(r.v)}].levelExp.level = ${r.need}`);
            ctx.ev("adjustAll()");
        }],
    ];
    for (const [key, prep] of states) {
        if (prep) prep();
        const pre = sess.read();
        const snap = sess.save();
        const thresholds = sess.probe();
        const P = IP.newPlanningState();
        await IP.refreshKnowledge(sess, snap, pre, P.know, {});
        sess.restore(snap);
        const cands = IP.generateCandidates(pre, P.know, thresholds, sess, [["Wander", 3]]);
        assert.deepEqual(j(cands.map(c => ({ label: c.label, q: c.q }))), golden[key],
            `candidate set '${key}' byte-equal to v0`);
        sess.restore(snap);
    }
});

test("multiTown=false forces the v0 town-0-only paths (A/B gate)", () => {
    const ctx = makePlanner(786);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    sess.setQueue([["Wander", 1]]);
    sess.restart();
    ctx.ev("townsUnlocked = [0, 1]");
    const th = sess.probe();
    for (const r of th["Start Journey"]?.requires ?? []) ctx.ev(`skills[${JSON.stringify(r.v)}].levelExp.level = ${r.need}`);
    ctx.ev("adjustAll()");
    const state = sess.read();
    const snap = sess.save();
    const ef = state.actions.find(a => a.name === "Explore Forest");
    // measurement: no travel prefix under the v0 mode -> the Round-5 wall
    const pOff = IP.measureAction(sess, snap, state, new Map(), ef, [], { multiTown: false });
    assert.equal(pOff.exec, 0, "v0 mode reproduces the wall (exec=0 for town-1 actions)");
    // generation: no multi-hop pushes / expeditions under the v0 mode
    sess.restore(snap);
    const candsOff = IP.generateCandidates(state, new Map(), th, sess, null, { multiTown: false });
    assert.ok(candsOff.every(c => !c.label.startsWith("push2:") && !c.label.startsWith("xp:")),
        `v0 mode generates no multi-town candidates (got: ${candsOff.map(c => c.label).join(", ")})`);
});

test("scoring-horizon terms: gated off at townsUnlocked=[0], exact when active", () => {
    const ctx = makePlanner(786);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    const state = sess.read();
    const W = { ...IP.DEFAULT_WEIGHTS };
    const r = { lastExec: [] };

    // [0] state: neither term may even appear in parts (byte-inert path)
    const s0 = IP.scoreOutcome(state, state, {}, r, 250, new Map(), W, 250,
        { probeTicks: 100, prevProbeTicks: 120 });
    assert.ok(!("travelRelief" in s0.parts), "travelRelief absent at [0]");
    assert.ok(!("headroom" in s0.parts), "headroom absent at [0]");

    // multi-town pre state: terms compute, in mana units
    const pre = JSON.parse(JSON.stringify(state));
    pre.townsUnlocked = [0, 1];
    const post = JSON.parse(JSON.stringify(pre));
    const edge = (st, cost) => {
        const a = st.actions.find(x => x.name === "Start Journey");
        a.visible = true; a.unlocked = true; a.cost = cost;
    };
    edge(pre, 2000); edge(post, 1500);   // the route 0->1 got 500 mana cheaper
    const s1 = IP.scoreOutcome(pre, post, {}, r, 25000, new Map(), W, 25000,
        { probeTicks: 100, prevProbeTicks: 120 });
    assert.equal(s1.parts.travelRelief, W.travelRelief * 500, "relief = route cost delta");
    assert.equal(s1.parts.headroom, W.headroom * 20, "headroom = d(capacity - probe ticks)");
});

test("planning-state serialization round-trips through JSON", () => {
    const ctx = makePlanner(787);
    const IP = ctx.ev("IdlePlanner");
    const P = IP.newPlanningState();
    P.loop = 42; P.prevTimeNeeded = 25250; P.prevProbeTicks = 17303;
    P.lastCommitted = [["Wander", 3]];
    P.thresholds = { "Pick Locks": { probeable: true, requires: [] } };
    P.pre = { townsUnlocked: [0, 1] };
    P.know.set("Wander", { ...IP.emptyProfile(), exec: 3, manaPerExec: 1.5 });
    const blob = JSON.parse(JSON.stringify(IP.serializePlanningState(P)));
    const P2 = IP.newPlanningState();
    IP.restorePlanningState(P2, blob);
    for (const k of ["loop", "prevTimeNeeded", "prevProbeTicks"]) assert.equal(P2[k], P[k], k);
    // JSON-compare: restored objects live in the vm realm (deepEqual would
    // trip on differing Object prototypes, not real differences)
    const J = JSON.stringify;
    assert.equal(J(P2.lastCommitted), J(P.lastCommitted));
    assert.equal(J(P2.thresholds), J(P.thresholds));
    assert.equal(J(P2.pre), J(P.pre));
    assert.equal(J([...P2.know.entries()]), J([...P.know.entries()]));
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

test("eval-pool hook: JSON-cloned confirms are byte-identical to serial", async () => {
    // The pool contract: jobs and results survive a structured-clone
    // boundary, and pooled confirms must not change planner behavior. The
    // fake pool JSON-round-trips both directions (a superset of what
    // worker_threads cloning does to these payloads) and runs the confirms
    // through a second Session against the same sim, exactly as a worker
    // context would against its own.
    const run = async (usePool) => {
        const ctx = makePlanner(12345);
        const IP = ctx.ev("IdlePlanner");
        if (usePool) {
            const sess2 = ctx.ev("new IdlePlanner.Session()");
            IP.setEvalPool(async (jobs) => jobs.map((job) => {
                const j = JSON.parse(JSON.stringify(job));
                const res = IP.confirmCandidate(
                    sess2, { save: j.save, rng: j.rng }, j.q, new Map(j.know), j.multiTown);
                return JSON.parse(JSON.stringify(res));
            }));
        }
        const r = await IP.runStandalone({ maxLoops: 8 });
        return {
            snapshot: r.finalSnapshot, ticks: r.cumTicks,
            trace: JSON.stringify(r.trace.map(t => [t.label, t.ticks, t.score])),
        };
    };
    const serial = await run(false);
    const pooled = await run(true);
    assert.equal(pooled.snapshot, serial.snapshot, "pooled final snapshot byte-identical");
    assert.equal(pooled.ticks, serial.ticks, "pooled tick count identical");
    assert.equal(pooled.trace, serial.trace, "pooled per-loop decisions identical");
});
