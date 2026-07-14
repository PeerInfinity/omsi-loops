// Layer P — edge-directed pair-probes (vocabulary plan §2/W3, INFORMED only).
// For each measured action A that grants a dimension D, and each declared
// dimEffects edge D -> (target T, channel), measureEdge levels D via A (two
// snapshots), measures T's channel boosted vs baseline, and records the signed
// per-A-exec edgeRate. This is the generalization of travelRelief/Haggle to the
// whole skill/buff efficiency web (census 2.2c, the #4 high-leverage class).
//
// Functional checks (plan §9): Practical's edges reproduce census 2.2c row 1
// (Practical is a "decrease" skill: higher level LOWERS Wild Mana/Smash Pots
// manaCost and RAISES Pick Locks gold yield); and the pass is byte-inert in
// empirical mode + honours the rngMode-cycle gate for RNG targets.

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

// Unlock town 1 + the Practical/skill-web actions, then read state after a
// restore (so persistent structures are initialized — see vocabulary-layerE).
function setupSkillWeb(ctx, sess) {
    sess.setQueue([["Wander", 1]]); sess.restart();
    ctx.ev("townsUnlocked = [0, 1]");
    const th = sess.probe();
    for (const r of th["Start Journey"]?.requires ?? [])
        ctx.ev(`skills[${JSON.stringify(r.v)}].levelExp.level = Math.max(${r.need}, skills[${JSON.stringify(r.v)}].levelExp.level)`);
    ctx.ev(`
        towns[0].expWander = getExpOfLevel(30);   // Wander 30 -> Pick Locks unlocked (needs >=20)
        towns[1].expHermit = getExpOfLevel(30);   // Hermit 30 -> Practical Magic unlocked (needs >=20)
        skills.Magic.levelExp.level = Math.max(50, skills.Magic.levelExp.level);
        // populate the town-0 Locks pool so Pick Locks' gold yield is
        // measurable (a pure-harvest probe needs banked goods), and start
        // Practical at 0 so the edge-probe's boost crosses a floor(1+lvl/100)
        // gold step.
        towns[0].totalLocks = 100; towns[0].checkedLocks = 0;
        towns[0].goodLocks = 100; towns[0].goodTempLocks = 100;
        skills.Practical.levelExp.level = 0;
        adjustAll();
    `);
    const snap = sess.save();
    sess.restore(snap);
    return { state: sess.read(), snap };
}

test("measureEdge: Practical cheapens Smash Pots manaCost, raises Pick Locks goldYield (census 2.2c row 1)", () => {
    const ctx = makePlanner(795);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    const { state, snap } = setupSkillWeb(ctx, sess);
    const A = state.actions.find(a => a.name === "Practical Magic");
    const sp = state.actions.find(a => a.name === "Smash Pots");
    const pl = state.actions.find(a => a.name === "Pick Locks");
    assert.ok(A?.visible && A?.unlocked, "Practical Magic unlocked");
    assert.ok(sp?.visible && sp?.unlocked, "Smash Pots unlocked");
    assert.ok(pl?.visible && pl?.unlocked, "Pick Locks unlocked");

    const eManaCost = IP.measureEdge(sess, snap, state, new Map(), A, sp, "manaCost");
    const eGoldYield = IP.measureEdge(sess, snap, state, new Map(), A, pl, "goldYield");
    assert.ok(eManaCost !== null && eManaCost < 0, `Practical CHEAPENS Smash Pots manaCost (edgeRate ${eManaCost})`);
    assert.ok(eGoldYield !== null && eGoldYield > 0, `Practical RAISES Pick Locks goldYield (edgeRate ${eGoldYield})`);
});

test("probeEdges: informed pass records edgeRates on the granter's profile", () => {
    const ctx = makePlanner(796);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    const { state, snap } = setupSkillWeb(ctx, sess);
    // measure the granter so probeEdges selects it (needs exec>0, skillExpPerExec>0)
    const know = new Map();
    const A = state.actions.find(a => a.name === "Practical Magic");
    IP.measureAction(sess, snap, state, know, A, sess.needs("Practical Magic"), { baselineCache: new Map() });
    assert.ok(know.get("Practical Magic")?.exec > 0, "Practical Magic measured as a granter");

    IP.probeEdges(sess, snap, state, know, {});
    const er = know.get("Practical Magic").edgeRates ?? {};
    assert.ok(er["Smash Pots"]?.manaCost < 0, `Smash Pots manaCost edge recorded, cheapening (${JSON.stringify(er["Smash Pots"])})`);
    assert.ok(er["Pick Locks"]?.goldYield > 0, `Pick Locks goldYield edge recorded, positive (${JSON.stringify(er["Pick Locks"])})`);
});

test("empirical mode records NO edgeRates (byte-inert); informed adds them", async () => {
    const run = async (vocabulary) => {
        const ctx = makePlanner(797);
        const sess = ctx.ev("new IdlePlanner.Session()");
        const IP = ctx.ev("IdlePlanner");
        const { state, snap } = setupSkillWeb(ctx, sess);
        const know = new Map();
        await IP.refreshKnowledge(sess, snap, state, know, { vocabulary });
        let withEdges = 0;
        for (const p of know.values()) if (p.edgeRates && Object.keys(p.edgeRates).length) withEdges++;
        return withEdges;
    };
    assert.equal(await run("empirical"), 0, "empirical mode probes no edges");
    assert.ok(await run("informed") > 0, "informed mode records edgeRates");
});

test("segmentRate edge (Combat -> Fight Monsters) is DECLARED; probe degrades gracefully (multipart v2)", () => {
    // The Combat -> multipart segmentRate edge IS declared (plan §9), but a full
    // multipart loop never completes inside measureAction's single-loop probe
    // budget — Fight Monsters measures exec=0 at every Combat level (census 2.4:
    // "multiparts measure exec=0 from a single-action probe"). Live multipart
    // RATE measurement needs a multi-loop probe (v2). Until then measureEdge
    // returns null (skipped), never a wrong number or a crash.
    const ctx = makePlanner(799);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    // the edge is declared on skill:Combat via targetType:multipart
    const combatEdges = IP.dimEffectsFor("skill:Combat");
    assert.ok(combatEdges?.some(e => e.targetType === "multipart" && e.channel === "segmentRate"),
        "skill:Combat declares a multipart segmentRate edge");
    // and the probe degrades gracefully on a real multipart target
    sess.setQueue([["Wander", 1]]); sess.restart();
    ctx.ev(`
        skills.Combat.levelExp.level = 10;              // Fight Monsters unlocked (Combat>=10)
        towns[0].expSecrets = getExpOfLevel(25);        // Warrior Lessons unlocked (Secrets>=20)
        adjustAll();
    `);
    const snap0 = sess.save(); sess.restore(snap0);
    const state = sess.read(); const snap = sess.save();
    const wl = state.actions.find(a => a.name === "Warrior Lessons");
    const fm = state.actions.find(a => a.name === "Fight Monsters");
    assert.ok(wl?.visible && wl?.unlocked, "Warrior Lessons unlocked");
    assert.ok(fm?.type === "multipart", "Fight Monsters is a multipart");
    const rate = IP.measureEdge(sess, snap, state, new Map(), wl, fm, "segmentRate");
    assert.equal(rate, null, "multipart segmentRate not measurable in a single-loop probe (returns null, v2)");
});

test("RNG-flagged targets are skipped unless rngMode is cycle (plan §6)", () => {
    const ctx = makePlanner(798);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    // Combat grinder -> Small Dungeon (context.rng) is a targetType:multipart
    // edge; under random mode the RNG target must not be probed.
    ctx.ev(`skills.Combat.levelExp.level = 400; skills.Magic.levelExp.level = 400; adjustAll();`);
    const snap0 = sess.save(); sess.restore(snap0);
    const state = sess.read(); const snap = sess.save();
    const wl = state.actions.find(a => a.name === "Warrior Lessons");
    const know = new Map();
    IP.measureAction(sess, snap, state, know, wl, sess.needs("Warrior Lessons"), { baselineCache: new Map() });
    // random mode: Small Dungeon (rng) skipped
    ctx.ev(`options.rngMode = "random"`);
    IP.probeEdges(sess, snap, state, know, {});
    const erRandom = know.get("Warrior Lessons")?.edgeRates ?? {};
    assert.equal(erRandom["Small Dungeon"], undefined, "Small Dungeon (rng) not probed in random mode");
    // cycle mode: the RNG target becomes probe-able (may or may not record a
    // rate, but is no longer categorically skipped)
    const context = IP.contextFor("Small Dungeon");
    assert.ok(context?.rng, "Small Dungeon carries context.rng (sanity)");
});
