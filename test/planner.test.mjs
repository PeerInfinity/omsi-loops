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

// fork (arc D2 slice 2b follow-up): the probe used to READ the EFFECTIVE view
// (getLevel) while WRITING exp on the RAW curve. Vanilla never noticed — the
// two ladders coincide — but under a per-region Explore rescale the mismatch
// seeds the binary search's lower bound from the wrong ladder, and hands
// `reqFraction` (which converts `need` back to exp on the raw curve) a number
// from the other one.
//
// The state that exposes it is a region with SOME progress already banked: at
// raw Wander 1 of a 10-level region the effective level is 10, so the pre-fix
// search started at lo=10 over a raw-level space where every answer is <= 10.
// It reported 11 — one above its own floor — for EVERY Wander gate: unreachable
// (the exp cap is level 10) and identical for gates that are ten raw levels
// apart. Both halves are checked below, because a need that merely lands in
// range would still be useless if the probe had lost its resolution.
test("threshold probing stays on the RAW ladder under a region rescale", () => {
    const ctx = makePlanner(778);
    const sess = ctx.ev("new IdlePlanner.Session()");

    // Town 0's Explore compressed into 10 levels: effective = floor(raw*10).
    ctx.ev('Town.setRegionScale({ 0: { Wander: 10 } })');
    ctx.ev("towns[0].expWander = 100");   // raw level 1 => effective 10
    assert.equal(ctx.ev('towns[0].getRawLevel("Wander")'), 1);
    assert.equal(ctx.ev('towns[0].getLevel("Wander")'), 10);

    const before = sess.snapshot();
    const th = sess.probe();
    assert.equal(sess.snapshot(), before, "probe must not mutate state");

    const wander = (name) => th[name]?.requires?.find(r => r.v === "Wander");
    // The two gates the vanilla test pins, reached a tenth of the way up:
    // effective 20 first holds at raw 2, effective 22 at raw 3. Distinct
    // answers are the resolution the pre-fix probe threw away (both were 11).
    assert.equal(wander("Pick Locks")?.need, 2, "vanilla Wander>=20 compresses to raw 2");
    assert.equal(wander("Meet People")?.need, 3, "vanilla Wander>=22 compresses to raw 3");
    assert.equal(wander("Pick Locks")?.cur, 1, "`cur` is the RAW level, not the effective 10");

    // ...and every reported level is one the save can actually hold.
    const cap = ctx.ev('towns[0].regionMaxLevel("Wander")');
    const capExp = ctx.ev('towns[0].expCap("Wander")');
    assert.equal(cap, 10);
    const wanderRows = Object.entries(th)
        .flatMap(([name, t]) => (t.requires ?? []).filter(r => r.kind === "p" && r.v === "Wander")
            .map(r => [name, r]));
    assert.ok(wanderRows.length >= 4, `expected Wander gates to probe (got ${wanderRows.length})`);
    for (const [name, r] of wanderRows) {
        assert.ok(r.need <= cap, `${name}: need ${r.need} exceeds the region cap ${cap}`);
        assert.ok(ctx.ev(`towns[0].expForLevel("Wander", ${r.need})`) <= capExp,
            `${name}: need ${r.need} costs more exp than the region can hold`);
    }

    // Control: clearing the rescale puts the vanilla answers back, so the
    // numbers above are the compression and not a probe that lost its way.
    ctx.ev("Town.setRegionScale(null)");
    const vanilla = sess.probe();
    assert.equal(vanilla["Pick Locks"]?.requires?.find(r => r.v === "Wander")?.need, 20);
    assert.equal(sess.snapshot(), before, "the second probe is non-mutating too");
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

// ---- §11.8 piece 3: scored channels (zero-default, weight-gated) -----------
test("piece-3 channels: no part materializes at DEFAULT_WEIGHTS even when deltas exist", () => {
    const ctx = makePlanner(786);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    const state = sess.read();
    const pre = JSON.parse(JSON.stringify(state));
    const post = JSON.parse(JSON.stringify(state));
    // deltas on every piece-3 channel
    const a = post.actions.find(x => x.name === "Wander");
    a.cost -= 50; a.unlocked = true;
    pre.actions.find(x => x.name === "Wander").unlocked = true;
    post.buffs = { ...post.buffs, Ritual: (post.buffs?.Ritual ?? 0) + 2 };
    post.soulstones = { perStat: {}, total: (post.soulstones?.total ?? 0) + 7 };
    post.goldInvested = (post.goldInvested ?? 0) + 500;
    const W = { ...IP.DEFAULT_WEIGHTS };
    assert.equal(W.efficiency, 0); assert.equal(W.buff, 0);
    assert.equal(W.soulstone, 0); assert.equal(W.invest, 0);
    assert.equal(W.grindTalent, 0);
    const s = IP.scoreOutcome(pre, post, {}, { lastExec: [] }, 250, new Map(), W, 250, {});
    for (const k of ["efficiency", "buff", "soulstone", "invest"])
        assert.ok(!(k in s.parts), `${k} absent at zero default`);
});

test("piece-3 channels: efficiency / buff / soulstone / invest compute when weighted", () => {
    const ctx = makePlanner(786);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    const state = sess.read();
    const W = { ...IP.DEFAULT_WEIGHTS, efficiency: 2, buff: 100, soulstone: 5, invest: 0.5 };
    const capacity = 25000;
    const mk = () => JSON.parse(JSON.stringify(state));

    // efficiency = measured edgeRates ledger (the W3 skill-efficiency web):
    // execs × Σ per-target rate × future execs (capacity/cost). manaCost
    // rates are signed (drops negative = cheapening credits); goldYield at
    // 50 mana/gold. NOT a pre/post cost delta — base stats reset every
    // restart(), so state-delta drift is a within-loop transient.
    {
        const pre = mk(), post = mk();
        const setCost = (name, cost) => { const a = post.actions.find(x => x.name === name);
            a.cost = cost; };
        setCost("Smash Pots", 100); setCost("Pick Locks", 400);
        const know = new Map([["Investigate", { edgeRates: {
            "Smash Pots": { manaCost: -0.05 },          // cheapens
            "Pick Locks": { goldYield: 0.02 },          // yield grows
        } }]]);
        const r = { lastExec: [{ name: "Investigate", loops: 10, loopsLeft: 0 }] };
        const s = IP.scoreOutcome(pre, post, {}, r, capacity, know, W, capacity, {});
        const expected = W.efficiency * (10 * 0.05 * (capacity / 100)
                                       + 10 * 0.02 * 50 * (capacity / 400));
        assert.ok(Math.abs(s.parts.efficiency - expected) < 1e-9,
            "edge ledger: execs × rate × capacity/cost, gold at 50 mana/gold");
        // no edgeRates (default empirical vocabulary) => inert even weighted
        const sEmp = IP.scoreOutcome(pre, post, {}, r, capacity,
            new Map([["Investigate", {}]]), W, capacity, {});
        assert.ok(!("efficiency" in sEmp.parts),
            "term inert without measured edges (double-gated at default vocabulary)");
    }
    // buff grants: Δ levels, frontier-like
    {
        const pre = mk(), post = mk();
        post.buffs = { ...post.buffs, Ritual: (post.buffs?.Ritual ?? 0) + 2 };
        const s = IP.scoreOutcome(pre, post, {}, { lastExec: [] }, capacity, new Map(), W, capacity, {});
        assert.equal(s.parts.buff, W.buff * 2, "buff = W.buff × Δlevels");
    }
    // soulstone: net realized Δtotal; dungeon rolls swapped for ssChance EV
    {
        const pre = mk(), post = mk();
        pre.soulstones = { perStat: {}, total: 10 };
        post.soulstones = { perStat: {}, total: 17 };            // net +7 (incl. any sacrifice)
        // dungeon 0 floor 0: 2 completions, NO grant realized (ssChance flat)
        pre.dungeons = [[{ completed: 0, ssChance: 0.5 }]];
        post.dungeons = [[{ completed: 2, ssChance: 0.5 }]];
        const s = IP.scoreOutcome(pre, post, {}, { lastExec: [] }, capacity, new Map(), W, capacity, {});
        assert.equal(s.parts.soulstone, W.soulstone * (7 + 2 * 0.5),
            "unrealized dungeon completions credited at EV");
        // one realized grant (ssChance decayed ×0.98): EV swap nets to zero
        post.dungeons = [[{ completed: 2, ssChance: 0.5 * 0.98 }]];
        const s2 = IP.scoreOutcome(pre, post, {}, { lastExec: [] }, capacity, new Map(), W, capacity, {});
        assert.equal(s2.parts.soulstone, W.soulstone * (7 - 1 + 2 * 0.5),
            "realized grant estimated from ssChance decay and swapped for EV");
    }
    // invest annuity: banked principal delta
    {
        const pre = mk(), post = mk();
        post.goldInvested = (post.goldInvested ?? 0) + 500;
        const s = IP.scoreOutcome(pre, post, {}, { lastExec: [] }, capacity, new Map(), W, capacity, {});
        assert.equal(s.parts.invest, W.invest * 500, "invest = W.invest × ΔgoldInvested");
    }
});

test("piece-3 talent-grind candidates: emitted only behind the grindTalent gate", async () => {
    const ctx = makePlanner(31337);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    const play = (queues) => { for (const q of queues) { sess.setQueue(q); sess.restart(); sess.runLoop(); } };
    play(Array.from({ length: 12 }, () => [["Wander", 5], ["Smash Pots", 6]]));
    // unlock the ONE town-0 expMult≥4 action (Train Strength: Met >= 5)
    ctx.ev("towns[0].expMet = getExpOfLevel(6); adjustAll()");
    const pre = sess.read();
    const snap = sess.save();
    const thresholds = sess.probe();
    const P = IP.newPlanningState();
    await IP.refreshKnowledge(sess, snap, pre, P.know, {});
    sess.restore(snap);
    const ts = pre.actions.find(a => a.name === "Train Strength");
    assert.ok(ts?.unlocked && ts.expMult >= 4, "Train Strength unlocked with expMult 4");
    const off = IP.generateCandidates(pre, P.know, thresholds, sess, null, {});
    assert.ok(off.every(c => !c.label.startsWith("grind-talent:")),
        "no talent-grind candidates without the gate (byte-inert default)");
    sess.restore(snap);
    const on = IP.generateCandidates(pre, P.know, thresholds, sess, null, { grindTalent: true });
    const gt = on.filter(c => c.label.startsWith("grind-talent:"));
    assert.ok(gt.some(c => c.label === "grind-talent:Train Strength"),
        `gate emits grind-talent:Train Strength (got: ${on.map(c => c.label).join(", ")})`);
    // the grind rides the standard economy scaffold: economy head + target
    assert.ok(gt[0].q.some(([n]) => n === "Train Strength"), "queue grinds the target");
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

// ---- §11.10 targeted mode (T2: target-value goals + §4 measurement) --------

test("§4 measurement: measureAction records persistentDelta (byte-inert empty for a town-0 action)", () => {
    const ctx = makePlanner(910);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    sess.setQueue([["Wander", 1]]); sess.restart();
    const pre = sess.read(); const snap = sess.save();
    const wander = pre.actions.find(a => a.name === "Wander");
    const p = IP.measureAction(sess, snap, pre, new Map(), wander, []);
    assert.ok(p.exec > 0, "Wander measured");
    // the field is ALWAYS populated (additive); a town-0 action touches no
    // persistent channel, so it is empty — the byte-inertness guarantee.
    assert.deepEqual(j(p.persistentDelta), {}, "no buff/soulstone/goldInvested change from Wander");
});

test("rankValueProviders: skill/progress via the grinder; buffs/ss/goldInvested via persistentDelta", () => {
    const ctx = makePlanner(911);
    const IP = ctx.ev("IdlePlanner");
    const state = { townsUnlocked: [0], baseMana: 250, towns: [{ index: 0, limited: {}, progress: {} }], actions: [
        { name: "Fast", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 100 },
        { name: "Slow", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 100 },
        { name: "None", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 100 },
    ] };
    const know = new Map([
        ["Fast", { exec: 1, ticksPerExec: 100, persistentDelta: { buffs: { Ritual: 4 } }, grants: {}, costReductions: {} }],
        ["Slow", { exec: 1, ticksPerExec: 100, persistentDelta: { buffs: { Ritual: 1 } }, grants: {}, costReductions: {} }],
        ["None", { exec: 1, ticksPerExec: 100, persistentDelta: {}, grants: {}, costReductions: {} }],
    ]);
    const prov = IP.rankValueProviders(state, know, { type: "buff", name: "Ritual" });
    assert.deepEqual(prov.map(x => x.a.name), ["Fast", "Slow"], "ranked by ΔR/tick desc; non-providers excluded");
    // soulstones / goldInvested read the top-level persistentDelta field
    const ss = new Map([["Fast", { exec: 1, ticksPerExec: 50, persistentDelta: { soulstones: 3 }, grants: {}, costReductions: {} }]]);
    assert.equal(IP.rankValueProviders(state, ss, { type: "soulstones" })[0].a.name, "Fast");
});

test("regressTarget fills the loop with the max-ΔR provider (progress dim, measured today)", () => {
    const ctx = makePlanner(912);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    sess.setQueue([["Wander", 1]]); sess.restart();
    const pre = sess.read(); const snap = sess.save();
    const P = IP.newPlanningState();
    // Wander is the town-0 progress grinder for its own dim
    const goal = { kind: "b", target: { type: "progress", name: "Wander", town: 0 }, value: 20 };
    const cands = IP.regressTarget(pre, P.know, sess, goal, { capacityHint: 5000, fillShare: 0.6 });
    assert.equal(cands.length, 1);
    assert.equal(cands[0].goal.kind, "b");
    // the terminal x1 scaffold is replaced by a fill count sized to the budget
    const last = j(cands[0].q[cands[0].q.length - 1]);
    assert.equal(last[0], "Wander");
    assert.ok(last[1] > 1, `filled with multiple reps (got ${last[1]})`);
});

test("regressTarget: a buff goal fills with the §4 persistentDelta provider", () => {
    const ctx = makePlanner(913);
    const IP = ctx.ev("IdlePlanner");
    // synthetic town-0 provider with a measured buff delta
    const state = { townsUnlocked: [0], baseMana: 1000, towns: [{ index: 0, limited: {}, progress: {} }], actions: [
        { name: "Chant", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 100 },
    ] };
    const know = new Map([["Chant", { exec: 1, ticksPerExec: 100, persistentDelta: { buffs: { Ritual: 2 } },
        grants: {}, costReductions: {}, goldPerExec: 0, manaPerExec: 0, manaPerGold: 0 }]]);
    const sess = { needs: () => [] };
    const goal = { kind: "b", target: { type: "buff", name: "Ritual" }, value: 10 };
    const cands = IP.regressTarget(state, know, sess, goal, { capacityHint: 2000, fillShare: 0.6 });
    assert.equal(cands.length, 1);
    assert.equal(j(cands[0].q[cands[0].q.length - 1])[0], "Chant");
    assert.ok(cands[0].label.startsWith("value:buff:Ritual"));
});

test("readStateValue reads each persistent target type", () => {
    const ctx = makePlanner(914);
    const IP = ctx.ev("IdlePlanner");
    const state = {
        skills: { Magic: { level: 42 } },
        towns: [{ progress: { Wander: { level: 7 } } }],
        buffs: { Ritual: 5 },
        soulstones: { total: 300 },
        goldInvested: 12345,
    };
    assert.equal(IP.readStateValue(state, { type: "skill", name: "Magic" }), 42);
    assert.equal(IP.readStateValue(state, { type: "progress", name: "Wander", town: 0 }), 7);
    assert.equal(IP.readStateValue(state, { type: "buff", name: "Ritual" }), 5);
    assert.equal(IP.readStateValue(state, { type: "soulstones" }), 300);
    assert.equal(IP.readStateValue(state, { type: "goldInvested" }), 12345);
});

test("targeted kind-b goal already at its value V falls back to the heuristic (byte-identical)", async () => {
    // A value goal with V=0 is satisfied at loop start (every persistent field
    // is >= 0), so planTargeted drops it and runs the heuristic — the trace must
    // match the pure-heuristic run (the across-rounds stop condition, and the
    // byte-inertness guard for the kind-b path).
    const labels = async (targets) => {
        const ctx = makePlanner(12345);
        const r = await ctx.ev("IdlePlanner").runStandalone({ maxLoops: 6, targetTown: 9,
            ...(targets ? { strategy: "targeted", targets } : {}) });
        return r.trace.map(t => t.label);
    };
    const heuristic = j(await labels(null));
    const satisfied = j(await labels([{ kind: "b", target: { type: "skill", name: "Magic" }, value: 0 }]));
    assert.deepEqual(satisfied, heuristic, "an already-satisfied value goal is inert");
});

test("a disabled (enabled:false) goal is skipped — byte-identical to the heuristic", async () => {
    // The priority-list editor's Enable checkbox parks a row via `enabled:false`:
    // planTargeted filters it out, so a list whose only goal is disabled falls
    // straight back to the heuristic scorer (ruling 1). Guard with a goal proven
    // to CHANGE the trace when active, so the inertness is non-trivial.
    const labels = async (targets) => {
        const ctx = makePlanner(12345);
        const r = await ctx.ev("IdlePlanner").runStandalone({ maxLoops: 8, targetTown: 9,
            ...(targets ? { strategy: "targeted", targets } : {}) });
        return r.trace.map(t => t.label);
    };
    const goal = { kind: "b", target: { type: "progress", name: "Wander", town: 0 }, value: 100, budget: 0.5 };
    const heuristic = j(await labels(null));
    const active = j(await labels([goal]));
    const disabled = j(await labels([{ ...goal, enabled: false }]));
    assert.notDeepEqual(active, heuristic, "the goal actually bites when enabled (non-trivial guard)");
    assert.deepEqual(disabled, heuristic, "the same goal disabled is skipped — the heuristic trace");
});

// ---- §11.10 targeted mode (T3: priority list + budgets + residual) ---------

test("assembleTargetedQueue: budgeted layers + cascade + heuristic residual tail", () => {
    const ctx = makePlanner(920);
    const IP = ctx.ev("IdlePlanner");
    // synthetic town-0 state: two progress providers (A, B) + a frontier grinder
    // (C) for the residual tail. All plain progress actions (no economy needed).
    const A = (name, cost) => ({ name, townNum: 0, type: "progress", varName: name, visible: true,
        unlocked: true, cost, skillsGained: [], travelDests: [] });
    const state = { townsUnlocked: [0], baseMana: 250, actions: [A("GrindA", 100), A("GrindB", 200), A("GrindC", 50)],
        towns: [{ index: 0, limited: {}, progress: { GrindA: { level: 0, exp: 0 }, GrindB: { level: 0, exp: 0 }, GrindC: { level: 0, exp: 0 } } }],
        skills: {} };
    // measured knowledge: ticksPerExec = cost (real runs always have measured
    // profiles for the providers, keeping the tick accounting self-consistent)
    const prof = (t) => ({ exec: 1, ticksPerExec: t, grants: {}, costReductions: {}, goldPerExec: 0, manaPerExec: 0, manaPerGold: 0 });
    const know = new Map([["GrindA", prof(100)], ["GrindB", prof(200)], ["GrindC", prof(50)]]);
    const sess = { needs: () => [] };
    // C is the frontier tail target (a locked action requires it)
    const thresholds = { Locked: { probeable: true, requires: [{ kind: "p", town: 0, v: "GrindC", need: 50 }] } };
    const goals = [
        { kind: "b", target: { type: "progress", name: "GrindA", town: 0 }, value: 100, budget: 0.3 },
        { kind: "b", target: { type: "progress", name: "GrindB", town: 0 }, value: 100, budget: 0.3 },
    ];
    const asm = IP.assembleTargetedQueue(state, know, sess, goals, thresholds, { capacityHint: 10000 });
    assert.ok(asm, "assembly produced");
    const q = j(asm.q);
    const byName = Object.fromEntries(q.map(([n, l]) => [n, l]));
    // spine GrindA: 0.3 * 10000 / 100 = 30 reps
    assert.equal(byName.GrindA, 30, "spine filled to its budget share");
    // layer GrindB: min(0.3*10000, remaining) / 200 = 3000/200 = 15 reps (concurrent, not lexicographic)
    assert.equal(byName.GrindB, 15, "second goal advances the SAME round via its budget");
    // residual handoff: leftover (10000 - 3000 - 3000 = 4000) → GrindC frontier grind (4000/50 = 80)
    assert.equal(byName.GrindC, 80, "leftover budget goes to the heuristic grind tail");
});

test("assembleTargetedQueue: unbudgeted spine eats the fill; residual still tails", () => {
    const ctx = makePlanner(921);
    const IP = ctx.ev("IdlePlanner");
    const A = (name, cost) => ({ name, townNum: 0, type: "progress", varName: name, visible: true,
        unlocked: true, cost, skillsGained: [], travelDests: [] });
    const state = { townsUnlocked: [0], baseMana: 250, actions: [A("Solo", 100), A("Later", 100)],
        towns: [{ index: 0, limited: {}, progress: { Solo: { level: 0, exp: 0 }, Later: { level: 0, exp: 0 } } }], skills: {} };
    const prof = (t) => ({ exec: 1, ticksPerExec: t, grants: {}, costReductions: {}, goldPerExec: 0, manaPerExec: 0, manaPerGold: 0 });
    const know = new Map([["Solo", prof(100)], ["Later", prof(100)]]);
    const goals = [
        { kind: "b", target: { type: "progress", name: "Solo", town: 0 }, value: 100 },   // NO budget ⇒ greedy 0.6
        { kind: "b", target: { type: "progress", name: "Later", town: 0 }, value: 100 },
    ];
    const asm = IP.assembleTargetedQueue(state, know, { needs: () => [] }, goals, {}, { capacityHint: 10000 });
    const byName = Object.fromEntries(j(asm.q).map(([n, l]) => [n, l]));
    assert.equal(byName.Solo, 60, "unbudgeted spine greedily fills 0.6 of the budget");
    // remaining 4000; "Later" has no budget ⇒ greedy remaining/100 = 40
    assert.equal(byName.Later, 40, "an unbudgeted lower goal still takes the whole remainder");
});

test("autoRankGoals enumerates blocked travel destinations, nearest first", () => {
    const ctx = makePlanner(922);
    const IP = ctx.ev("IdlePlanner");
    const T = (name, townNum, to) => ({ name, townNum, travelDests: [to], visible: true, unlocked: true, cost: 100 });
    const state = { townsUnlocked: [0, 1], actions: [
        T("Continue On", 1, 2),     // 1->2, destination locked
        T("Push Far", 2, 3),        // 2->3, destination locked (further)
        T("Start Journey", 0, 1),   // 0->1, destination ALREADY unlocked → excluded
    ] };
    const goals = j(IP.autoRankGoals(state, new Map(), { needs: () => [] }, {}));
    assert.deepEqual(goals, [{ kind: "a", action: "Continue On" }, { kind: "a", action: "Push Far" }],
        "only blocked destinations, nearest town first; already-unlocked excluded");
});

// ---- §11.10 targeted mode (T4: §6 stagnation trigger) ----------------------

test("updateStagnation: streak counts identical commits; drought counts no-new-availability; K backoff", () => {
    const ctx = makePlanner(930);
    const IP = ctx.ev("IdlePlanner");
    const post = (names) => ({ actions: names.map(n => ({ name: n, visible: true, unlocked: true })) });
    const P = { streak: 0, drought: 0, antiFixK: 32, seenAvail: new Set(), lastCommitted: null };
    const commit = (q, postNames, escalated = false) => {
        IP.updateStagnation(P, { c: { q }, post: post(postNames) }, escalated);
        P.lastCommitted = q;   // the caller sets this after planRound
    };
    // first commit: nothing to compare against → streak 0; fresh availability → drought 0
    commit([["Wander", 1]], ["Wander"]);
    assert.equal(P.streak, 0); assert.equal(P.drought, 0);
    // same queue, no new action → streak up, drought up
    commit([["Wander", 1]], ["Wander"]);
    assert.equal(P.streak, 1); assert.equal(P.drought, 1);
    commit([["Wander", 1]], ["Wander"]);
    assert.equal(P.streak, 2); assert.equal(P.drought, 2);
    // a NEW action becomes available → drought resets (streak keeps counting the identical queue)
    commit([["Wander", 1]], ["Wander", "Pick Locks"]);
    assert.equal(P.streak, 3); assert.equal(P.drought, 0, "drought resets on new availability");
    // a DIFFERENT queue → streak resets
    commit([["Smash Pots", 1]], ["Wander", "Pick Locks"]);
    assert.equal(P.streak, 0);
    // an ESCALATION round that re-commits the same queue doubles K (backoff)
    P.antiFixK = 32;
    commit([["Smash Pots", 1]], ["Wander", "Pick Locks"], true);
    assert.equal(P.streak, 1); assert.equal(P.antiFixK, 64, "failed escalation doubles K");
});

test("anti-fixation guard is byte-inert by margin (off by default; healthy streak stays under K)", async () => {
    // a short default run: the guard is OFF, so the trace matches the reference
    // path exactly, AND the observed committed-queue streak stays well under the
    // K=256 threshold (session-28 retune: healthy runs carry mid-run streaks
    // ~104 but CLOSE them; holes hold the counter open at the cap 311–682).
    const ctx = makePlanner(12345);
    const r = await ctx.ev("IdlePlanner").runStandalone({ maxLoops: 20 });
    const labels = r.trace.map(t => t.label);
    let maxStreak = 0, cur = 0;
    for (let i = 1; i < labels.length; i++) { cur = labels[i] === labels[i - 1] ? cur + 1 : 0; maxStreak = Math.max(maxStreak, cur); }
    assert.ok(maxStreak < 256, `healthy committed-queue streak (${maxStreak}) well under K=256`);
});

// ---- targeted-mode v2 (V1: sticky goal + per-branch stall persistence) ------

test("§V1 goalKey: stable identity per goal; kind-b is value-sensitive", () => {
    const IP = makePlanner(940).ev("IdlePlanner");
    assert.equal(IP.goalKey({ kind: "a", action: "Start Journey" }), "a:Start Journey");
    assert.equal(IP.goalKey({ kind: "b", target: { type: "skill", name: "Magic" }, value: 50 }), "b:skill:Magic:50");
    // budget / enabled / list position don't change WHICH goal it is
    assert.equal(IP.goalKey({ kind: "a", action: "X", budget: 0.3, enabled: false }),
                 IP.goalKey({ kind: "a", action: "X" }));
    // a different stop value IS a different goal
    assert.notEqual(IP.goalKey({ kind: "b", target: { type: "skill", name: "Magic" }, value: 40 }),
                    IP.goalKey({ kind: "b", target: { type: "skill", name: "Magic" }, value: 50 }));
    assert.equal(IP.goalKey(null), null);
});

test("§V1 branchProgressed: kind-b uses the measured dim delta; kind-a uses achieved", () => {
    const IP = makePlanner(941).ev("IdlePlanner");
    const at = (lvl) => ({ skills: { Magic: { level: lvl } } });
    const leafB = { kind: "b", target: { type: "skill", name: "Magic" }, value: 50 };
    assert.equal(IP.branchProgressed(leafB, at(10), at(12), false), true, "dim moved ⇒ progress (achieved flag ignored)");
    assert.equal(IP.branchProgressed(leafB, at(10), at(10), true), false, "dim flat ⇒ no progress even if achieved");
    const leafA = { kind: "a", action: "Start Journey" };
    assert.equal(IP.branchProgressed(leafA, at(10), at(10), true), true, "kind-a ⇒ the achieved flag");
    assert.equal(IP.branchProgressed(leafA, at(10), at(10), false), false, "kind-a ⇒ not achieved");
});

test("§V1 updateGoalStall: sticky goal; stall grows on no progress, resets on a measured delta; resets on goal switch", () => {
    const IP = makePlanner(942).ev("IdlePlanner");
    const P = IP.newPlanningState();
    const goal = { kind: "b", target: { type: "skill", name: "Magic" }, value: 50 };
    const at = (lvl) => ({ skills: { Magic: { level: lvl } } });
    IP.updateGoalStall(P, goal, at(10), at(10), false);
    assert.equal(IP.goalKey(P.activeGoal), "b:skill:Magic:50", "goal is sticky (stored on P)");
    assert.equal(P.branchStall["b:skill:Magic:50"], 1);
    IP.updateGoalStall(P, goal, at(10), at(10), false);
    assert.equal(P.branchStall["b:skill:Magic:50"], 2, "no progress ⇒ stall grows");
    IP.updateGoalStall(P, goal, at(10), at(13), false);
    assert.equal(P.branchStall["b:skill:Magic:50"], 0, "measured dim delta resets the branch");
    // switching to a different top goal clears the old branch bookkeeping
    const goal2 = { kind: "a", action: "Start Journey" };
    IP.updateGoalStall(P, goal2, at(13), at(13), false);
    assert.equal(IP.goalKey(P.activeGoal), "a:Start Journey");
    assert.deepEqual(j(P.branchStall), { "a:Start Journey": 1 }, "old branch cleared on goal switch");
});

test("§V1 maybeAbandonGoal: a branch stalled >= K abandons the whole goal (recorded + cleared)", () => {
    const IP = makePlanner(943).ev("IdlePlanner");
    const P = IP.newPlanningState({ goalStallK: 3 });
    const goal = { kind: "a", action: "Start Journey" };
    const st = { skills: {} };
    for (let i = 0; i < 2; i++) {
        IP.updateGoalStall(P, goal, st, st, false);
        assert.equal(IP.maybeAbandonGoal(P), false, "below K ⇒ no abandon");
    }
    assert.equal(P.branchStall["a:Start Journey"], 2);
    IP.updateGoalStall(P, goal, st, st, false);   // stall reaches 3 == K
    assert.equal(IP.maybeAbandonGoal(P), true, "abandon fires at K");
    assert.equal(P.activeGoal, null, "active goal cleared");
    assert.deepEqual([...P.abandonedGoals], ["a:Start Journey"], "goal recorded as abandoned");
});

test("§V1 planning-state serialization round-trips the sticky-goal handle", () => {
    const IP = makePlanner(944).ev("IdlePlanner");
    const P = IP.newPlanningState();
    P.activeGoal = { kind: "b", target: { type: "skill", name: "Magic" }, value: 50 };
    P.activeLeaf = { kind: "b", target: { type: "progress", name: "Secrets", town: 0 }, value: 40 };
    P.branchStall = { "b:progress:Secrets:40": 7 };
    P.abandonedGoals = new Set(["a:Meet People"]);
    P.unlockProg = { "a:Start Journey": { base: 0.1, last: 0.3 } };
    const blob = JSON.parse(JSON.stringify(IP.serializePlanningState(P)));
    const P2 = IP.newPlanningState();
    IP.restorePlanningState(P2, blob);
    const J = JSON.stringify;
    assert.equal(J(P2.activeGoal), J(P.activeGoal));
    assert.equal(J(P2.activeLeaf), J(P.activeLeaf));
    assert.equal(J(P2.branchStall), J(P.branchStall));
    assert.deepEqual([...P2.abandonedGoals], ["a:Meet People"], "abandoned goals restore into a Set");
    assert.equal(J(P2.unlockProg), J(P.unlockProg), "§U unlock-dim baselines round-trip");
});

test("§V3 a locked targeted goal stays ACTIVE (sticky, abandon clock FROZEN) while byte-inert vs the heuristic", async () => {
    // Start Journey is LOCKED for the first ~540 loops (unlocks at Combat+Magic
    // >=35), so no directed spine/leaf can form and planTargeted falls to the
    // heuristic every round. §U (session 29) replaced the unconditional §V3
    // freeze with ARMED unlock-dim tracking, but the observable outcome HERE is
    // unchanged: Combat/Magic exp is [0,0] for the first ~236 loops (measured on
    // the reference run), so the tracker never ARMS in a 10-loop window and the
    // clock stays frozen — the goal must NOT false-stall and abandon before the
    // grind ever starts. goalStallK is LOW here: under pre-V3 semantics (or naive
    // flat-window accrual) the goal would abandon by ~loop 4 — a genuine
    // regression this test guards against. The committed trace still stays
    // byte-identical to the heuristic run (bookkeeping never changes the queue).
    const run = async (strategy) => {
        const ctx = makePlanner(12345);
        const r = await ctx.ev("IdlePlanner").runStandalone({ maxLoops: 10, targetTown: 9, goalStallK: 3,
            ...(strategy === "targeted" ? { strategy: "targeted", targetAction: "Start Journey" } : {}) });
        return r;
    };
    const heur = await run("heuristic");
    const tgt = await run("targeted");
    assert.deepEqual(j(tgt.trace.map(t => t.label)), j(heur.trace.map(t => t.label)),
        "sticky pursuit is byte-inert on the committed trace");
    // the goal persisted across all 10 loops with the abandon clock frozen (locked)
    assert.equal(IP_goalKeyOf(tgt.resume.planning.activeGoal), "a:Start Journey",
        "top goal is still active after 10 loops (not abandoned despite low K)");
    const stall = tgt.resume.planning.branchStall["a:Start Journey"] ?? 0;
    assert.equal(stall, 0, `abandon clock frozen while locked ⇒ stall stays 0 (got ${stall})`);
    assert.equal([...tgt.resume.planning.abandonedGoals].length, 0,
        "a locked kind-a goal never abandons (frozen clock) even at K=3");
});
// goalKey is a planner internal; recompute the key the same way for the assertion
function IP_goalKeyOf(g) { return g ? (g.kind === "a" ? `a:${g.action}` : `b:${g.target?.type}:${g.target?.name ?? ""}:${g.value ?? ""}`) : null; }

// ===========================================================================
// §U (session 29) — armed unlock-dim tracking for LOCKED kind-a goals
// (accrueTopGoalStall regimes, unit-tested on synthetic states)
// ===========================================================================

// A locked-goal fixture: no unlocked actions carry the goal's name, thresholds
// declare a single probeable skill requirement, and the "state" carries just
// the exp the reqFraction arithmetic reads.
function uFixture(IP, { goalStallK = 3, unlockStallK = 3, probeable = true } = {}) {
    const P = IP.newPlanningState({ goalStallK, unlockStallK });
    P.thresholds = { "Start Journey": { probeable, requires: [{ kind: "s", v: "Combat", need: 35 }] } };
    const goal = { kind: "a", action: "Start Journey" };
    const at = (exp) => ({ actions: [], skills: { Combat: { exp } }, towns: [] });
    return { P, goal, at };
}

test("§U armed unlock-dim tracking: never-moved dims stay FROZEN (no arm, no stall, no abandon)", () => {
    const IP = makePlanner(960).ev("IdlePlanner");
    const { P, goal, at } = uFixture(IP);
    for (let i = 0; i < 10; i++) IP.accrueTopGoalStall(P, goal, at(0), at(0));
    assert.equal(IP.goalKey(P.activeGoal), "a:Start Journey", "goal sticky through 10 flat rounds");
    assert.equal(P.branchStall["a:Start Journey"] ?? 0, 0, "clock frozen while un-armed (K=3 never fires)");
    assert.equal(P.abandonedGoals.size, 0, "never abandons in the pre-grind window");
    assert.equal(P.unlockProg["a:Start Journey"].base, P.unlockProg["a:Start Journey"].last, "baseline recorded, never risen");
});

test("§U armed unlock-dim tracking: rising dims keep stall at 0; armed-then-flat accrues and abandons at K", () => {
    const IP = makePlanner(961).ev("IdlePlanner");
    const { P, goal, at } = uFixture(IP);
    IP.accrueTopGoalStall(P, goal, at(0), at(0));       // baseline
    for (const exp of [100, 300, 700]) {                 // rising rounds ARM the tracker
        IP.accrueTopGoalStall(P, goal, at(exp), at(exp));
        assert.equal(P.branchStall["a:Start Journey"] ?? 0, 0, "rising dims reset the clock");
    }
    for (let i = 1; i <= 2; i++) {                       // armed + flat: accrual below K
        IP.accrueTopGoalStall(P, goal, at(700), at(700));
        assert.equal(P.branchStall["a:Start Journey"], i, "armed + flat ⇒ stall accrues");
    }
    assert.equal(P.abandonedGoals.size, 0, "below K ⇒ still active");
    IP.accrueTopGoalStall(P, goal, at(700), at(700));    // stall reaches K=3
    assert.deepEqual([...P.abandonedGoals], ["a:Start Journey"], "armed grind that dies abandons at K");
    assert.equal(P.activeGoal, null, "active goal cleared on abandon");
});

test("§U unprobeable unlock dims fall back to the §V3 freeze (no baseline, no stall)", () => {
    const IP = makePlanner(962).ev("IdlePlanner");
    const { P, goal, at } = uFixture(IP, { probeable: false });
    for (let i = 0; i < 6; i++) IP.accrueTopGoalStall(P, goal, at(i * 100), at(i * 100));
    assert.equal(IP.goalKey(P.activeGoal), "a:Start Journey", "sticky");
    assert.equal(P.unlockProg["a:Start Journey"], undefined, "no §U baseline for unprobeable dims");
    assert.equal(P.branchStall["a:Start Journey"] ?? 0, 0, "§V3 freeze: no stall either way");
});

test("§U an ACTIONABLE goal takes the normal V1 stall path through accrueTopGoalStall", () => {
    const IP = makePlanner(963).ev("IdlePlanner");
    const { P, goal } = uFixture(IP);
    // the goal's action is unlocked now ⇒ normal stalled-loop accounting
    const atUnlocked = { actions: [{ name: "Start Journey", visible: true, unlocked: true }], skills: {}, towns: [] };
    for (let i = 1; i <= 2; i++) {
        IP.accrueTopGoalStall(P, goal, atUnlocked, atUnlocked);
        assert.equal(P.branchStall["a:Start Journey"], i, "actionable ⇒ stall accrues on the bare goal");
    }
    IP.accrueTopGoalStall(P, goal, atUnlocked, atUnlocked);
    assert.deepEqual([...P.abandonedGoals], ["a:Start Journey"], "abandons at K like the V1 path");
});

// ===========================================================================
// §V2 — recursive prerequisite finder (DAG walk + pool-cap discovery)
// ===========================================================================

test("§V2 plProbePoolCap: perturbation-probes the pool cap driver; leaves state bit-identical", () => {
    const ctx = makePlanner(950);
    const sess = ctx.ev("new IdlePlanner.Session()");
    sess.setQueue([["Wander", 1]]); sess.restart();
    // low Secrets base (level ~10) so the probe's bump to L100 clearly RAISES the cap
    ctx.ev("towns[0].expSecrets = 100*10*11/2; adjustAll()");
    const before = sess.snapshot();
    // Secrets drives baseLQuests (actionList.js:1291-1294 — the TEST cross-check
    // oracle); Met drives SQuests, NOT LQuests — the wrong-branch trap V0 flagged.
    const ranked = sess.probePoolCap("LQuests", 0,
        [{ kind: "p", v: "Secrets", town: 0 }, { kind: "p", v: "Met", town: 0 }]);
    const sec = ranked.find(d => d.v === "Secrets");
    assert.ok(sec && sec.delta > 0, `Secrets drives totalLQuests (got ${JSON.stringify(ranked)})`);
    assert.ok(!ranked.some(d => d.v === "Met"), "Met drives SQuests not LQuests ⇒ Δ=0 ⇒ not reported");
    assert.equal(sess.snapshot(), before, "the probe restores the full-state snapshot bit-for-bit");
});

test("§V2 poolCapCandidates: grindable dims in; unreachable multipliers out (reachability filter)", () => {
    const IP = makePlanner(951).ev("IdlePlanner");
    // town-0-only state: Secrets has a grinder (Investigate), Ghost has none,
    // Practical has a town-0 trainer, Spatiomancy's trainer is elsewhere (locked).
    const state = { townsUnlocked: [0], skills: { Spatiomancy: { level: 0 }, Practical: { level: 0 } },
        towns: [{ index: 0, progress: { Secrets: { level: 5 }, Ghost: { level: 0 } }, limited: {} }],
        actions: [
            { name: "Investigate", townNum: 0, type: "progress", varName: "Secrets", visible: true, unlocked: true, cost: 300, skillsGained: [] },
            { name: "Pickpocket", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 100, skillsGained: ["Practical"] },
        ] };
    const cands = IP.poolCapCandidates(state);
    assert.ok(cands.some(d => d.kind === "p" && d.v === "Secrets"), "Secrets is grindable (Investigate) ⇒ candidate");
    assert.ok(!cands.some(d => d.kind === "p" && d.v === "Ghost"), "Ghost has no grinder ⇒ excluded");
    assert.ok(cands.some(d => d.kind === "s" && d.v === "Practical"), "Practical has a town-0 trainer ⇒ candidate");
    assert.ok(!cands.some(d => d.kind === "s" && d.v === "Spatiomancy"), "Spatiomancy has no reachable trainer ⇒ excluded (disambiguates the town-0 driver)");
});

test("§V2 poolGood target: readStateValue reads pool `good`; rankValueProviders returns the limited action", () => {
    const IP = makePlanner(952).ev("IdlePlanner");
    const state = { townsUnlocked: [0],
        towns: [{ index: 0, limited: { LQuests: { good: 4, checked: 20, total: 25 } }, progress: {} }],
        actions: [{ name: "Long Quest", townNum: 0, type: "limited", varName: "LQuests", visible: true, unlocked: true, cost: 2000 }] };
    assert.equal(IP.readStateValue(state, { type: "poolGood", name: "LQuests", town: 0 }), 4);
    const provs = IP.rankValueProviders(state, new Map(), { type: "poolGood", name: "LQuests", town: 0 });
    assert.equal(provs.length, 1);
    assert.equal(provs[0].a.name, "Long Quest", "the pool's own limited action checks items ⇒ grows good");
});

// Shared synthetic near-fixated scenario: a rep-capacity-bound Start Journey push
// (Buy Supplies toll + Haggle reducer) over a Long Quest rep pool, plus a Secrets
// grinder (Investigate). The pool's checked/total decides whether the finder
// enriches `good` directly or must recurse to the cap driver.
function v2Scenario(lquests) {
    const state = {
        townsUnlocked: [0], baseMana: 250, skills: {},
        towns: [{ index: 0, limited: { LQuests: lquests }, progress: { Secrets: { level: 31 } } }],
        actions: [
            { name: "Start Journey", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 1000, travelDests: [1], skillsGained: [] },
            { name: "Buy Supplies", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 100, goldCost: 240, skillsGained: [] },
            { name: "Haggle", townNum: 0, type: "normal", visible: true, unlocked: true, cost: 100, skillsGained: [] },
            { name: "Long Quest", townNum: 0, type: "limited", varName: "LQuests", visible: true, unlocked: true, cost: 2000, skillsGained: [] },
            { name: "Investigate", townNum: 0, type: "progress", varName: "Secrets", visible: true, unlocked: true, cost: 300, skillsGained: [] },
        ],
    };
    const know = new Map([
        ["Buy Supplies", { exec: 1, grants: { supplies: 1 }, goldPerExec: -240, costReductions: {}, repPerExec: 0, ticksPerExec: 100, manaPerExec: 0, manaPerGold: 0 }],
        ["Haggle", { exec: 1, grants: {}, goldPerExec: 0, costReductions: { "Buy Supplies": 20 }, repPerExec: -1, ticksPerExec: 100, manaPerExec: 0, manaPerGold: 0 }],
        ["Long Quest", { exec: 1, grants: {}, goldPerExec: 5, costReductions: {}, repPerExec: 1, ticksPerExec: 2000, manaPerExec: 0, manaPerGold: 0 }],
        ["Investigate", { exec: 1, grants: {}, goldPerExec: 0, costReductions: {}, repPerExec: 0, ticksPerExec: 300, manaPerExec: 0, manaPerGold: 0 }],
    ]);
    // stub sess: Start Journey needs supplies; the pool-cap probe reports Secrets
    // (the real probe is exercised by the plProbePoolCap harness test above).
    const sess = {
        needs: (n) => n === "Start Journey" ? ["supplies"] : [],
        probePoolCap: () => [{ kind: "p", v: "Secrets", town: 0, delta: 34 }],
    };
    return { state, know, sess };
}

test("§V2 analyzePushBottleneck: a rep-capacity-bound push returns the growable rep pool", () => {
    const IP = makePlanner(953).ev("IdlePlanner");
    const { state, know, sess } = v2Scenario({ good: 3, checked: 16, total: 16 });
    const X = state.actions.find(a => a.name === "Start Journey");
    const pool = IP.analyzePushBottleneck(state, know, sess, X);
    assert.ok(pool, "the push IS rep-capacity-bound (Haggle hMax = floor(repCap/repPerUse) = 3 < ceil(240/20)=12)");
    assert.equal(pool.a.name, "Long Quest", "the binding pool is the rep-yielding Long Quest pool");
    // a fat rep pool (repCapacity high enough) is NOT bound ⇒ no bottleneck to grow
    const fat = v2Scenario({ good: 20, checked: 16, total: 16 });
    assert.equal(IP.analyzePushBottleneck(fat.state, fat.know, fat.sess, X), null,
        "hMax rep-term no longer binds (repCap 20 >= cost-term 12) ⇒ null");
});

test("§V2 findSetupLeaf: EXHAUSTED rep pool ⇒ recurse through the cap edge to the Secrets leaf", () => {
    const IP = makePlanner(954).ev("IdlePlanner");
    const { state, know, sess } = v2Scenario({ good: 3, checked: 16, total: 16 });   // checked>=total ⇒ exhausted
    const leaf = IP.findSetupLeaf(state, know, sess, { kind: "a", action: "Start Journey" });
    assert.deepEqual(j(leaf), { kind: "b", target: { type: "progress", name: "Secrets", town: 0 } },
        "pool exhausted ⇒ the leaf is the probed cap driver (Secrets), recursed to arbitrary depth");
});

test("§V2 findSetupLeaf: rep pool with UNCHECKED headroom ⇒ the leaf is enriching good (poolGood)", () => {
    const IP = makePlanner(955).ev("IdlePlanner");
    const { state, know, sess } = v2Scenario({ good: 3, checked: 16, total: 25 });   // 9 unchecked ⇒ actionable now
    const leaf = IP.findSetupLeaf(state, know, sess, { kind: "a", action: "Start Journey" });
    assert.deepEqual(j(leaf), { kind: "b", target: { type: "poolGood", name: "LQuests", town: 0 } },
        "unchecked headroom ⇒ CHECK items directly (poolGood), no cap recursion");
});

test("§V2 findSetupLeaf: a fat/unbound push has no prerequisite leaf (⇒ heuristic fallback)", () => {
    const IP = makePlanner(956).ev("IdlePlanner");
    const { state, know, sess } = v2Scenario({ good: 20, checked: 16, total: 16 });
    assert.equal(IP.findSetupLeaf(state, know, sess, { kind: "a", action: "Start Journey" }), null,
        "no rep-capacity bottleneck ⇒ no setup leaf");
});

// ===========================================================================
// §V4 — two-tier UI: read-only Tier-2 chain derivation (deriveTier2Tree walks
// the SAME finder edges as findSetupLeaf but COLLECTS every node). It adds no
// new sim mutation beyond probePoolCap, whose bit-identity is proven above (the
// plProbePoolCap test), so deriveTier2Tree is byte-inert by construction.
// ===========================================================================

test("§V4 deriveTier2Tree: EXHAUSTED pool ⇒ full chain root→pool→dim(Secrets leaf)", () => {
    const IP = makePlanner(960).ev("IdlePlanner");
    const { state, know, sess } = v2Scenario({ good: 3, checked: 16, total: 16 });
    const tree = j(IP.deriveTier2Tree(state, know, sess, { kind: "a", action: "Start Journey" }));
    assert.equal(tree.kind, "goal-a");
    assert.equal(tree.action, "Start Journey");
    assert.equal(tree.locked, false);
    assert.equal(tree.children.length, 1, "one bottleneck pool child");
    const pool = tree.children[0];
    assert.equal(pool.kind, "pool");
    assert.deepEqual(pool.target, { type: "poolGood", name: "LQuests", town: 0 });
    assert.equal(pool.grindAction, "Long Quest");
    assert.equal(pool.children.length, 1, "exhausted ⇒ recurse to the cap driver");
    const dim = pool.children[0];
    assert.equal(dim.kind, "dim");
    assert.deepEqual(dim.target, { type: "progress", name: "Secrets", town: 0 });
    assert.equal(dim.leaf, true, "Secrets is grindable-from-here ⇒ the leaf");
    assert.equal(dim.grindAction, "Investigate");
});

test("§V4 deriveTier2Tree: UNCHECKED headroom ⇒ pool is the leaf, no cap recursion", () => {
    const IP = makePlanner(961).ev("IdlePlanner");
    const { state, know, sess } = v2Scenario({ good: 3, checked: 16, total: 25 });
    const tree = j(IP.deriveTier2Tree(state, know, sess, { kind: "a", action: "Start Journey" }));
    assert.equal(tree.children.length, 1);
    const pool = tree.children[0];
    assert.equal(pool.leaf, true, "unchecked headroom ⇒ CHECK items directly (poolGood leaf)");
    assert.equal(pool.children.length, 0, "no recursion to a cap driver");
});

test("§V4 deriveTier2Tree: fat/unbound push ⇒ root with no children + a fallback note", () => {
    const IP = makePlanner(962).ev("IdlePlanner");
    const { state, know, sess } = v2Scenario({ good: 20, checked: 16, total: 16 });
    const tree = j(IP.deriveTier2Tree(state, know, sess, { kind: "a", action: "Start Journey" }));
    assert.equal(tree.children.length, 0, "no bottleneck ⇒ no prerequisite chain");
    assert.ok(tree.note, "carries a heuristic-fallback note for the UI");
});

test("§V4 deriveTier2Tree: a LOCKED action ⇒ root locked:true, note, no children (matches the freeze)", () => {
    const IP = makePlanner(963).ev("IdlePlanner");
    const { state, know, sess } = v2Scenario({ good: 3, checked: 16, total: 16 });
    state.actions.find(a => a.name === "Start Journey").unlocked = false;   // still-locked goal
    const tree = j(IP.deriveTier2Tree(state, know, sess, { kind: "a", action: "Start Journey" }));
    assert.equal(tree.kind, "goal-a");
    assert.equal(tree.locked, true);
    assert.equal(tree.children.length, 0, "locked ⇒ no chain (heuristic builds toward the unlock)");
    assert.ok(tree.note, "carries a locked note");
});

test("§V4 deriveTier2Tree: a kind-b value goal ⇒ leaf root (its own provider), no deeper chain", () => {
    const IP = makePlanner(964).ev("IdlePlanner");
    const { state, know, sess } = v2Scenario({ good: 3, checked: 16, total: 16 });
    const goal = { kind: "b", target: { type: "skill", name: "Magic" }, value: 40 };
    const tree = j(IP.deriveTier2Tree(state, know, sess, goal));
    assert.equal(tree.kind, "goal-b");
    assert.deepEqual(tree.target, { type: "skill", name: "Magic" });
    assert.equal(tree.leaf, true);
    assert.equal(tree.children.length, 0);
});

// ===========================================================================
// §V5 — planner-consume: a user-authored Tier-2 override (tier2Mode:"user" +
// userTier2, the V4 editor's storage) replaces the auto-derived setup leaf;
// the auto finder stays the fallback when the override is empty/exhausted.
// ===========================================================================

test("§V5 tier2UserLeaves: only an explicit user override yields leaves; reached stop values are skipped", () => {
    const IP = makePlanner(965).ev("IdlePlanner");
    const state = { townsUnlocked: [0], skills: { Magic: { level: 10 } },
        towns: [{ index: 0, limited: { LQuests: { good: 3, checked: 16, total: 16 } },
                  progress: { Secrets: { level: 31 } } }] };
    const goal = { kind: "a", action: "Start Journey", tier2Mode: "user", userTier2: [
        { target: { type: "progress", name: "Secrets", town: 0 }, label: "Secrets", value: 20 },  // 31 >= 20 ⇒ exhausted
        { target: { type: "skill", name: "Magic" }, value: 50 },
        { target: { type: "poolGood", name: "LQuests", town: 0 }, label: "LQuests" },             // no stop value ⇒ always eligible
    ] };
    assert.deepEqual(j(IP.tier2UserLeaves(state, goal)), [
        { kind: "b", target: { type: "skill", name: "Magic" }, value: 50 },
        { kind: "b", target: { type: "poolGood", name: "LQuests", town: 0 } },
    ], "entries map to ordered kind-b leaves; reached stop values drop out");
    assert.deepEqual(j(IP.tier2UserLeaves(state, { kind: "a", action: "Start Journey", userTier2: goal.userTier2 })), [],
        "absent tier2Mode ⇒ auto ⇒ no leaves (byte-inert)");
    assert.deepEqual(j(IP.tier2UserLeaves(state, { ...goal, tier2Mode: "auto" })), [],
        "auto mode ⇒ no leaves even with a stored list (lossless switch)");
    assert.deepEqual(j(IP.tier2UserLeaves(state, { kind: "a", action: "Start Journey", tier2Mode: "user" })), [],
        "user mode with no list ⇒ no leaves");
});

test("§V5 planTargeted honors a user Tier-2 override: the pinned dim's setup rounds install; auto never pins", async () => {
    // Fresh save, goal Start Journey (LOCKED early: Combat+Magic >= 35). AUTO
    // derives no leaf while locked (findSetupLeaf null ⇒ §V3 freeze + heuristic
    // fallback). A USER override pinning Wander progress (grindable from loop 1)
    // must CHANGE WHAT PLAYS: planTargeted installs `value:progress:Wander>…`
    // setup rounds. The pin's stop value then EXHAUSTS it and later loops fall
    // back — a stale override never dead-ends the goal.
    const run = async (goal) => {
        const ctx = makePlanner(12346);
        return await ctx.ev("IdlePlanner").runStandalone({ maxLoops: 8, targetTown: 9,
            strategy: "targeted", targets: [goal] });
    };
    const auto = await run({ kind: "a", action: "Start Journey" });
    const user = await run({ kind: "a", action: "Start Journey", tier2Mode: "user",
        userTier2: [{ target: { type: "progress", name: "Wander", town: 0 }, label: "Wander progress", value: 2 }] });
    const isPin = (l) => l.startsWith("value:progress:Wander>");
    const userLabels = user.trace.map(t => t.label);
    assert.ok(userLabels.some(isPin),
        `the pinned setup round installs (labels: ${userLabels.join(", ")})`);
    assert.ok(!auto.trace.some(t => isPin(t.label)),
        "auto mode never pursues the pin (locked goal ⇒ no auto leaf ⇒ heuristic)");
    const lastPin = userLabels.map(isPin).lastIndexOf(true);
    assert.ok(lastPin < userLabels.length - 1,
        "the pin exhausts at its stop value and later loops fall back (no dead end)");
    assert.equal(IP_goalKeyOf(user.resume.planning.activeGoal), "a:Start Journey",
        "the top goal stays sticky through the override rounds");
});
