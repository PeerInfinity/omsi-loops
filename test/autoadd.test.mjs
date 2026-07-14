// Auto-add reps (options.autoAddReps, §11.6 assist-tools ladder rung 2) —
// headless tests for the pure computation (Koviko.repTopUps /
// Koviko.applyRepTopUps). These pin the semantics the UI-thread apply and the
// loop-boundary auto-apply share; the DOM/apply path + optimiser chain are
// covered by ui-smoke. Detection reuses rung 1's repGapReport, so the pool /
// allowed()-cap semantics are pinned in repgap.test.mjs; here we assert the
// top-up (add-only) behaviour: under-queued entries reach `available`,
// over-queued / multipart / one-shot actions are left alone.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

// helper: build a queue in the vm, apply the top-ups, return the mutated
// [name, loops] pairs plus the applied rows, both as JSON out of the sandbox.
function topUp(ctx, queueLiteral) {
    return JSON.parse(ctx.ev(`(() => {
        const q = ${queueLiteral};
        const ups = Koviko.applyRepTopUps(q);
        return JSON.stringify({ q, ups });
    })()`));
}

test("under-queued entry is topped up to available in place", () => {
    const ctx = makeContext(5242);
    ctx.ev(`
        towns[0].totalPots = 20;
        towns[0].checkedPots = 5;
        towns[0].goodPots = 3;
        towns[0].goodTempPots = 3;
    `);
    // 18 available (3 banked + 15 unchecked), 10 queued -> +8 on the last entry
    const { q, ups } = topUp(ctx, `[
        { name: "Smash Pots", loops: 4 },
        { name: "Wander", loops: 2 },
        { name: "Smash Pots", loops: 6 },
    ]`);
    assert.deepEqual(ups, [
        { name: "Smash Pots", queued: 10, available: 18, gap: 8, lastIndex: 2 },
    ]);
    // the gap lands on the LAST enabled entry; total queued now == available
    assert.deepEqual(q, [
        { name: "Smash Pots", loops: 4 },
        { name: "Wander", loops: 2 },
        { name: "Smash Pots", loops: 14 },
    ]);
    assert.equal(q[0].loops + q[2].loops, 18);
});

test("allowed()-capped action tops up to the live cap (trainingLimits)", () => {
    const ctx = makeContext(5243);
    const { q, ups } = topUp(ctx, `[{ name: "Train Strength", loops: 4 }]`);
    assert.deepEqual(ups, [
        { name: "Train Strength", queued: 4, available: 10, gap: 6, lastIndex: 0 },
    ]);
    assert.deepEqual(q, [{ name: "Train Strength", loops: 10 }]);
});

test("over-queued entries are left alone (add-only)", () => {
    const ctx = makeContext(5244);
    ctx.ev(`
        towns[0].totalPots = 8;
        towns[0].checkedPots = 8;
        towns[0].goodPots = 2;
        towns[0].goodTempPots = 2;
    `);
    // 5 queued of 2 available -> gap -3; add-only leaves it untouched
    const { q, ups } = topUp(ctx, `[{ name: "Smash Pots", loops: 5 }]`);
    assert.deepEqual(ups, []);
    assert.deepEqual(q, [{ name: "Smash Pots", loops: 5 }]);
});

test("multipart / progress / one-shot actions are never topped up", () => {
    const ctx = makeContext(5245);
    // Wander (progress) and Heal The Sick (multipart) have no defined rep cap;
    // Start Journey (travel, allowed()===1) can never under-queue below 1.
    const { q, ups } = topUp(ctx, `[
        { name: "Wander", loops: 1 },
        { name: "Heal The Sick", loops: 1 },
        { name: "Start Journey", loops: 1 },
    ]`);
    assert.deepEqual(ups, []);
    assert.deepEqual(q, [
        { name: "Wander", loops: 1 },
        { name: "Heal The Sick", loops: 1 },
        { name: "Start Journey", loops: 1 },
    ]);
});

test("exactly-matched queue produces no top-up", () => {
    const ctx = makeContext(5246);
    ctx.ev(`
        towns[0].totalPots = 8;
        towns[0].checkedPots = 8;
        towns[0].goodPots = 2;
        towns[0].goodTempPots = 2;
    `);
    const { q, ups } = topUp(ctx, `[{ name: "Smash Pots", loops: 2 }]`);
    assert.deepEqual(ups, []);
    assert.deepEqual(q, [{ name: "Smash Pots", loops: 2 }]);
});

test("mixed queue: only the under-queued action is bumped", () => {
    const ctx = makeContext(5247);
    ctx.ev(`
        towns[0].totalPots = 20;
        towns[0].checkedPots = 5;
        towns[0].goodPots = 3;
        towns[0].goodTempPots = 3;
    `);
    // Smash Pots under-queued (10/18 -> +8); Train Strength over-queued
    // (15/10 -> left alone); Wander untouched.
    const { q, ups } = topUp(ctx, `[
        { name: "Smash Pots", loops: 10 },
        { name: "Train Strength", loops: 15 },
        { name: "Wander", loops: 3 },
    ]`);
    assert.deepEqual(ups, [
        { name: "Smash Pots", queued: 10, available: 18, gap: 8, lastIndex: 0 },
    ]);
    assert.deepEqual(q, [
        { name: "Smash Pots", loops: 18 },
        { name: "Train Strength", loops: 15 },
        { name: "Wander", loops: 3 },
    ]);
});
