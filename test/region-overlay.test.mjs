// Region overlay + synthetic exit actions (fork addition, arc C).
//
// The region mechanism is managed-mode-only and off the vanilla path (the
// byte-exact replay gate never enters managed mode, so it can't witness any
// of this). These headless checks pin the pure engine behaviour — per-region
// state dump/load, the explore-% exit gate at its threshold boundaries, and
// that a synthetic exit action is resolvable by name yet stays OUT of the
// action census. The real managed round-trip is the omsi-region in-app leg.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

// A limited var and a progress var that both exist in town 0.
const LIMITED = "Pots";      // Smash Pots
const PROGRESS = "Wander";   // Wander
const EXP_CAP = 505000;      // level 100, both scalings

test("region state dump/load round-trips the per-region value props", () => {
    const ctx = makeContext(12345, ["managed.js"]);
    const ev = ctx.ev;

    // Seed the active region's counters + progress, then dump.
    ev(`towns[0].exp${PROGRESS} = 60000`);        // some Wander progress
    ev(`towns[0].checked${LIMITED} = 4`);
    ev(`towns[0].good${LIMITED} = 2`);
    ev(`towns[0].goodTemp${LIMITED} = 1`);
    ev(`towns[0].lootFrom${LIMITED} = 3`);
    const rA = JSON.parse(ev("JSON.stringify(IdleLoopsManaged.dumpRegionState(0))"));
    assert.equal(rA[`exp${PROGRESS}`], 60000);
    assert.equal(rA[`checked${LIMITED}`], 4);

    // Enter a FRESH region (null snapshot): every minted var zeroes; adjustAll
    // re-derives totals from the zeroed levels.
    ev("IdleLoopsManaged.loadRegionState(0, null)");
    assert.equal(ev(`towns[0].exp${PROGRESS}`), 0, "fresh region resets progress");
    assert.equal(ev(`towns[0].checked${LIMITED}`), 0, "fresh region resets counters");
    assert.equal(ev(`towns[0].good${LIMITED}`), 0);

    // Return to region A: its state is restored intact.
    ev(`IdleLoopsManaged.loadRegionState(0, ${JSON.stringify(rA)})`);
    assert.equal(ev(`towns[0].exp${PROGRESS}`), 60000, "returning restores progress");
    assert.equal(ev(`towns[0].checked${LIMITED}`), 4, "returning restores checked");
    assert.equal(ev(`towns[0].good${LIMITED}`), 2);
    assert.equal(ev(`towns[0].goodTemp${LIMITED}`), 1);
    assert.equal(ev(`towns[0].lootFrom${LIMITED}`), 3);

    // The snapshot keys are derived from the town's var lists, not hardcoded.
    assert.ok(Object.keys(rA).includes(`exp${PROGRESS}`));
    assert.ok(Object.keys(rA).includes(`total${LIMITED}`));
});

test("the exit gate opens at the configured explore threshold", () => {
    const ctx = makeContext(12345, ["managed.js"]);
    const ev = ctx.ev;

    // No active region == no gate.
    assert.equal(ev("IdleLoopsManaged.regionExitAvailable()"), true);

    ev(`IdleLoopsManaged.setActiveRegion({ townIndex: 0, exploreVar: ${JSON.stringify(PROGRESS)}, exploreThreshold: 0.5 })`);
    ev(`towns[0].exp${PROGRESS} = 0`);
    assert.equal(ev("IdleLoopsManaged.regionExitAvailable()"), false, "0% explored -> closed");

    ev(`towns[0].exp${PROGRESS} = ${Math.floor(EXP_CAP * 0.5) - 1}`);
    assert.equal(ev("IdleLoopsManaged.regionExitAvailable()"), false, "just below threshold -> closed");

    ev(`towns[0].exp${PROGRESS} = ${Math.ceil(EXP_CAP * 0.5)}`);
    assert.equal(ev("IdleLoopsManaged.regionExitAvailable()"), true, "at threshold -> open");

    // Default threshold is 1.0 (100% explored).
    ev(`IdleLoopsManaged.setActiveRegion({ townIndex: 0, exploreVar: ${JSON.stringify(PROGRESS)} })`);
    ev(`towns[0].exp${PROGRESS} = ${EXP_CAP - 1}`);
    assert.equal(ev("IdleLoopsManaged.regionExitAvailable()"), false, "default 1.0 needs full cap");
    ev(`towns[0].exp${PROGRESS} = ${EXP_CAP}`);
    assert.equal(ev("IdleLoopsManaged.regionExitAvailable()"), true);

    // Clearing the region removes the gate.
    ev("IdleLoopsManaged.setActiveRegion(null)");
    assert.equal(ev("IdleLoopsManaged.regionExitAvailable()"), true);
});

test("synthetic exit actions are queueable by name but stay out of the census", () => {
    const ctx = makeContext(12345, ["managed.js"]);
    const ev = ctx.ev;

    const NAME = "Go East (to town0:r1)";
    const nBefore = ev("totalActionList.length");

    // Gate the exit at 50% so canStart tracks the explore state.
    ev(`IdleLoopsManaged.setActiveRegion({ townIndex: 0, exploreVar: ${JSON.stringify(PROGRESS)}, exploreThreshold: 0.5 })`);
    ev("globalThis.__moved = 0");
    const res = JSON.parse(ev(`JSON.stringify(IdleLoopsManaged.injectSyntheticAction(${JSON.stringify({ name: NAME, townNum: 0 })}, () => { globalThis.__moved++; }))`));
    assert.equal(res.ok, true);

    // Resolvable through the queue's name lookup...
    assert.equal(ev(`getActionPrototype(${JSON.stringify(NAME)}) instanceof Action`), true);
    assert.equal(ev(`getActionPrototype(${JSON.stringify(NAME)}).townNum`), 0);

    // ...but NOT in the enumeration the census / DOM / planner read.
    assert.equal(ev("totalActionList.length"), nBefore, "totalActionList unchanged");
    assert.equal(ev(`totalActionList.some(a => a.name === ${JSON.stringify(NAME)})`), false);
    assert.equal(ev(`towns[0].totalActionList.some(a => a.name === ${JSON.stringify(NAME)})`), false);

    // canStart mirrors the exit gate.
    ev(`towns[0].exp${PROGRESS} = 0`);
    assert.equal(ev(`getActionPrototype(${JSON.stringify(NAME)}).canStart()`), false, "closed gate -> not runnable");
    ev(`towns[0].exp${PROGRESS} = ${EXP_CAP}`);
    assert.equal(ev(`getActionPrototype(${JSON.stringify(NAME)}).canStart()`), true, "open gate -> runnable");

    // finish() fires the host callback (the region-move dispatch).
    ev(`getActionPrototype(${JSON.stringify(NAME)}).finish()`);
    assert.equal(ev("globalThis.__moved"), 1, "finish dispatches the move once");

    // Collision is refused (idempotence guard).
    const dup = JSON.parse(ev(`JSON.stringify(IdleLoopsManaged.injectSyntheticAction(${JSON.stringify({ name: NAME, townNum: 0 })}, () => {}))`));
    assert.equal(dup.ok, false);

    // Clearing removes it from the registry entirely.
    ev("IdleLoopsManaged.clearSyntheticActions()");
    assert.equal(ev(`getActionPrototype(${JSON.stringify(NAME)}) === undefined`), true, "cleared -> unresolvable");
    assert.equal(ev("totalActionList.length"), nBefore);
});

test("setActiveRegion clears the previous region's synthetic actions", () => {
    const ctx = makeContext(12345, ["managed.js"]);
    const ev = ctx.ev;

    const A = "Go East (to r1)";
    ev(`IdleLoopsManaged.setActiveRegion({ townIndex: 0, exploreVar: ${JSON.stringify(PROGRESS)} })`);
    ev(`IdleLoopsManaged.injectSyntheticAction(${JSON.stringify({ name: A, townNum: 0 })}, () => {})`);
    assert.equal(ev(`getActionPrototype(${JSON.stringify(A)}) instanceof Action`), true);

    // Moving to another region clears the old exits before the host re-injects.
    ev(`IdleLoopsManaged.setActiveRegion({ townIndex: 0, exploreVar: ${JSON.stringify(PROGRESS)} })`);
    assert.equal(ev(`getActionPrototype(${JSON.stringify(A)}) === undefined`), true);
});
