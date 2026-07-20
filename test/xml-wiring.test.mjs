// Game-side wiring tests (XML migration Phases 4/5 wiring:
// options.useActionListXml).
//
// Strata:
//   1. carrier staleness guard — data/actionListXml.data.js must carry
//      data/actionList.xml byte-for-byte (regen: node test/regen-xml-carrier.mjs);
//   2. wired-path differential — the full Phase-3 corpus replayed in two
//      contexts, plain JS vs one with ActionListXml.applyOverrides() applied
//      to the LIVE Action objects (the exact mechanism the option uses at
//      load), compared with the Phase-4 differential's semantics (numerics
//      ===, boolean-position by truthiness — the raw-value golden hash is
//      the wrong gate here because several JS visible()/unlocked() bodies
//      return truthy non-booleans where the XML answers true). WIRED_PREP
//      asserts applied === total so a silent per-action JS fallback cannot
//      pass vacuously;
//   3. live-override canary — a mutated XML value must change what the LIVE
//      Action object answers (the override actually took; not vacuous);
//   4. revert — toggling off restores the exact JS closures (function
//      identity), for every overridden field of every action, INCLUDING the
//      Phase-6 effect slots;
//   5. live reward canary — a mutated <reward> amount must change what the
//      LIVE Action's finish() actually grants (Phase 6's analogue of stratum 3:
//      an override that compiles but never executes would pass 1-4).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { makeContext, ROOT, SIM_FILES } from "./harness.mjs";
import { buildWiredDifferential, WIRED_FILES } from "./field-matrix.lib.mjs";

const XML_FILES = ["xmlLite.js", "actionListXml.js"];

test("carrier: data/actionListXml.data.js matches data/actionList.xml", () => {
    const xml = fs.readFileSync(path.join(ROOT, "data", "actionList.xml"), "utf8");
    const carrierSrc = fs.readFileSync(path.join(ROOT, "data", "actionListXml.data.js"), "utf8");
    const sandbox = {};
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    new vm.Script(carrierSrc, { filename: "actionListXml.data.js" }).runInContext(sandbox);
    assert.equal(sandbox.actionListXmlText, xml,
        "carrier is stale — regenerate with: node test/regen-xml-carrier.mjs");
});

test("wired path: live actions under the override match plain JS across the corpus", () => {
    const d = buildWiredDifferential();
    assert.equal(d.wiredCounts.total, 157, "expected all 157 actions XML-defined");
    assert.equal(d.wiredCounts.applied, d.wiredCounts.total, "some actions fell back to JS at apply time");
    assert.equal(d.rngConsumed, 0, "the wired fields must not consume RNG");
    assert.equal(d.statesChecked, d.totalStates, "corpus was cut short");
    assert.deepEqual(d.mismatches, [],
        `wired-path mismatches vs plain JS (first: ${JSON.stringify(d.mismatches[0])})`);
});

test("canary: a mutated XML value changes what the LIVE Action answers", () => {
    const xml = fs.readFileSync(path.join(ROOT, "data", "actionList.xml"), "utf8");
    // Wander's <effortCost value="250"/> is the first occurrence in the file
    const mutated = xml.replace('<effortCost value="250"/>', '<effortCost value="251"/>');
    assert.notEqual(mutated, xml, "mutation target not found in data/actionList.xml");
    const ctx = makeContext(12345, XML_FILES);
    ctx.sandbox.__mutatedXml = mutated;
    const res = JSON.parse(ctx.ev(`JSON.stringify((() => {
        const before = Action.Wander.manaCost();
        const beforeFn = Action.Wander.manaCost;
        const r = ActionListXml.applyOverrides(__mutatedXml);
        const after = Action.Wander.manaCost();
        ActionListXml.revertOverrides();
        return {
            applied: r.applied, total: r.total,
            before, after,
            reverted: Action.Wander.manaCost() === before && Action.Wander.manaCost === beforeFn,
        };
    })())`));
    assert.equal(res.applied, res.total, "some actions fell back to JS");
    assert.notEqual(res.after, res.before,
        "effortCost 250→251 in the XML produced no change on the LIVE Action — the override is dead");
    assert.ok(res.reverted, "revertOverrides did not restore the JS closure");
});

test("revert restores the exact JS closures (function identity, all actions)", () => {
    const ctx = makeContext(12345, WIRED_FILES);
    const res = JSON.parse(ctx.ev(`JSON.stringify((() => {
        const FIELDS = ["manaCost", "goldCost", "visible", "unlocked", "canStart", "allowed",
            "storyReqs", "loopCost", "tickProgress",
            // Phase-6 effect slots: function-valued too, so the same
            // override/revert machinery carries them
            ...ActionListXml.SLOTS];
        const before = totalActionList.map(a => FIELDS.map(f => a[f]));
        const r = ActionListXml.applyOverrides();
        let overridden = 0;
        totalActionList.forEach((a, i) => FIELDS.forEach((f, j) => { if (a[f] !== before[i][j]) overridden++; }));
        ActionListXml.revertOverrides();
        let mismatched = 0;
        totalActionList.forEach((a, i) => FIELDS.forEach((f, j) => { if (a[f] !== before[i][j]) mismatched++; }));
        // idempotence: a second apply/revert cycle behaves the same
        const r2 = ActionListXml.applyOverrides();
        ActionListXml.revertOverrides();
        let mismatched2 = 0;
        totalActionList.forEach((a, i) => FIELDS.forEach((f, j) => { if (a[f] !== before[i][j]) mismatched2++; }));
        return { applied: r.applied, total: r.total, applied2: r2.applied, overridden, mismatched, mismatched2 };
    })())`));
    assert.equal(res.total, 157, "expected all 157 actions XML-defined");
    assert.equal(res.applied, res.total, "some actions fell back to JS at apply time");
    assert.equal(res.applied2, res.applied, "second apply cycle applied a different count");
    assert.ok(res.overridden > 300, `implausibly few overridden field closures (${res.overridden})`);
    assert.equal(res.mismatched, 0, "revert left a non-original closure behind");
    assert.equal(res.mismatched2, 0, "second apply/revert cycle left a non-original closure behind");
});

test("canary: a mutated <reward> changes what the LIVE finish() grants", () => {
    const xml = fs.readFileSync(path.join(ROOT, "data", "actionList.xml"), "utf8");
    // Smash Pots' reward is the mana stack; +1 mana per pot must show up in
    // the mana the live action actually adds
    const mutated = xml.replace(`<reward>
            <numericResource name="mana">
                <primaryValue />
            </numericResource>
            <ledger><primaryValue /></ledger>
        </reward>`, `<reward>
            <numericResource name="mana">
                <primaryValue />
                <addition value="1" />
            </numericResource>
            <ledger><primaryValue /></ledger>
        </reward>`);
    assert.notEqual(mutated, xml, "mutation target not found in data/actionList.xml");
    const run = (xmlText) => {
        const ctx = makeContext(12345, XML_FILES);
        ctx.sandbox.__rewardXml = xmlText;
        return JSON.parse(ctx.ev(`JSON.stringify((() => {
            towns[0].totalPots = 500; towns[0].checkedPots = 0;
            towns[0].goodPots = 0; towns[0].goodTempPots = 0; towns[0].lootFromPots = 0;
            if (__rewardXml) {
                const r = ActionListXml.applyOverrides(__rewardXml);
                if (r.applied !== r.total) throw new Error("fell back to JS");
            }
            const before = timeNeeded;
            for (let i = 0; i < 50; i++) Action.SmashPots.finish();
            return { mana: timeNeeded - before, loot: towns[0].lootFromPots, good: towns[0].goodPots };
        })())`));
    };
    const js = run(null), on = run(null), mut = run(mutated);
    assert.deepEqual(on, js, "the unmutated XML path must grant exactly what JS grants");
    assert.ok(js.good > 0, "the fixture did not actually complete any rewards");
    assert.notEqual(mut.mana, js.mana,
        "a +1 mana reward in the XML produced no change on the LIVE finish() — the reward override is dead");
});

// ---------------------------------------------------------------------------
// Boot wiring: every context that loads actionList.js must also load unlocks.js
// ---------------------------------------------------------------------------
// Since the unlock cutover, Action.prototype.visible/unlocked delegate to
// Unlocks, which derives its rows from the XML carrier. A page or worker that
// loads actionList.js WITHOUT the XML stack therefore has actions that cannot
// answer their own predicates — a ReferenceError the moment anything asks.
// That is easy to reintroduce (editor.html was exactly this gap when the
// cutover landed and had to be wired), and no other test covers the editor,
// so pin the invariant across every boot context at once.
test("boot wiring: every context loading actionList.js also loads unlocks.js", () => {
    const CONTEXTS = ["index.html", "editor.html", "predictor-worker.js", "planner-worker.js"];
    const NEEDED = ["xmlLite.js", "actionListXml.js", "data/actionListXml.data.js", "unlocks.js"];
    for (const f of CONTEXTS) {
        const src = fs.readFileSync(path.join(ROOT, f), "utf8");
        if (!src.includes("actionList.js")) continue;
        for (const dep of NEEDED) {
            assert.ok(src.includes(dep),
                `${f} loads actionList.js but not ${dep} — its actions cannot answer visible()/unlocked()`);
        }
        // and in the right order: the predicates need their inputs defined first
        assert.ok(src.indexOf("actionList.js") < src.indexOf("unlocks.js"),
            `${f} must load unlocks.js after actionList.js`);
    }
    // the harness is the fourth context and is a JS array rather than a file list
    for (const dep of NEEDED) {
        assert.ok(SIM_FILES.includes(dep), `harness SIM_FILES is missing ${dep}`);
    }
});
