// test/effect-differential.test.mjs — Phase 6's oracle gate + its canaries.
//
// The differential itself (lib) compares every compiled effect slot against the
// hand-written JS body across the effect corpus. This file adds the parts that
// keep it from being vacuously green:
//   - the frozen per-slot manifest (which slots compile, which are native);
//   - the "every compiled slot mutates something somewhere" assertion;
//   - per-element vocabulary canaries: a targeted XML mutation of each new
//     element type must make the differential go RED. If a canary passes, the
//     element is not actually driving behavior.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./harness.mjs";
import { buildEffectDifferential, slotManifest } from "./effect-differential.lib.mjs";

const MANIFEST = path.join(ROOT, "test", "goldens", "slot-manifest.json");
const XML = path.join(ROOT, "data", "actionList.xml");

test("effect differential: every compiled slot matches its JS body", () => {
    const r = buildEffectDifferential();
    assert.deepEqual(r.mismatches, [], `${r.mismatches.length} of ${r.comparisons} comparisons diverged`);
    assert.ok(r.comparisons > 0, "no (action, slot) pairs were compared");
});

test("effect differential: no compiled slot is inert across the whole corpus", () => {
    const r = buildEffectDifferential();
    // A slot that never mutates anything would agree with JS by doing nothing.
    assert.deepEqual(r.inert, [], "compiled slots that never changed state in any corpus state");
});

test("slot manifest matches the frozen golden", () => {
    const r = buildEffectDifferential({ onlyStates: ["boot"] });
    const got = slotManifest(r.plan);
    const want = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    assert.deepEqual(got, want, "run: node test/regen-slot-manifest.mjs");
});

// ---- vocabulary canaries -------------------------------------------------
// Each entry rewrites the XML so one element type behaves differently, then
// requires the differential to catch it. `find` must appear exactly once.
const CANARIES = [
    {
        name: "numericResource amount",
        find: `<numericResource name="herbs">1</numericResource>`,
        with: `<numericResource name="herbs">2</numericResource>`,
    },
    {
        name: "booleanResource grant",
        find: `<booleanResource name="pickaxe" />`,
        with: `<booleanResource name="pegasus" />`,
    },
    {
        name: "setStoryFlag",
        find: `<setStoryFlag name="keyBought" />`,
        with: `<setStoryFlag name="pickaxeBought" />`,
    },
    {
        name: "setStoryFlag guard",
        find: `<setStoryFlag name="built50Houses"><ifResource resourceName="houses" min="50" /></setStoryFlag>`,
        with: `<setStoryFlag name="built50Houses"><ifResource resourceName="houses" min="5" /></setStoryFlag>`,
    },
    {
        name: "storyVarMin",
        find: `<storyVarMin name="maxZombiesRaised"><resourceValue name="zombie" /></storyVarMin>`,
        with: `<storyVarMin name="maxZombiesRaised"><resourceValue name="blood" /></storyVarMin>`,
    },
    {
        name: "skillExp",
        find: `<skillExp />\n            <setStoryFlag name="houseBuilt" />`,
        with: `<setStoryFlag name="houseBuilt" />`,
    },
    {
        // all four Haul actions share the primitive; dropping it everywhere is
        // still a single-element mutation
        name: "effect primitive",
        find: `                <effect name="setStoneLoc" />\n`,
        with: ``,
        all: 4,
    },
    {
        name: "ledger amount",
        find: `<ledger>5000</ledger>`,
        with: `<ledger>4999</ledger>`,
    },
    {
        name: "before placement (outside finishRegular)",
        find: `            <before>\n                <setStoryFlag name="receivedDonation" />\n            </before>\n`,
        with: `            <setStoryFlag name="receivedDonation" />\n`,
    },
    {
        name: "after placement (outside finishRegular)",
        find: `<setStoryFlag name="drew10Wells"><ifGoodItems min="10" /></setStoryFlag>`,
        with: `<setStoryFlag name="drew10Wells"><ifGoodItems min="11" /></setStoryFlag>`,
    },
    {
        name: "cost deduction",
        find: `<cost>\n            <numericResource name="gold">1000000</numericResource>\n        </cost>`,
        with: `<cost>\n            <numericResource name="gold">999999</numericResource>\n        </cost>`,
    },
    {
        name: "cost <deduction> override",
        find: `            <deduction>\n                <numericResource name="gold">\n                    <resourceValue name="teamMembers" />\n                    <multiplier value="100" />\n                </numericResource>\n            </deduction>\n`,
        with: ``,
    },
    {
        // the marker that executes the action's own <progress> data field
        name: "grantProgress marker",
        find: `<grantProgress />`,
        with: `<progressExp>1</progressExp>`,
        all: 19,
    },
    {
        name: "progressExp (cross-variable)",
        find: `<progressExp varName="Met">3200</progressExp>`,
        with: `<progressExp varName="Met">3201</progressExp>`,
    },
    {
        name: "progressExp target varName",
        find: `<progressExp varName="Met">3200</progressExp>`,
        with: `<progressExp varName="Secrets">3200</progressExp>`,
    },
    {
        name: `cost deduction="none"`,
        find: `<cost deduction="none">`,
        with: `<cost>`,
    },
];

test("vocabulary canaries: a targeted mutation of each element flips the differential", () => {
    const base = fs.readFileSync(XML, "utf8");
    const baseline = slotManifest(buildEffectDifferential({ onlyStates: ["boot"] }).plan).counts;
    const survivors = [];
    const disabled = [];
    for (const c of CANARIES) {
        const n = base.split(c.find).length - 1;
        assert.equal(n, c.all ?? 1, `canary "${c.name}": anchor must appear ${c.all ?? 1}×, found ${n}`);
        const mutated = c.all ? base.split(c.find).join(c.with) : base.replace(c.find, c.with);
        const r = buildEffectDifferential({ xmlText: mutated, maxMismatches: 3 });
        // A mutation that stops a slot COMPILING is not a valid canary: the slot
        // falls back to JS and matches JS trivially, so a green differential
        // proves nothing about the element. (Emptying a <reward> does exactly
        // this — it cost one canary before the check existed.)
        // Only a DECREASE is suspect. Some canaries deliberately ENABLE a slot
        // (dropping deduction="none" compiles Map's cost); that adds behavior
        // JS lacks, which the differential reports as js-slot-absent.
        const counts = slotManifest(r.plan).counts;
        const dropped = Object.keys(baseline).filter(k => (counts[k] ?? 0) < baseline[k]);
        if (dropped.length) {
            disabled.push(`${c.name}: ${JSON.stringify(baseline)} -> ${JSON.stringify(counts)}`);
            continue;
        }
        if (r.mismatches.length === 0) survivors.push(c.name);
    }
    assert.deepEqual(disabled, [], "canaries that DISABLED compilation instead of changing behavior");
    assert.deepEqual(survivors, [], "canaries the differential failed to catch");
});
