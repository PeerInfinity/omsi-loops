// Rep-gap report (options.predictorRepGap, §11.6 assist-tools ladder rung 1)
// — headless tests for the pure computation (Koviko.repGapAvailable /
// repGapReport). The DOM badge renderer is UI-thread-only and covered by
// eyeball/smoke, not here; these tests pin the semantics the badge shows.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

test("limited actions: available = banked good + unchecked", () => {
    const ctx = makeContext(4242);
    ctx.ev(`
        towns[0].totalPots = 20;
        towns[0].checkedPots = 5;
        towns[0].goodPots = 3;
        towns[0].goodTempPots = 3;
    `);
    assert.equal(ctx.ev(`Koviko.repGapAvailable("Smash Pots")`), 18);
});

test("report sums split queue entries and skips disabled/zero-rep ones", () => {
    const ctx = makeContext(4243);
    ctx.ev(`
        towns[0].totalPots = 20;
        towns[0].checkedPots = 5;
        towns[0].goodPots = 3;
        towns[0].goodTempPots = 3;
    `);
    const report = ctx.ev(`JSON.stringify(Koviko.repGapReport([
        { name: "Smash Pots", loops: 4 },
        { name: "Wander", loops: 2 },
        { name: "Smash Pots", loops: 6, disabled: true },
        { name: "Smash Pots", loops: 0 },
        { name: "Smash Pots", loops: 6 },
    ]))`);
    // 4 + 6 queued (disabled + zero-rep ignored) of 18 available -> gap 8,
    // badge on the LAST enabled entry (index 4). Wander (progress) has no
    // defined rep cap and must not appear.
    assert.deepEqual(JSON.parse(report), [
        { name: "Smash Pots", queued: 10, available: 18, gap: 8, lastIndex: 4 },
    ]);
});

test("no report when queued reps cover the pool", () => {
    const ctx = makeContext(4244);
    ctx.ev(`
        towns[0].totalPots = 8;
        towns[0].checkedPots = 8;
        towns[0].goodPots = 2;
        towns[0].goodTempPots = 2;
    `);
    const report = ctx.ev(`JSON.stringify(Koviko.repGapReport([
        { name: "Smash Pots", loops: 2 },
    ]))`);
    assert.deepEqual(JSON.parse(report), []);
});

test("allowed()-capped actions use the live cap (trainingLimits)", () => {
    const ctx = makeContext(4245);
    assert.equal(ctx.ev(`Koviko.repGapAvailable("Train Strength")`), 10);
    const report = ctx.ev(`JSON.stringify(Koviko.repGapReport([
        { name: "Train Strength", loops: 4 },
    ]))`);
    assert.deepEqual(JSON.parse(report), [
        { name: "Train Strength", queued: 4, available: 10, gap: 6, lastIndex: 0 },
    ]);
    // cap growth (Imbue Mind raises trainingLimits) is reflected live
    ctx.ev("trainingLimits = 12");
    assert.equal(ctx.ev(`Koviko.repGapAvailable("Train Strength")`), 12);
});

test("progress/multipart actions have no defined rep gap", () => {
    const ctx = makeContext(4246);
    for (const name of ["Wander", "Heal The Sick"]) {
        assert.equal(ctx.ev(`Koviko.repGapAvailable(${JSON.stringify(name)})`), null, name);
    }
});

test("allowed()=1 one-shots (travel etc.) can never report a gap", () => {
    const ctx = makeContext(4247);
    // travel actions carry allowed() === 1 — "available" is 1, and any
    // queued entry has loops >= 1, so no badge is ever produced
    assert.equal(ctx.ev(`Koviko.repGapAvailable("Start Journey")`), 1);
    const report = ctx.ev(`JSON.stringify(Koviko.repGapReport([
        { name: "Start Journey", loops: 1 },
    ]))`);
    assert.deepEqual(JSON.parse(report), []);
});
