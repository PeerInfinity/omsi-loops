// P2 automation transport (cross-game P2-A slice 1): the worldConfig payload
// that carries the award schedule + priority prefs into a sim context, and the
// restore-path invalidation that keeps back-to-back evals from inheriting each
// other's walk cursors. Strata:
//   1. serialization — getLootPrefs round-trips Sets as arrays;
//   2. buildWorldConfig — null exactly when no schedule is installed (prefs
//      alone are meaningless: the walk only runs under handlesLoot);
//   3. installWorldConfig — install, replace, clear-on-null, reject-whole on a
//      bad schedule, and the managed-mode option flip;
//   4. inertness — a null config against a clean context touches NOTHING (the
//      default path in every worker must stay byte-inert);
//   5. restore invalidation — plRestoreSave rewinds the per-loop carrier state
//      exactly as a loop restart does.
//
// Like award-carrier/loot-schedule, this is a dedicated gate: the effect
// differential is blind to schedules by design (no JS arm).
import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";
import { WIRED_FILES, WIRED_PREP } from "./field-matrix.lib.mjs";

const SCHEDULE = {
    version: 1,
    awards: { BuyManaZ1: { mana: [{ name: "reputation", count: 7 }] } },
    lootables: {
        Pots: {
            contents: [
                null,                                         // k0 vanilla
                { name: "gold", count: 5 },                   // k1 local re-route
                { dummy: true },                              // k2 dummy
                { substrate: "jta", type: "Food", count: 1 }, // k3 foreign
            ],
        },
    },
};

const PREFS = { Pots: { order: ["dummy", "vanilla"], disabled: ["local:gold"] } };

function wiredCtx() {
    const ctx = makeContext(12345, WIRED_FILES);
    ctx.ev(WIRED_PREP);
    ctx.setQueue([["Wander", 1]]);   // restart() pauses (DOM) on an empty queue
    return ctx;
}

const install = (ctx, cfg) =>
    ctx.ev(`ActionListXml.installWorldConfig(${JSON.stringify(cfg)})`);
const prefs = (ctx) =>
    JSON.parse(ctx.ev("JSON.stringify(ActionListXml.getLootPrefs())"));
const worldConfig = (ctx) =>
    JSON.parse(ctx.ev("JSON.stringify(ActionListXml.buildWorldConfig() ?? null)"));

test("getLootPrefs serializes the disabled Set as an array", () => {
    const ctx = wiredCtx();
    assert.deepEqual(prefs(ctx), {}, "no prefs before any setLootPriority");
    ctx.ev(`ActionListXml.setLootPriority("Pots", ["dummy", "vanilla"], ["local:gold"])`);
    assert.deepEqual(prefs(ctx), PREFS);
    // the getter must hand out copies, not the live structures
    ctx.ev(`ActionListXml.getLootPrefs().Pots.order.push("bogus")`);
    assert.deepEqual(prefs(ctx).Pots.order, ["dummy", "vanilla"]);
});

test("buildWorldConfig is null exactly when no schedule is installed", () => {
    const ctx = wiredCtx();
    assert.equal(worldConfig(ctx), null, "clean context");
    // prefs WITHOUT a schedule stay meaningless — still null
    ctx.ev(`ActionListXml.setLootPriority("Pots", ["dummy"], [])`);
    assert.equal(worldConfig(ctx), null, "prefs alone do not make a world");
    assert.equal(install(ctx, { awardSchedule: SCHEDULE, lootPrefs: PREFS }), true);
    const cfg = worldConfig(ctx);
    assert.deepEqual(cfg.awardSchedule, SCHEDULE);
    assert.deepEqual(cfg.lootPrefs, PREFS);
});

test("installWorldConfig round-trips through a second context", () => {
    const src = wiredCtx();
    assert.equal(install(src, { awardSchedule: SCHEDULE, lootPrefs: PREFS }), true);
    const payload = worldConfig(src);

    const dst = wiredCtx();
    assert.equal(install(dst, payload), true);
    assert.deepEqual(worldConfig(dst), payload, "transport is a fixed point");
    assert.equal(dst.ev(`ActionListXml.handlesLoot("Pots")`), true);
    assert.deepEqual(prefs(dst), PREFS);
});

test("installWorldConfig replaces prefs wholesale (no stale category order)", () => {
    const ctx = wiredCtx();
    assert.equal(install(ctx, { awardSchedule: SCHEDULE, lootPrefs: PREFS }), true);
    assert.equal(install(ctx, { awardSchedule: SCHEDULE, lootPrefs: {} }), true);
    assert.deepEqual(prefs(ctx), {}, "the second config's prefs are authoritative");
});

test("installWorldConfig(null) clears an installed world", () => {
    const ctx = wiredCtx();
    assert.equal(install(ctx, { awardSchedule: SCHEDULE, lootPrefs: PREFS }), true);
    assert.equal(install(ctx, null), true);
    assert.equal(ctx.ev("ActionListXml.getAwardSchedule()"), null);
    assert.deepEqual(prefs(ctx), {}, "prefs clear with the schedule");
    assert.equal(ctx.ev(`ActionListXml.handlesLoot("Pots")`), false);
    // a config whose awardSchedule is null is the same clear
    assert.equal(install(ctx, { awardSchedule: null, lootPrefs: PREFS }), true);
    assert.deepEqual(prefs(ctx), {});
});

test("installWorldConfig rejects a bad schedule whole and stays inert", () => {
    const ctx = wiredCtx();
    const bad = { awards: { BuyManaZ1: { mana: [{ name: "glasses", count: 1 }] } } };
    assert.equal(install(ctx, { awardSchedule: bad, lootPrefs: PREFS }), false);
    assert.equal(ctx.ev("ActionListXml.getAwardSchedule()"), null, "no half-apply");
    assert.deepEqual(prefs(ctx), {}, "prefs do not survive a rejected schedule");
});

test("inertness: a null config against a clean context touches nothing", () => {
    // the default path in every worker — no schedule ever installed. This must
    // not flip useActionListXml or apply overrides, or the whole transport
    // stops being byte-inert.
    const ctx = makeContext(12345, WIRED_FILES);   // deliberately NO WIRED_PREP
    ctx.setQueue([["Wander", 1]]);
    assert.equal(ctx.ev("options.useActionListXml"), false, "test premise");
    assert.equal(install(ctx, null), true);
    assert.equal(ctx.ev("options.useActionListXml"), false, "option untouched");
    assert.equal(ctx.ev("ActionListXml.getAwardSchedule()"), null);
    // the anti-vacuous half: a REAL config does flip it (managed-mode mirror)
    assert.equal(install(ctx, { awardSchedule: SCHEDULE, lootPrefs: {} }), true);
    assert.equal(ctx.ev("options.useActionListXml"), true, "install flips the option");
});

test("restore invalidates the per-loop carrier state (plRestoreSave)", () => {
    const ctx = makeContext(12345, [...WIRED_FILES, "planner-metadata.js", "planner.js"]);
    ctx.ev(WIRED_PREP);
    ctx.setQueue([["Wander", 1]]);
    assert.equal(install(ctx, { awardSchedule: SCHEDULE, lootPrefs: {} }), true);

    const walked = () => JSON.parse(ctx.ev("JSON.stringify(ActionListXml.getLootView('Pots'))"))
        .reduce((n, r) => n + (r.discovered - r.remaining), 0);

    // mint four goods (the check branch), then open a fresh loop's walk over
    // them — the walk state caches per loop, so the ledger edit needs the same
    // invalidation a restart gives it
    ctx.ev("towns[0].totalPots = 500");
    for (let i = 0; i < 4 * 10; i++) ctx.ev("Action.SmashPots.finish()");
    assert.equal(ctx.ev("towns[0].goodPots"), 4, "four goods discovered");
    ctx.ev("towns[0].goodTempPots = 4");
    ctx.ev("ActionListXml.onLoopRestart()");
    assert.equal(walked(), 0, "fresh walk");
    ctx.ev("Action.SmashPots.finish()");
    ctx.ev("Action.SmashPots.finish()");
    assert.equal(walked(), 2, "two goods consumed this loop");

    // the grant counter advances too: entry #1 re-routes BuyManaZ1's mana
    // grant to reputation (a resource the action does not itself zero)
    ctx.ev("resources.gold = 3");
    const mana0 = ctx.ev("timeNeeded");
    ctx.ev("Action.BuyManaZ1.finish()");
    assert.equal(ctx.ev("resources.reputation"), 7, "grant #1 re-routed");
    assert.equal(ctx.ev("timeNeeded"), mana0, "the vanilla mana grant did not fire");

    // restore the snapshot taken from THIS state. The ledger comes back with
    // goodTemp == good (restore opens a fresh loop's walk), so a stale cursor
    // would show up as already-consumed goods.
    const snap = ctx.ev("JSON.stringify(doSave())");
    ctx.sandbox.__snap = snap;
    ctx.ev("IdlePlanner._internals.plRestoreSave(__snap)");
    assert.equal(walked(), 0, "restore rewinds the walk cursors");

    // and the award counter re-indexes from the schedule's first entry
    ctx.ev("resources.gold = 3; resources.reputation = 0");
    ctx.ev("Action.BuyManaZ1.finish()");
    assert.equal(ctx.ev("resources.reputation"), 7,
        "re-routed grant #1 fires again after restore");
});

test("restore is inert with no schedule installed", () => {
    const ctx = makeContext(12345, [...WIRED_FILES, "planner-metadata.js", "planner.js"]);
    ctx.setQueue([["Wander", 1]]);
    ctx.ev("towns[0].totalPots = 500");
    for (let i = 0; i < 25; i++) ctx.ev("Action.SmashPots.finish()");
    // restore is a FIXED POINT, not an identity: it re-derives goodTemp from
    // good and lets adjustAll() recompute the limited-action totals. So the
    // invariant to assert is that a second restore of the restored state
    // changes nothing — the property back-to-back evals depend on.
    ctx.sandbox.__snap = ctx.ev("JSON.stringify(doSave())");
    ctx.ev("IdlePlanner._internals.plRestoreSave(__snap)");
    const before = ctx.snapshot();
    ctx.sandbox.__snap2 = ctx.ev("JSON.stringify(doSave())");
    ctx.ev("IdlePlanner._internals.plRestoreSave(__snap2)");
    assert.equal(ctx.snapshot(), before, "restore is a fixed point");
    assert.equal(ctx.ev("ActionListXml.getAwardSchedule()"), null);
});
