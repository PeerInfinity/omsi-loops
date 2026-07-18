// test/view-subscribe.test.mjs — the view-subscribe seam.
//
// Three guarantees:
//   1. actionList.js names no view categories (the arc's success criterion)
//   2. every subscription entry names a real category and resolves its target
//   3. emitting a semantic fact produces the expected render requests
//
// See NewDocs/plans/omsiloops/omsi-loops-view-subscribe-plan.md for the design.

import test from "node:test";
import assert from "node:assert/strict";
import { makeViewContext, actionListSourceWithoutComments } from "./view-subscribe.lib.mjs";

//====================================================================================================
// 1. actionList.js contains zero view category names
//====================================================================================================

// EMPTY, and it stays empty. actionList.js declares semantic facts via
// stateChanged() and names no view categories at all — that is the arc's
// success criterion, and this test is what keeps it true. If you are here
// because a new site failed the check: emit a stateChanged kind and add a
// STATE_SUBSCRIPTIONS entry, don't reach for view.requestUpdate.
const REMAINING_CATEGORIES = new Set([]);
const REMAINING_DIRECT_CALLS = new Set([]);

test("actionList.js names no view request categories", () => {
    const src = actionListSourceWithoutComments();
    const found = new Set();
    for (const m of src.matchAll(/view\.requestUpdate\(\s*["']([^"']+)["']/g)) found.add(m[1]);

    const unexpected = [...found].filter(c => !REMAINING_CATEGORIES.has(c));
    assert.deepEqual(unexpected, [],
        `actionList.js must declare semantic facts via stateChanged(), not view categories`);

    // The allowlist may not rot: anything listed must actually still be there.
    const stale = [...REMAINING_CATEGORIES].filter(c => !found.has(c));
    assert.deepEqual(stale, [], "REMAINING_CATEGORIES lists categories already migrated — shrink it");
});

test("actionList.js makes no direct view method calls", () => {
    const src = actionListSourceWithoutComments();
    const found = new Set();
    for (const m of src.matchAll(/view\.(?!requestUpdate\b)([A-Za-z_$][\w$]*)\s*\(/g)) found.add(m[1]);

    const unexpected = [...found].filter(c => !REMAINING_DIRECT_CALLS.has(c));
    assert.deepEqual(unexpected, [], "actionList.js must not call view methods directly");

    const stale = [...REMAINING_DIRECT_CALLS].filter(c => !found.has(c));
    assert.deepEqual(stale, [], "REMAINING_DIRECT_CALLS lists calls already migrated — shrink it");
});

test("stateChanged emissions in actionList.js are well-formed", () => {
    const src = actionListSourceWithoutComments();
    const kinds = new Set();
    for (const m of src.matchAll(/\bstateChanged\(\s*["']([^"']+)["']/g)) kinds.add(m[1]);
    // Every emission must be a bare kind name, never a view category.
    const ctx = makeViewContext();
    const categories = new Set(Object.keys(ctx.requests()));
    for (const kind of kinds) {
        assert.ok(!categories.has(kind), `stateChanged kind "${kind}" collides with a view category name`);
    }
});

//====================================================================================================
// 2. Subscription table validity
//====================================================================================================

test("every subscription entry names a real request category", () => {
    const ctx = makeViewContext();
    const report = JSON.parse(ctx.ev(`JSON.stringify(
        Object.entries(STATE_SUBSCRIPTIONS).flatMap(([key, entries]) =>
            entries.map((e, i) => ({
                key, i,
                sweep: typeof e.sweep === "function",
                category: e.category ?? null,
                knownCategory: e.category ? (e.category in testView.requests) : false,
                isMethod: e.category ? typeof testView[e.category] === "function" : false,
            }))))`));

    assert.ok(report.length > 0, "table must not be empty");
    for (const entry of report) {
        const where = `${entry.key}[${entry.i}]`;
        if (entry.sweep) continue;
        assert.ok(entry.category, `${where}: entry has neither category nor sweep`);
        assert.ok(entry.knownCategory, `${where}: "${entry.category}" is not in the requests table`);
        assert.ok(entry.isMethod, `${where}: "${entry.category}" is not a View method`);
    }
});

test("every subscription target resolves", () => {
    const ctx = makeViewContext();
    const failures = JSON.parse(ctx.ev(`JSON.stringify(
        Object.entries(STATE_SUBSCRIPTIONS).flatMap(([key, entries]) =>
            entries.flatMap((e, i) => {
                if (e.sweep || typeof e.target === "function" || e.target === null || e.target === undefined) return [];
                const where = key + "[" + i + "]";
                if (e.category === "adjustManaCost" || e.category === "adjustExpMult") {
                    const action = translateClassNames(e.target);
                    return action && action.varName ? [] : [where + ": no action named " + e.target];
                }
                if (e.category === "adjustGoldCost") {
                    const action = getActionWithGoldCost(e.target);
                    return action ? [] : [where + ": no gold-cost action with varName " + e.target];
                }
                return [];
            })))`));
    assert.deepEqual(failures, []);
});

test("every subscription action key resolves to an Action singleton", () => {
    const ctx = makeViewContext();
    const failures = JSON.parse(ctx.ev(`JSON.stringify(
        Object.entries(STATE_SUBSCRIPTIONS).flatMap(([key, entries]) =>
            entries.flatMap((e, i) => e.action === undefined ? []
                : (Action[e.action] && Action[e.action].varName)
                    ? [] : [key + "[" + i + "]: no Action." + e.action])))`));
    assert.deepEqual(failures, []);
});

test("adjustExpGain targets keep object identity so the queue can dedupe", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("skill", { name: "Thievery", oldLevel: 1, newLevel: 2 });
    ctx.emit("skill", { name: "Thievery", oldLevel: 2, newLevel: 3 });
    assert.equal(ctx.ev("testView.requests.adjustExpGain.length"), 1,
        "the same Action singleton must collapse to one request");
    assert.equal(ctx.ev("testView.requests.adjustExpGain[0] === Action.ThievesGuild"), true);
});

test("subscription keys are well-formed kind:name pairs", () => {
    const ctx = makeViewContext();
    const keys = JSON.parse(ctx.ev("JSON.stringify(Object.keys(STATE_SUBSCRIPTIONS))"));
    for (const key of keys) {
        assert.match(key, /^[a-zA-Z]+:([A-Za-z0-9_]+|\*)$/, `malformed subscription key: ${key}`);
    }
});

//====================================================================================================
// 3. Sink smoke — emissions produce the expected requests
//====================================================================================================

test("the sink is null until a real View claims it", () => {
    const ctx = makeViewContext();
    // testView already claimed it; prove the seam is otherwise inert by clearing.
    ctx.ev("stateChangedSink = null");
    ctx.clearRequests();
    ctx.emit("skill", { name: "Practical", oldLevel: 1, newLevel: 2 });
    assert.deepEqual(ctx.pendingRequests(), {}, "emissions must be no-ops with no sink registered");
});

test("skill emission drives the subscribed cost displays", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("skill", { name: "Practical", oldLevel: 1, newLevel: 1 });
    assert.deepEqual(ctx.pendingRequests(), {
        adjustManaCost: ["Wild Mana", "Smash Pots"],
        adjustGoldCosts: [null],
    });
});

test("onLevelChange entries fire only on an actual level change", () => {
    const ctx = makeViewContext();

    ctx.clearRequests();
    ctx.emit("skill", { name: "Spatiomancy", oldLevel: 3, newLevel: 3 });
    assert.deepEqual(ctx.pendingRequests(), {}, "no level change ⇒ no requests");

    ctx.clearRequests();
    ctx.emit("skill", { name: "Spatiomancy", oldLevel: 3, newLevel: 4 });
    const pending = ctx.pendingRequests();
    assert.deepEqual(pending.adjustManaCost, ["Mana Geyser", "Mana Well"]);
    assert.deepEqual(Object.keys(pending).sort(), ["adjustManaCost", "updateRegular"],
        "a level change fires the cost displays and the checkable-count sweep");
});

test("progress emission drives the subscribed mana costs", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("progress", { townIndex: 1, varName: "Hermit", oldLevel: 1, newLevel: 2 });
    assert.deepEqual(ctx.pendingRequests(), {
        adjustManaCost: ["Learn Alchemy", "Gather Herbs", "Practical Magic"],
    });
});

test("keyless kinds fall back to the kind:* wildcard", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("guild");
    assert.deepEqual(ctx.pendingRequests(), { adjustGoldCost: ["Excursion"] });
});

test("unknown kinds and unsubscribed keys are silently ignored", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("noSuchKind", { name: "whatever" });
    ctx.emit("skill", { name: "Wunderkind", oldLevel: 1, newLevel: 2 });
    assert.deepEqual(ctx.pendingRequests(), {});
});

test("a Spatiomancy level-up sweeps every checkable action's counts", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("skill", { name: "Spatiomancy", oldLevel: 3, newLevel: 4 });
    const regulars = ctx.requests().updateRegular;
    assert.ok(regulars.length > 0, "expected a non-empty updateRegular sweep");
    // Same predicate the sweep replaced in Spatiomancy's finish().
    const expected = Number(ctx.ev(`totalActionList.filter(a =>
        towns[a.townNum].varNames.indexOf(a.varName) !== -1).length`));
    assert.equal(regulars.length, expected);
});

test("buff emission drives the subscribed gold costs", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("buff", { name: "Imbuement" });
    assert.deepEqual(ctx.pendingRequests(), { adjustGoldCost: ["ImbueMind"] });
});

test("guildSegment emission drives the wizard college mana costs", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("guildSegment", { name: "WizCollege" });
    assert.deepEqual(ctx.pendingRequests(), { adjustManaCost: ["Restoration", "Spatiomancy"] });
});

test("the request queue dedupes subscription-driven targets", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("skill", { name: "Dark", oldLevel: 1, newLevel: 2 });
    ctx.emit("skill", { name: "Dark", oldLevel: 2, newLevel: 3 });
    assert.deepEqual(ctx.pendingRequests(), { adjustGoldCost: ["Pots", "WildMana"] },
        "string targets must collapse, unlike the object payloads they replaced");
});

test("tail kinds drive their subscribed updates", () => {
    const ctx = makeViewContext();
    const cases = [
        ["soulstones", null, { updateSoulstones: [null] }],
        ["resource", { name: "supplies" }, { updateResource: ["supplies"] }],
        ["resource", { name: "reputation" }, { updateResource: ["reputation"] }],
        ["townTotals", { name: "pockets" }, { updateActionTooltips: [null] }],
        ["townTotals", { name: "insurance" }, { updateActionTooltips: [null] }],
        ["goldInvested", null, { updateActionTooltips: [null] }],
        ["talentsReset", null, { updateStats: [null] }],
    ];
    for (const [kind, key, expected] of cases) {
        ctx.clearRequests();
        ctx.emit(kind, key);
        assert.deepEqual(ctx.pendingRequests(), expected, `${kind}:${key?.name ?? "*"}`);
    }
});

test("trial emission passes its payload through to updateTrialInfo", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("trial", { trialNum: 0, curFloor: 7 });
    assert.deepEqual(ctx.pendingRequests(), { updateTrialInfo: [{ trialNum: 0, curFloor: 7 }] });
});

test("imbueSoulReset fans out to every stat plus the three whole-panel renders", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("imbueSoulReset");
    const pending = ctx.pendingRequests();
    assert.deepEqual(pending.updateStat, JSON.parse(ctx.ev("JSON.stringify(statList)")));
    assert.deepEqual(pending.updateBuffs, [null]);
    assert.deepEqual(pending.updateStats, [null]);
    assert.deepEqual(pending.updateSoulstones, [null]);
});

test("survey progress drives the tooltips and the progress bar", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    ctx.emit("progress", { townIndex: 3, varName: "SurveyZ3", oldLevel: 1, newLevel: 2 });
    const pending = ctx.pendingRequests();
    assert.deepEqual(pending.updateActionTooltips, [null]);
    assert.equal(pending.updateProgressAction.length, 1);
    assert.equal(ctx.ev(`testView.requests.updateProgressAction[0].name`), "SurveyZ3");
    assert.equal(ctx.ev(`testView.requests.updateProgressAction[0].town === towns[3]`), true);
});

test("trainingExpMult stays synchronous, as the direct call it replaced was", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    // No adjustExpMult request category exists; the sweep renders immediately.
    ctx.ev("var __expMultCalls = []; testView.adjustExpMult = (n) => __expMultCalls.push(n)");
    ctx.emit("trainingExpMult");
    assert.deepEqual(ctx.pendingRequests(), {}, "must not queue anything");
    assert.deepEqual(JSON.parse(ctx.ev("JSON.stringify(__expMultCalls)")),
        JSON.parse(ctx.ev("JSON.stringify(trainingActions)")));
});

test("a full drain of subscription-driven requests runs without throwing", () => {
    const ctx = makeViewContext();
    ctx.clearRequests();
    for (const [kind, key] of [
        ["skill", { name: "Practical", oldLevel: 1, newLevel: 2 }],
        ["skill", { name: "Spatiomancy", oldLevel: 1, newLevel: 2 }],
        ["skill", { name: "Mercantilism", oldLevel: 1, newLevel: 2 }],
        ["skill", { name: "Dark", oldLevel: 1, newLevel: 2 }],
        ["skill", { name: "Commune", oldLevel: 1, newLevel: 2 }],
        ["buff", { name: "Ritual" }],
        ["buff", { name: "Imbuement" }],
        ["buff", { name: "Imbuement2" }],
        ["buff", { name: "Feast" }],
        ["guild", null],
        ["guildSegment", { name: "WizCollege" }],
        ["progress", { townIndex: 1, varName: "Shortcut", oldLevel: 1, newLevel: 2 }],
        ["progress", { townIndex: 1, varName: "Hermit", oldLevel: 1, newLevel: 2 }],
        ["progress", { townIndex: 1, varName: "Witch", oldLevel: 1, newLevel: 2 }],
        ["progress", { townIndex: 3, varName: "Runes", oldLevel: 1, newLevel: 2 }],
        ["progress", { townIndex: 3, varName: "SurveyZ3", oldLevel: 1, newLevel: 2 }],
        ["soulstones", null],
        ["resource", { name: "supplies" }],
        ["resource", { name: "reputation" }],
        // curFloor 0 only: `trials` is populated by load(), not by boot, so a
        // higher floor would index into an empty array in this fixture.
        ["trial", { trialNum: 0, curFloor: 0 }],
        ["townTotals", { name: "pockets" }],
        ["goldInvested", null],
        ["talentsReset", null],
        ["imbueSoulReset", null],
        ["trainingExpMult", null],
    ]) ctx.emit(kind, key);

    assert.ok(Object.keys(ctx.pendingRequests()).length > 0, "expected a non-empty queue to drain");
    ctx.ev("testView.handleUpdateRequests()");
    assert.deepEqual(ctx.pendingRequests(), {}, "drain must clear every category");
});

test("every subscription key is reachable by some emission shape", () => {
    // Guards against a table entry that can never fire because its key can't be
    // produced — e.g. a "kind:Name" that the emitter only ever sends keyless.
    const ctx = makeViewContext();
    const keys = JSON.parse(ctx.ev("JSON.stringify(Object.keys(STATE_SUBSCRIPTIONS))"));
    for (const key of keys) {
        const [kind, name] = key.split(":");
        ctx.clearRequests();
        ctx.emit(kind, name === "*" ? null : { name, varName: name, oldLevel: 0, newLevel: 1 });
        assert.ok(Object.keys(ctx.pendingRequests()).length > 0 || key === "trainingExpMult:*",
            `"${key}" produced no requests for its own key shape`);
    }
});
