// expGainMultiplier tests — the fork's testing gain multiplier must be
// byte-inert at its default (1) and must multiply EXACTLY the three exp
// funnels (Town.finishProgress / addSkillExp / addExp) at other values.
// Resources are deliberately NOT multiplied (the economy stays real — the
// town-2 economic wall must remain visible in boosted runs).
//
// The identity golden below was captured on the tree IMMEDIATELY BEFORE the
// multiplier landed (automation @ c97c50b): same scripted run, same hash.
// If this hash moves, the option is not byte-inert at default — that breaks
// the acceptance gate (Part A §11.9 re-froze it 2026-07-13 to
// 535 / 5,965,890 / e23f020400162f9a; was 500 / 5,432,753 / 54506b48ec1758af).
// This identity golden is the multiplier's OWN scripted-run hash, independent
// of that acceptance reference, so it is unaffected by the re-freeze.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

// Pre-change golden: seed 777, [Smash Pots x6, Wander x3], 2000 capped steps.
const IDENTITY = { spent: 2000, loops: 8, hash: "bfdd611dc1f3c10b", rng: 0 };

function play(seed, steps, gainMult = null) {
    const ctx = makeContext(seed);
    if (gainMult !== null) ctx.ev(`options.expGainMultiplier = ${gainMult}`);
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

test("default (unset) reproduces the pre-change golden byte-exactly", () => {
    const r = play(777, 2000);
    assert.deepEqual(r, IDENTITY);
});

test("explicit 1 is identical to unset", () => {
    const r = play(777, 2000, 1);
    assert.deepEqual(r, IDENTITY);
});

test("choke points multiply exactly: addSkillExp / addExp / finishProgress", () => {
    const at = (mult) => {
        const ctx = makeContext(1);
        ctx.ev(`options.expGainMultiplier = ${mult}`);
        ctx.ev(`addSkillExp("Magic", 100)`);
        ctx.ev(`addExp("Dex", 100)`);
        ctx.ev(`towns[0].finishProgress("Met", 100)`);
        return {
            skill: ctx.ev(`skills.Magic.levelExp.totalExp`),
            stat: ctx.ev(`stats.Dex.statLevelExp.totalExp`),
            talent: ctx.ev(`totalTalent`),
            town: ctx.ev(`towns[0].expMet`),
        };
    };
    const x1 = at(1), x10 = at(10);
    for (const k of ["skill", "stat", "talent", "town"]) {
        assert.ok(x1[k] > 0, `${k} must accrue at 1x (got ${x1[k]})`);
        assert.equal(x10[k], x1[k] * 10, `${k}: 10x must be exactly tenfold`);
    }
});

test("10x engine loop: town exp is tenfold, resource yields are untouched", () => {
    const runLoop = (mult) => {
        const ctx = makeContext(42);
        ctx.ev(`options.expGainMultiplier = ${mult}`);
        ctx.setQueue([["Wander", 3], ["Smash Pots", 5]]);
        ctx.restart();
        ctx.ev(`addMana(5000)`);   // enough that the queue completes fully
        for (let i = 0; i < 100_000; i++) if (ctx.step(0).ended) break;
        return {
            execs: ctx.ev(`JSON.stringify(actions.current.map(a => a.loops - a.loopsLeft))`),
            expWander: ctx.ev(`towns[0].expWander`),
            gold: ctx.ev(`resources.gold`),
            rep: ctx.ev(`resources.reputation`),
        };
    };
    const a = runLoop(1), b = runLoop(10);
    assert.equal(a.execs, b.execs, "same queue must complete the same execs");
    assert.ok(a.expWander > 0, "Wander must have finished at least once");
    assert.equal(b.expWander, a.expWander * 10, "town progress exp must be exactly tenfold");
    assert.equal(b.gold, a.gold, "gold must NOT be multiplied");
    assert.equal(b.rep, a.rep, "reputation must NOT be multiplied");
});
