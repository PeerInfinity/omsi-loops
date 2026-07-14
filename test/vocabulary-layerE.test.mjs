// Layer E — empirical differencing widening (vocabulary plan §2/W1). measureAction
// gains three ADDITIVE profile fields, all differenced against the same
// prefix-baseline the existing channels use:
//   - consumes{res}: resource DECREASES (census 2.3 consumption invisibility),
//     separate from grants (which stays increases-only);
//   - crossTown{townIdx}: progress/discovery deltas in OTHER towns (census 2.3
//     exchangeMap / Build Tower / adjustRocks);
//   - persistentDelta widening: per-stat soulstones, trainingLimits, stonesUsed,
//     dungeon floor completions/ssChance drift, trial floors, multipart ledgers
//     (census 2.2b,d + class 6).
// Nothing at default weights reads these; the byte-gate proves inertness. These
// tests prove the fields COMPUTE and stay empty at town-0 (the additive property).

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
const j = (x) => JSON.parse(JSON.stringify(x));

// The real planner reads `state` from a restored/loaded context, where the
// game's persistent structures (dungeon/trial floor arrays) are already
// initialized. The raw harness only ran loadDefaults() (dungeons = [[],[],[]]),
// so read `state` AFTER a restore to match the live flow — otherwise pre (empty
// floors) vs post (floors init'd by the probe's own restore) shows a spurious
// ssChance drift that never occurs in real measurement.
function readAfterRestore(sess) {
    const snap = sess.save();
    sess.restore(snap);
    return { state: sess.read(), snap };
}

test("additive/inert: a town-0 probe leaves consumes empty, crossTown unset, pd empty", () => {
    const ctx = makePlanner(790);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    const { state, snap } = readAfterRestore(sess);
    const wander = state.actions.find(a => a.name === "Wander");
    const p = IP.measureAction(sess, snap, state, new Map(), wander);
    assert.ok(p.exec > 0, "Wander measured");
    assert.deepEqual(j(p.consumes), {}, "no consumption channel at town 0");
    assert.equal(p.crossTown, undefined, "no cross-town writes at town 0");
    assert.deepEqual(j(p.persistentDelta), {}, "no persistent deltas at town 0");
});

test("consumes: a herbs-consuming action records the decrease (Learn Alchemy)", () => {
    const ctx = makePlanner(791);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    sess.setQueue([["Wander", 1]]);
    sess.restart();
    // unlock town 1 + Learn Alchemy's gates (Hermit>=40 progress, Magic>=60),
    // and the Start-Journey route skill reqs so the town-1 prefix forms.
    ctx.ev("townsUnlocked = [0, 1]");
    const th = sess.probe();
    for (const r of th["Start Journey"]?.requires ?? [])
        ctx.ev(`skills[${JSON.stringify(r.v)}].levelExp.level = ${r.need}`);
    ctx.ev(`
        towns[1].expHermit = 100 * 40 * 41 / 2;   // Hermit level 40 (quadratic scaling)
        skills.Magic.levelExp.level = 60;
        adjustAll();
    `);
    const { state, snap } = readAfterRestore(sess);
    const la = state.actions.find(a => a.name === "Learn Alchemy");
    assert.ok(la && la.visible && la.unlocked, "Learn Alchemy usable");
    const p = IP.measureAction(sess, snap, state, new Map(), la, sess.needs("Learn Alchemy"), { baselineCache: new Map() });
    assert.ok(p.exec > 0, `Learn Alchemy executed (exec=${p.exec})`);
    assert.ok((p.consumes.herbs ?? 0) > 0, `herbs consumption recorded (${JSON.stringify(p.consumes)})`);
    assert.ok(Math.abs(p.consumes.herbs - 10) < 1e-6, `10 herbs/exec (${p.consumes.herbs})`);
    assert.equal(p.grants.herbs, undefined, "grants stays increases-only");
});

test("persistentDelta widening: per-stat soulstones + dungeon floors (cycle mode)", () => {
    const ctx = makePlanner(792);
    const sess = ctx.ev("new IdlePlanner.Session()");
    const IP = ctx.ev("IdlePlanner");
    sess.setQueue([["Wander", 1]]);
    sess.restart();
    // cycle mode makes the dungeon soulstone roll deterministic (no rollback
    // needed); unlock Small Dungeon (town 0: Combat+Magic >= 35) with cheap
    // combat so floors clear inside the probe's injected mana.
    ctx.ev(`
        options.rngMode = "cycle";
        skills.Combat.levelExp.level = 400;
        skills.Magic.levelExp.level = 400;
        adjustAll();
    `);
    const { state, snap } = readAfterRestore(sess);
    const sd = state.actions.find(a => a.name === "Small Dungeon");
    assert.ok(sd && sd.visible && sd.unlocked, "Small Dungeon unlocked");
    const p = IP.measureAction(sess, snap, state, new Map(), sd, sess.needs("Small Dungeon"));
    assert.ok(p.exec > 0, `Small Dungeon executed (exec=${p.exec})`);
    const pd = p.persistentDelta;
    assert.ok(pd.soulstonesPerStat && Object.keys(pd.soulstonesPerStat).length > 0,
        `per-stat soulstone deltas recorded (${JSON.stringify(pd.soulstonesPerStat)})`);
    assert.ok(pd.dungeons && pd.dungeons["0"], `dungeon-0 floor deltas recorded (${JSON.stringify(pd.dungeons)})`);
    // floor completions are strictly positive; ssChance drifts down on success
    const floor0 = pd.dungeons["0"]["0"];
    assert.ok(floor0.completed > 0, `floor 0 completions (${JSON.stringify(floor0)})`);
    // the roll fired ZERO Math.random (cycle mode) — the whole point
    assert.equal(ctx.rngCount(), 0, "cycle-mode dungeon probe drew no Math.random");
});
