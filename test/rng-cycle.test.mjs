// Deterministic RNG cycling (options.rngMode = "random" | "cycle";
// actionList.js §rngMode + vocabulary plan §6/W0). "random" is Math.random
// verbatim (byte-inert; the frozen planner reference is unaffected). "cycle"
// replaces the four reward-path RNG sites with an expectation-preserving
// deterministic sequence. These tests pin the two invariants that matter:
//   - error-diffusion ssRoll converges to the same expectation as a Bernoulli
//     draw (long-run rate == p, including sub-1/loop probabilities that a
//     per-loop-reset accumulator would silently zero out);
//   - round-robin picks sweep their list uniformly with independent cursors.
// An integration test drives the real dungeon reward site to prove cycle mode
// consumes ZERO Math.random and reproduces byte-for-byte, while random mode
// still draws from the seeded stream.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

test("rngMode defaults to random (byte-inert)", () => {
    const ctx = makeContext(1);
    assert.equal(ctx.ev("options.rngMode"), "random");
});

test("loadDefaults zeroes the cycle cursors", () => {
    const ctx = makeContext(1);
    ctx.ev("rngCycleState.ssAcc = 0.7; rngCycleState.zone = 5; loadDefaults()");
    assert.deepEqual(ctx.ev("JSON.stringify(rngCycleState)"),
        JSON.stringify({ ssAcc: 0, dungeonStat: 0, mineStat: 0, zone: 0 }));
});

test("error-diffusion ssRoll: fire count converges to Σp (constant p)", () => {
    const ctx = makeContext(1);
    // p = 0.3 over 1000 rolls -> exactly floor/ceil of 300, never off by more
    // than the single carried deficit (< 1).
    const fires = ctx.ev(`
        resetRngCycle();
        let f = 0;
        for (let i = 0; i < 1000; i++) if (cycleSsRoll(0.3)) f++;
        f;
    `);
    assert.ok(Math.abs(fires - 300) <= 1, `fires=${fires}, expected ~300`);
    // the residual is exactly the accumulator (deficit carried, < 1)
    assert.ok(ctx.ev("rngCycleState.ssAcc") < 1);
});

test("error-diffusion ssRoll: sub-1/loop probability still fires (no zeroing)", () => {
    // The reason the accumulator must CARRY across calls: a fresh-each-time
    // 0.05 probability would never reach 1 and fire zero soulstones forever.
    const ctx = makeContext(1);
    const fires = ctx.ev(`
        resetRngCycle();
        let f = 0;
        for (let i = 0; i < 400; i++) if (cycleSsRoll(0.05)) f++;
        f;
    `);
    assert.ok(Math.abs(fires - 20) <= 1, `fires=${fires}, expected ~20`);
});

test("error-diffusion ssRoll: converges under decaying p (the ssChance case)", () => {
    // Real dungeon floors decay ssChance *= 0.98 on each success; the running
    // fire total must still track the sum of the probabilities actually rolled.
    const ctx = makeContext(1);
    const { fires, sum } = JSON.parse(ctx.ev(`
        resetRngCycle();
        let p = 1, f = 0, s = 0;
        for (let i = 0; i < 500; i++) {
            s += p;
            if (cycleSsRoll(p)) { f++; p *= 0.98; }
        }
        JSON.stringify({ fires: f, sum: s });
    `));
    assert.ok(Math.abs(fires - sum) <= 1, `fires=${fires} vs Σp=${sum}`);
});

test("round-robin pick: uniform sweep over the list", () => {
    const ctx = makeContext(1);
    const counts = ctx.ev(`
        resetRngCycle();
        const list = ["A", "B", "C", "D", "E"];
        const c = {};
        for (let i = 0; i < 100; i++) { const x = cyclePick(list, "dungeonStat"); c[x] = (c[x] ?? 0) + 1; }
        JSON.stringify(c);
    `);
    const c = JSON.parse(counts);
    // 100 / 5 = exactly 20 each
    for (const k of ["A", "B", "C", "D", "E"]) assert.equal(c[k], 20, `${k}=${c[k]}`);
});

test("round-robin pick: independent cursors do not interleave", () => {
    const ctx = makeContext(1);
    const out = ctx.ev(`
        resetRngCycle();
        const list = ["x", "y", "z"];
        // advance dungeonStat twice, then mineStat once — mineStat starts at 0
        cyclePick(list, "dungeonStat"); cyclePick(list, "dungeonStat");
        const first = cyclePick(list, "mineStat");
        JSON.stringify({ first, dungeonStat: rngCycleState.dungeonStat, mineStat: rngCycleState.mineStat });
    `);
    assert.deepEqual(JSON.parse(out), { first: "x", dungeonStat: 2, mineStat: 1 });
});

test("round-robin pick: adapts to a shrinking list (exchangeMap zones)", () => {
    // exchangeMap splices finished zones out of the candidate list; the cursor
    // must keep sweeping whatever remains.
    const ctx = makeContext(1);
    const picks = ctx.ev(`
        resetRngCycle();
        const zones = [1, 3, 5];
        const seq = [];
        seq.push(cyclePick(zones, "zone"));  // 1
        seq.push(cyclePick(zones, "zone"));  // 3
        zones.splice(0, 1);                  // zone 1 fills -> [3, 5]
        seq.push(cyclePick(zones, "zone"));  // cursor=2 % 2 = 0 -> 3
        seq.push(cyclePick(zones, "zone"));  // cursor=3 % 2 = 1 -> 5
        JSON.stringify(seq);
    `);
    assert.deepEqual(JSON.parse(picks), [1, 3, 3, 5]);
});

test("cycle mode reproduces byte-for-byte and consumes ZERO Math.random", () => {
    const run = (mode) => {
        const ctx = makeContext(777);
        return {
            state: ctx.ev(`
                options.rngMode = ${JSON.stringify(mode)};
                resetRngCycle();
                // a fresh floor fires every roll at ssChance 1, decaying 0.98
                dungeons[0][0] = { ssChance: 1, completed: 0, lastStat: "NA" };
                for (const s of statList) stats[s].soulstone = 0;
                for (let i = 0; i < 30; i++) Action.SmallDungeon.finishDungeon(0);
                JSON.stringify(statList.map(s => stats[s].soulstone));
            `),
            rng: ctx.rngCount(),
        };
    };
    const a = run("cycle");
    const b = run("cycle");
    assert.equal(a.state, b.state, "cycle mode deterministic across contexts");
    assert.equal(a.rng, 0, "cycle mode draws no Math.random");
    // some soulstones actually accrued (round-robin spread across stats)
    const spread = JSON.parse(a.state);
    assert.ok(spread.reduce((s, v) => s + v, 0) > 0, "soulstones accrued");
    assert.ok(spread.filter(v => v > 0).length > 1, "spread across multiple stats");
    // random mode DOES consume the seeded stream (contrast)
    const r = run("random");
    assert.ok(r.rng > 0, "random mode draws Math.random");
});
