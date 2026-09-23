// Planner-state readouts for the Automation view (AUTOMATION.md §4a/§5):
// the four formerly hard-coded knobs as options, the within-run counters the
// worker now sends, and the round-kind tag on every plan result.
//
// Pins three rules the UI relies on:
//   1. antiFixK is a BASE. The working value doubles after a failed escalation
//      and must SURVIVE the next request carrying the same base; only a changed
//      base resets it (else the setting would silently disable the backoff).
//   2. The worker forwards the four params into its planning state and reports
//      them back in the dump's separate `readouts` field.
//   3. The round-kind tag is metadata only: planner.js writes it, never reads it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { makeContext, ROOT } from "./harness.mjs";

function makePlanner(seed) {
    const ctx = makeContext(seed, ["planner-metadata.js", "planner.js"]);
    ctx.sandbox.__rngGet = ctx.getRng;
    ctx.sandbox.__rngSet = ctx.setRng;
    ctx.ev("IdlePlanner.setRngHooks({ get: __rngGet, set: __rngSet })");
    return ctx;
}

// ---- 1. applyTunables: the antiFixK base/doubling rule ----------------------

test("applyTunables: antiFixK is a BASE — a failed escalation's doubling survives same-base requests; a new base resets it", () => {
    const IP = makePlanner(1).ev("IdlePlanner");
    const P = IP.newPlanningState();
    assert.equal(P.antiFixK, 256, "default working K = the historical constant");
    assert.equal(P.antiFixKBase, 256);
    assert.equal(P.droughtLimit, 256);

    // the default request (base 256) is a no-op on a fresh state
    IP.applyTunables(P, { antiFixK: 256 });
    assert.equal(P.antiFixK, 256);

    // a failed escalation (same queue re-committed on an escalation round) doubles K
    const post = { actions: [{ name: "Wander", visible: true, unlocked: true }] };
    P.lastCommitted = [["Wander", 1]];
    IP.updateStagnation(P, { c: { q: [["Wander", 1]] }, post }, true);
    assert.equal(P.antiFixK, 512, "failed escalation doubles the working K");

    // the next request carries the SAME base: the doubled value must survive
    IP.applyTunables(P, { antiFixK: 256 });
    assert.equal(P.antiFixK, 512, "an unchanged base must not undo the backoff");
    IP.updateStagnation(P, { c: { q: [["Wander", 1]] }, post }, true);
    assert.equal(P.antiFixK, 1024, "backoff keeps compounding across rounds");
    IP.applyTunables(P, { antiFixK: 256 });
    assert.equal(P.antiFixK, 1024);

    // the user CHANGES the setting: the working K resets to the new base
    IP.applyTunables(P, { antiFixK: 100 });
    assert.equal(P.antiFixK, 100, "a changed base resets the working K");
    assert.equal(P.antiFixKBase, 100);
    IP.updateStagnation(P, { c: { q: [["Wander", 1]] }, post }, true);
    assert.equal(P.antiFixK, 200);
    IP.applyTunables(P, { antiFixK: 100 });
    assert.equal(P.antiFixK, 200, "the doubling is kept under the new base too");
    // changing back to the old value is a change as well
    IP.applyTunables(P, { antiFixK: 256 });
    assert.equal(P.antiFixK, 256);
});

test("applyTunables: the other three knobs overwrite; absent / NaN / non-positive values are ignored", () => {
    const IP = makePlanner(1).ev("IdlePlanner");
    const P = IP.newPlanningState();
    IP.applyTunables(P, { goalStallK: 7, unlockStallK: 9, droughtLimit: 11 });
    assert.deepEqual([P.goalStallK, P.unlockStallK, P.droughtLimit], [7, 9, 11]);
    IP.applyTunables(P, {});
    IP.applyTunables(P, { goalStallK: NaN, unlockStallK: 0, droughtLimit: -3, antiFixK: NaN });
    IP.applyTunables(P, { goalStallK: undefined, unlockStallK: null, droughtLimit: "12" });
    assert.deepEqual([P.goalStallK, P.unlockStallK, P.droughtLimit, P.antiFixK], [7, 9, 11, 256],
        "an emptied input (parseInt → NaN) never clobbers a knob");
});

test("newPlanningState: the headless opts path still carries goalStallK/unlockStallK (and now antiFixK/droughtLimit)", () => {
    const IP = makePlanner(1).ev("IdlePlanner");
    const d = IP.newPlanningState();
    assert.deepEqual([d.goalStallK, d.unlockStallK, d.antiFixK, d.antiFixKBase, d.droughtLimit], [20, 64, 256, 256, 256],
        "defaults = the historical constants");
    const P = IP.newPlanningState({ goalStallK: 5, unlockStallK: 6, antiFixK: 40, droughtLimit: 50 });
    assert.deepEqual([P.goalStallK, P.unlockStallK, P.antiFixK, P.antiFixKBase, P.droughtLimit], [5, 6, 40, 40, 50]);
    // the readouts helper reports exactly those
    const r = JSON.parse(JSON.stringify(IP.plannerReadouts(P)));
    assert.deepEqual(r, { streak: 0, drought: 0, antiFixK: 40, antiFixKBase: 40, droughtLimit: 50,
                          antiFixation: false, strategy: "heuristic", goalStallK: 5, unlockStallK: 6 });
});

test("readouts are a SEPARATE channel: serializePlanningState (the resume format) is unchanged", () => {
    const IP = makePlanner(1).ev("IdlePlanner");
    const keys = Object.keys(IP.serializePlanningState(IP.newPlanningState())).sort();
    assert.deepEqual(keys, ["abandonedGoals", "activeGoal", "activeLeaf", "branchStall", "know", "lastCommitted",
        "loop", "pre", "prevProbeTicks", "prevTimeNeeded", "thresholds", "unlockProg"]);
});

// ---- 2. the worker forwards the params --------------------------------------

// Boot planner-worker.js in a Node vm the way a browser Worker would run it:
// `self` is the global, importScripts evaluates files in order, postMessage
// is captured, and the script's own `onmessage = …` lands on the global.
function bootWorker() {
    const posted = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
        setTimeout, clearTimeout, setInterval, clearInterval, performance,
        structuredClone: (o) => JSON.parse(JSON.stringify(o ?? null)),
        postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))),
    };
    sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    sandbox.importScripts = (...files) => {
        for (const f of files) {
            new vm.Script(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f }).runInContext(sandbox);
        }
    };
    new vm.Script(fs.readFileSync(path.join(ROOT, "planner-worker.js"), "utf8"), { filename: "planner-worker.js" })
        .runInContext(sandbox);
    const send = async (data) => { await sandbox.onmessage({ data }); return posted[posted.length - 1]; };
    return { posted, send };
}

test("planner-worker forwards goalStallK / unlockStallK / antiFixK / droughtLimit and reports them in the dump", async () => {
    const w = bootWorker();
    assert.equal(w.posted[0]?.type, "ready", "the worker booted");
    const before = await w.send({ type: "dump" });
    assert.equal(before.type, "dumpResult");
    assert.deepEqual([before.readouts.goalStallK, before.readouts.unlockStallK, before.readouts.antiFixK, before.readouts.droughtLimit],
        [20, 64, 256, 256], "defaults before any request");
    assert.ok("planning" in before && "perf" in before, "dump carries planning + perf");

    // The params are applied at the top of the plan handler, before the save
    // is restored — so an unparseable save still exercises the forwarding
    // (the round itself errors out, which is what makes this test cheap).
    const res = await w.send({ type: "plan", reqId: 1, save: "{not json",
        params: { goalStallK: 11, unlockStallK: 33, antiFixK: 77, droughtLimit: 99, antiFixation: true } });
    assert.equal(res.type, "error", "the bad save fails the round (after the params landed)");
    const after = await w.send({ type: "dump" });
    assert.deepEqual([after.readouts.goalStallK, after.readouts.unlockStallK, after.readouts.antiFixK,
                      after.readouts.antiFixKBase, after.readouts.droughtLimit, after.readouts.antiFixation],
        [11, 33, 77, 77, 99, true], "all four knobs forwarded into the worker's planning state");

    // a request WITHOUT the new params (an older caller) leaves them alone
    await w.send({ type: "plan", reqId: 2, save: "{not json", params: { screenK: 8 } });
    const again = await w.send({ type: "dump" });
    assert.deepEqual([again.readouts.goalStallK, again.readouts.antiFixK], [11, 77]);
});

// ---- 3. the round-kind tag --------------------------------------------------

// Drive planRound with runStandalone's own commit steps, collecting the tags.
async function roundTags(seed, opts, loops, mutate = null) {
    const ctx = makePlanner(seed);
    const IP = ctx.ev("IdlePlanner");
    const sess = new IP.Session();
    const P = IP.newPlanningState(opts);
    P.pre = sess.read();
    const tags = [], labels = [];
    for (let i = 0; i < loops; i++) {
        const res = await IP.planRound(sess, P);
        tags.push(JSON.parse(JSON.stringify(res.round ?? null)));
        labels.push(res.best.c.label);
        if (mutate) mutate(res);
        const { best } = res;
        sess.restore(best.postSnap);
        P.prevTimeNeeded = best.capacity;
        P.prevProbeTicks = best.probeTicks;
        P.lastCommitted = best.c.q;
        P.pre = best.post;
    }
    return { tags, labels };
}

const KINDS = ["goal-push", "setup", "targeted-fallback", "escalation", "escalation-fallback", "heuristic"];

test("round kind: every round is tagged; the heuristic strategy tags 'heuristic'", async () => {
    const { tags } = await roundTags(12345, {}, 4);
    assert.equal(tags.length, 4);
    for (const t of tags) assert.deepEqual(t, { kind: "heuristic", goal: null, leaf: null });
});

test("round kind: targeted setup rounds name their goal + leaf; an unreachable goal tags the fallback", async () => {
    // the §V5 scenario (planner.test.mjs): Start Journey is LOCKED early; a user
    // Tier-2 override pinning Wander progress installs setup rounds, then the
    // pin exhausts at its stop value and later rounds fall back to the heuristic
    const goal = { kind: "a", action: "Start Journey", tier2Mode: "user",
        userTier2: [{ target: { type: "progress", name: "Wander", town: 0 }, label: "Wander progress", value: 2 }] };
    const { tags, labels } = await roundTags(12346, { strategy: "targeted", targets: [goal] }, 6);
    for (const t of tags) assert.ok(KINDS.includes(t?.kind), `known kind: ${JSON.stringify(t)}`);
    const setup = tags.filter(t => t.kind === "setup");
    assert.ok(setup.length > 0, `some setup rounds (labels: ${labels.join(", ")})`);
    for (const t of setup) {
        assert.equal(t.goal, "a:Start Journey", "a setup round names the goal it served");
        assert.equal(t.leaf, "b:progress:Wander:2", "…and the leaf it grew");
    }
    assert.ok(tags.some(t => t.kind === "targeted-fallback"),
        `the exhausted pin falls back, tagged as the targeted strategy's fallback (${tags.map(t => t.kind).join(", ")})`);
});

test("round kind: a reachable kind-b goal installs as a goal push naming its goal", async () => {
    const goal = { kind: "b", target: { type: "progress", name: "Wander", town: 0 }, value: 3 };
    const { tags, labels } = await roundTags(12346, { strategy: "targeted", targets: [goal] }, 3);
    const push = tags.filter(t => t.kind === "goal-push");
    assert.ok(push.length > 0, `a goal push (kinds: ${tags.map(t => t.kind).join(", ")}; labels: ${labels.join(", ")})`);
    for (const t of push) assert.equal(t.goal, "b:progress:Wander:3");
});

test("round kind is METADATA ONLY: planner.js never reads it; mutating it changes nothing", async () => {
    // (a) source scan over the CODE (comments stripped): the identifier
    // `round` may appear only as a tag write (`x.round = …`), the local that
    // builds planRound's tag (`const round = …`), or that local returned
    // (`…, evals, round }`). Anything else would be planning code reading it.
    const src = fs.readFileSync(path.join(ROOT, "planner.js"), "utf8");
    const ALLOWED = [/\.round\s*=(?!=)/y, /const round\s*=/y, /evals, round \}/y];
    let writes = 0;
    src.split("\n").forEach((raw, i) => {
        const code = raw.replace(/\/\/.*$/, "");
        for (const m of code.matchAll(/\bround\b/g)) {
            if (code.slice(0, m.index).endsWith("Math.")) continue;   // Math.round, not the tag
            const at = code[m.index - 1] === "." ? m.index - 1 : (code.slice(0, m.index).endsWith("const ") ? m.index - 6
                : code.slice(0, m.index).endsWith("evals, ") ? m.index - 7 : m.index);
            const ok = ALLOWED.some(re => { re.lastIndex = at; return re.test(code); });
            assert.ok(ok, `planner.js:${i + 1} uses \`round\` outside a tag write: ${raw.trim()}`);
            if (code[m.index - 1] === ".") writes++;
        }
    });
    assert.ok(writes >= 2, "the tag is written in planTargeted (vacuity guard)");
    // (b) behavioural: scrambling the tag after every round leaves planning identical
    const goal = { kind: "a", action: "Start Journey", tier2Mode: "user",
        userTier2: [{ target: { type: "progress", name: "Wander", town: 0 }, label: "Wander progress", value: 2 }] };
    const opts = { strategy: "targeted", targets: [goal] };
    const clean = await roundTags(12346, opts, 5);
    const scrambled = await roundTags(12346, opts, 5, (res) => {
        res.round.kind = "bogus"; res.round.goal = "a:Nothing"; delete res.round.leaf;
    });
    assert.deepEqual(scrambled.labels, clean.labels, "committed queues identical whatever the tag says");
});
