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
    const ctx = makeContext(seed, ["planner-metadata.js", "planner.js"]);
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

test("plReadState surfaces persistent channels (census 2.2), JSON-plain", () => {
    const ctx = makePlanner(783);
    const sess = ctx.ev("new IdlePlanner.Session()");
    // shapes present at a fresh state
    const s0 = sess.read();
    assert.ok(s0.buffs && typeof s0.buffs === "object", "buffs map present");
    for (const b of ["Ritual", "Imbuement", "Imbuement2", "Feast", "Aspirant", "Heroism", "Imbuement3"])
        assert.ok(b in s0.buffs, `buff ${b} present`);
    assert.ok(s0.soulstones && "perStat" in s0.soulstones && "total" in s0.soulstones, "soulstones shape");
    for (const st of ["Dex", "Str", "Con", "Spd", "Per", "Cha", "Int", "Luck", "Soul"])
        assert.ok(st in s0.soulstones.perStat, `soulstone stat ${st} present`);
    assert.equal(typeof s0.goldInvested, "number");
    assert.equal(typeof s0.trainingLimits, "number");
    assert.equal(typeof s0.effectiveTime, "number");
    assert.ok(s0.stonesUsed && typeof s0.stonesUsed === "object", "stonesUsed present");
    assert.ok(Array.isArray(s0.dungeons) && s0.dungeons.length === 3, "3 dungeons");
    assert.ok(Array.isArray(s0.trials) && s0.trials.length === 5, "5 trials");
    for (const d of s0.dungeons) for (const f of d)
        assert.ok("completed" in f && "ssChance" in f, "dungeon floor shape");
    for (const t of s0.trials)
        assert.ok("highestFloor" in t && "completedTotal" in t, "trial shape");
    for (const town of s0.towns) assert.ok("mult" in town, "town multipart ledger present");
    // JSON-plain: the read state IS a JSON string, so a parse is total by
    // construction — assert the parsed object survives a re-stringify unchanged
    const raw = ctx.ev("IdlePlanner._internals.plReadState()");
    assert.equal(typeof raw, "string");
    assert.equal(JSON.stringify(JSON.parse(raw)), raw, "read state is canonical JSON");

    // nonzero paths surface via live globals
    ctx.ev("buffs.Ritual.amt = 5; stats.Dex.soulstone = 7; stats.Str.soulstone = 3; goldInvested = 1234");
    const s1 = sess.read();
    assert.equal(s1.buffs.Ritual, 5, "buff amt surfaced");
    assert.equal(s1.soulstones.perStat.Dex, 7);
    assert.equal(s1.soulstones.total, 10, "soulstone total = sum per stat");
    assert.equal(s1.goldInvested, 1234, "goldInvested surfaced");
});

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
            IP.setEvalPool(async (jobs) => {
                const out = [];
                for (const job of jobs) {
                    const j = JSON.parse(JSON.stringify(job));
                    let res;
                    if (j.kind === "screen") {
                        sess2.restore({ save: j.save, rng: j.rng });
                        res = await sess2.predict(j.q);
                    } else {
                        res = IP.confirmCandidate(
                            sess2, { save: j.save, rng: j.rng }, j.q, new Map(j.know), j.multiTown);
                    }
                    out.push(JSON.parse(JSON.stringify(res)));
                }
                return out;
            });
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

test("screenMode engine/none: deterministic and pool-equivalent", async () => {
    const run = async (screenMode, usePool) => {
        const ctx = makePlanner(12345);
        const IP = ctx.ev("IdlePlanner");
        if (usePool) {
            const sess2 = ctx.ev("new IdlePlanner.Session()");
            IP.setEvalPool(async (jobs) => {
                const out = [];
                for (const job of jobs) {
                    const j = JSON.parse(JSON.stringify(job));
                    let res;
                    if (j.kind === "escreen") {
                        res = IP.evalLoopOnly(sess2, { save: j.save, rng: j.rng }, j.q);
                    } else if (j.kind === "screen") {
                        sess2.restore({ save: j.save, rng: j.rng });
                        res = await sess2.predict(j.q);
                    } else {
                        res = IP.confirmCandidate(
                            sess2, { save: j.save, rng: j.rng }, j.q, new Map(j.know), j.multiTown);
                    }
                    out.push(JSON.parse(JSON.stringify(res)));
                }
                return out;
            });
        }
        const r = await IP.runStandalone({ maxLoops: 6, screenMode });
        return { snap: r.finalSnapshot, ticks: r.cumTicks };
    };
    const e1 = await run("engine", false);
    const e2 = await run("engine", true);
    assert.equal(e2.snap, e1.snap, "engine screen: pooled == serial");
    assert.equal(e2.ticks, e1.ticks, "engine screen: tick counts match");
    const n1 = await run("none", false);
    assert.ok(n1.ticks > 0, "screenMode none completes real loops");
});

// ---- §11.8 piece 2: gate metadata + informed vocabulary -------------------

test("gate metadata: table loads and surfaces on read-state actions", () => {
    const ctx = makePlanner(790);
    const md = ctx.ev("typeof PLANNER_METADATA");
    assert.equal(md, "object", "planner-metadata.js loaded before planner.js");
    const sess = ctx.ev("new IdlePlanner.Session()");
    ctx.ev("townsUnlocked = [0,1,2]");
    const state = sess.read();
    const gateOf = (n) => j(state.actions.find(a => a.name === n)?.gate ?? null);
    assert.deepEqual(gateOf("Dark Magic"), { repMax: 0 }, "Dark Magic repMax:0 gate");
    assert.deepEqual(gateOf("Apprentice"), { guild: "Crafting" }, "Apprentice guild gate");
    assert.deepEqual(gateOf("Wander"), null, "ungated action carries null gate");
});

test("informed vocabulary: a guild action forms a real profile (empirical exec=0)", () => {
    const ctx = makePlanner(791);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    sess.setQueue([["Wander", 1]]);
    sess.restart();
    // unlock towns 0-2, a two-hop route (Start Journey, Continue On) and the
    // guild-gated action (Apprentice: Drunk >= 40)
    ctx.ev("townsUnlocked = [0,1,2]");
    ctx.ev("for (const s in skills) skills[s].levelExp.level = 500;");
    ctx.ev("towns[2].expDrunk = 1e7;");
    ctx.ev("adjustAll()");
    const state = sess.read();
    const snap = sess.save();
    const appr = state.actions.find(a => a.name === "Apprentice");
    assert.ok(appr?.unlocked, "Apprentice unlocked");
    const needs = sess.needs("Apprentice");
    // empirical: guild never joined -> canStart (guild === "Crafting") false
    const emp = IP.measureAction(sess, snap, state, new Map(), appr, needs, { baselineCache: new Map() });
    assert.equal(emp.exec, 0, "empirical mode cannot satisfy the guild gate");
    // informed: metadata sets guild for the probe -> Apprentice executes
    const inf = IP.measureAction(sess, snap, state, new Map(), appr, needs,
        { baselineCache: new Map(), vocabulary: "informed" });
    assert.ok(inf.exec > 0, `informed mode measures the guild action (exec ${inf.exec})`);
    assert.equal(inf.townNum, 2);
    assert.ok((inf.skillExpPerExec ?? 0) > 0 || Math.abs(inf.goldPerExec) > 0,
        "a real profile forms (skill exp and/or gold attributed)");
});

test("informed vocabulary: a negative-reputation action forms a real profile (empirical exec=0)", () => {
    const ctx = makePlanner(792);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    sess.setQueue([["Wander", 1]]);
    sess.restart();
    ctx.ev("townsUnlocked = [0,1]");
    ctx.ev("for (const s in skills) skills[s].levelExp.level = 200;"); // Magic >= 100
    ctx.ev("towns[1].expWitch = 46500;");   // Witch ~30: unlocks + keeps manaCost > 0
    ctx.ev("adjustAll()");
    const state = sess.read();
    const snap = sess.save();
    const dm = state.actions.find(a => a.name === "Dark Magic");
    assert.ok(dm?.unlocked, "Dark Magic unlocked");
    // empirical WITH reputation injected (the refreshKnowledge retry path):
    // reputation 1000 defeats canStart (reputation <= 0)
    const emp = IP.measureAction(sess, snap, state, new Map(), dm, ["reputation"], { baselineCache: new Map() });
    assert.equal(emp.exec, 0, "empirical mode with injected reputation cannot start Dark Magic");
    // informed: the repMax:0 gate clamps reputation and skips its injection
    const inf = IP.measureAction(sess, snap, state, new Map(), dm, ["reputation"],
        { baselineCache: new Map(), vocabulary: "informed" });
    assert.ok(inf.exec > 0, `informed mode measures the negative-rep action (exec ${inf.exec})`);
    assert.ok(inf.repPerExec < 0, `Dark Magic spends reputation (repPerExec ${inf.repPerExec})`);
    assert.ok((inf.skillExpPerExec ?? 0) > 0, "Dark skill exp attributed");
});

// ---- §11.10 targeted mode (T1: action-goal regression) --------------------

test("regressAction assembles route + grantor + queue-terminal target (Continue On)", () => {
    const ctx = makePlanner(901);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    // same town-1-unlocked fixture as the buildPushes test
    sess.setQueue([["Wander", 1]]); sess.restart();
    ctx.ev("townsUnlocked = [0, 1]");
    const th = sess.probe();
    for (const name of ["Start Journey", "Buy Supplies"])
        for (const r of th[name]?.requires ?? [])
            ctx.ev(`skills[${JSON.stringify(r.v)}].levelExp.level = ${r.need}`);
    ctx.ev("adjustAll()");
    let state = sess.read();
    const snap = sess.save();
    const bs = state.actions.find(a => a.name === "Buy Supplies");
    const p = IP.measureAction(sess, snap, state, new Map(), bs, sess.needs("Buy Supplies"));
    const know = new Map([["Buy Supplies", p]]);
    sess.restore(snap); state = sess.read();
    const co = state.actions.find(a => a.name === "Continue On");
    const cands = IP.regressAction(state, know, sess, co);
    assert.equal(cands.length, 1, "one h-variant (no Haggle measured in this fixture)");
    const cand = cands[0];
    assert.equal(cand.label, "target:Start Journey>Continue On:h0");
    assert.deepEqual(j(cand.goal), { kind: "a", action: "Continue On" });
    assert.deepEqual(j(cand.q).slice(-3), [["Buy Supplies", 1], ["Start Journey", 1], ["Continue On", 1]],
        "grantor precedes the hops; the travel target is queue-terminal");
});

test("regressAction defers guild gates to v2 (T0 §8.1) — no candidates", () => {
    const ctx = makePlanner(902);
    const IP = ctx.ev("IdlePlanner");
    const state = { townsUnlocked: [0, 1, 2], baseMana: 250, actions: [], towns: [] };
    const X = { name: "Apprentice", townNum: 2, gate: { guild: "Crafting" } };
    assert.deepEqual(j(IP.regressAction(state, new Map(), { needs: () => [] }, X)), [],
        "a guild-gated action is unreachable in v1 (guild join is a v2 setup goal)");
    // a guild-JOIN action (guildEmpty) is likewise out of v1 scope
    const J = { name: "Crafting Guild", townNum: 2, gate: { guildEmpty: true } };
    assert.deepEqual(j(IP.regressAction(state, new Map(), { needs: () => [] }, J)), []);
});

test("regressAction prepends a profile-discovered rep-sink for a repMax<0 gate", () => {
    const ctx = makePlanner(903);
    const IP = ctx.ev("IdlePlanner");
    // synthetic state: a town-0 rep-sink (repPerExec<0) + a repMax:-3 target
    const state = { townsUnlocked: [0], baseMana: 250, towns: [{ index: 0, limited: {}, progress: {} }], actions: [
        { name: "Sink", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 100 },
        { name: "Goal", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 200, gate: { repMax: -3 } },
    ] };
    const know = new Map([["Sink", { exec: 1, repPerExec: -1, ticksPerExec: 100, grants: {},
        costReductions: {}, goldPerExec: 0, manaPerGold: 0, manaPerExec: 0 }]]);
    const sess = { needs: () => [] };
    // discovery is profile-driven, never hard-coded (§8.2)
    const sink = IP.repSinkProvider(state, know, 0);
    assert.equal(sink.a.name, "Sink");
    const cands = IP.regressAction(state, know, sess, state.actions.find(a => a.name === "Goal"));
    assert.equal(cands.length, 1, "one h-variant (no reducer for a non-purchase target)");
    // ceil(3 / 1 rep-per-exec) = 3 sink reps prepended; target is terminal
    assert.deepEqual(j(cands[0].q), [["Sink", 3], ["Goal", 1]]);
    assert.equal(cands[0].label, "target:Goal:h0");
});

test("regressAction: repMax===0 needs no sink; repMax<0 with no sink is unreachable", () => {
    const ctx = makePlanner(904);
    const IP = ctx.ev("IdlePlanner");
    const state = { townsUnlocked: [0], baseMana: 250, towns: [{ index: 0, limited: {}, progress: {} }], actions: [
        { name: "Goal", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 200, gate: { repMax: 0 } },
    ] };
    const sess = { needs: () => [] };
    const c0 = IP.regressAction(state, new Map(), sess, state.actions[0]);
    assert.deepEqual(j(c0[0].q), [["Goal", 1]], "repMax:0 is satisfied at loop start (rep 0) — no sink");
    // repMax<0 but no rep-sink in the profile table ⇒ unreachable this loop
    const state2 = { ...state, actions: [{ ...state.actions[0], gate: { repMax: -1 } }] };
    assert.deepEqual(j(IP.regressAction(state2, new Map(), sess, state2.actions[0])), []);
});

test("generateTargeted skips goals whose action is not unlocked; regresses the rest", () => {
    const ctx = makePlanner(905);
    const IP = ctx.ev("IdlePlanner");
    const state = { townsUnlocked: [0], baseMana: 250, towns: [{ index: 0, limited: {}, progress: {} }], actions: [
        { name: "Open", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 200 },
        { name: "Locked", townNum: 0, type: "normal", visible: true, unlocked: false, cost: 200 },
    ] };
    const sess = { needs: () => [] };
    const cands = IP.generateTargeted(state, new Map(), sess, [
        { kind: "a", action: "Locked" },   // dropped (not in unlockedOf)
        { kind: "a", action: "Open" },
        { kind: "a", action: "Missing" },  // dropped (not in state)
    ]);
    assert.equal(cands.length, 1);
    assert.equal(cands[0].goal.action, "Open");
});

test("targeted strategy falls back to the heuristic when no goal is achievable (byte-identical)", async () => {
    // With a target that isn't unlocked yet (Start Journey unlocks ~L445), the
    // targeted branch produces no candidates and falls through to the heuristic
    // scorer (ruling 1's full fallback). The committed queues must match the
    // pure-heuristic run loop-for-loop — the strategy field is inert until a
    // goal becomes achievable. (Also the standing byte-inertness guard for the
    // new planRound branch.)
    const labelsFor = async (strategy) => {
        const ctx = makePlanner(12345);
        const IP = ctx.ev("IdlePlanner");
        const r = await IP.runStandalone({ maxLoops: 8, targetTown: 9,
            ...(strategy === "targeted" ? { strategy: "targeted", targetAction: "Start Journey" } : {}) });
        return r.trace.map(t => t.label);
    };
    const heuristic = j(await labelsFor("heuristic"));
    const targeted = j(await labelsFor("targeted"));
    assert.deepEqual(targeted, heuristic,
        "targeted with an unreachable goal commits exactly the heuristic queues");
    assert.ok(heuristic.length === 8, "the run made progress");
});
