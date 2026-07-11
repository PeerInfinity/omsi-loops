// Managed-mode hook surface (substrate plan §4, slice 1).
//
// managed.js is page-only (never in a worker's importScripts), but its hook
// functions are pure engine calls, so they are exercised here against the
// real headless sim. What this file CANNOT see — the ?managed=1 boot gate,
// the recalcInterval clock gate, the dedicated save slot — is browser
// behavior; verify with the Playwright smoke (see managed.js header) and
// the omsi-parity UI harness.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

test("managed hook surface drives the sim headlessly", () => {
    const ctx = makeContext(12345, ["managed.js"]);
    const ev = ctx.ev;

    // inert outside ?managed=1 (no window in this context)
    assert.equal(ev("IdleLoopsManaged.active"), false);

    // state readout at the loadDefaults baseline
    const s0 = JSON.parse(ev("JSON.stringify(IdleLoopsManaged.getFullState())"));
    assert.equal(typeof s0.timer, "number");
    assert.equal(s0.timeNeeded - s0.timer, s0.manaLeft);
    assert.deepEqual(s0.townsUnlocked, [0]);
    assert.equal(s0.skills.Combat.level, 0);
    assert.equal(s0.townLevels[0].Wander, 0);
    assert.equal(s0.loops, 0);

    // host-driven loop reset + callback (queue first: restart() on an empty
    // queue reaches pauseGame(), which touches a DOM node this harness
    // stubs as null — browser-only surface, fine in a real managed page)
    ctx.setQueue([["Wander", 3]]);
    ev("globalThis.__restarts = 0; IdleLoopsManaged.onRestart(() => { globalThis.__restarts++; })");
    ev("IdleLoopsManaged.restartLoop()");
    assert.equal(ev("globalThis.__restarts"), 1);

    // host mana sync extends the loop budget
    const before = JSON.parse(ev("JSON.stringify(IdleLoopsManaged.getFullState())"));
    ev("IdleLoopsManaged.addMana(500)");
    const after = JSON.parse(ev("JSON.stringify(IdleLoopsManaged.getFullState())"));
    assert.equal(after.timeNeeded, before.timeNeeded + 500);
    assert.equal(after.manaLeft, before.manaLeft + 500);

    // stepping advances the engine (host owns time); 600 ticks inside the
    // 750 budget = two Wander completions (manaCost 250, exp on completion)
    ev("IdleLoopsManaged.step(600)");
    const s1 = JSON.parse(ev("JSON.stringify(IdleLoopsManaged.getFullState())"));
    assert.equal(s1.timer, before.timer + 600);
    assert.ok(ev("towns[0].expWander") > 0, "Wander gained progress from stepped ticks");
});
