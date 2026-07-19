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

// One full sweep answers both questions; building it twice was ~50s of waste.
let FULL;
const full = () => (FULL ??= buildEffectDifferential());

test("effect differential: every compiled slot matches its JS body", () => {
    const r = full();
    assert.deepEqual(r.mismatches, [], `${r.mismatches.length} of ${r.comparisons} comparisons diverged`);
    assert.ok(r.comparisons > 0, "no (action, slot) pairs were compared");
});

test("effect differential: no compiled slot is inert across the whole corpus", () => {
    // A slot that never mutates anything would agree with JS by doing nothing.
    // <noEffect/> slots are exempt — and held to the opposite standard below.
    assert.deepEqual(full().inert, [], "compiled slots that never changed state in any corpus state");
});

test("effect differential: a declared <noEffect/> slot really does nothing", () => {
    const r = full();
    assert.ok(r.plan.declaredNoOp.length > 0, "no <noEffect/> slots found — the check is vacuous");
    assert.deepEqual(r.lyingNoOp, [], "slots declared <noEffect/> that mutated state anyway");
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
        // Gather Herbs and Explore Jungle both grant one herb
        name: "numericResource amount",
        actions: ["Gather Herbs", "Explore Jungle"],
        find: `<numericResource name="herbs">1</numericResource>`,
        with: `<numericResource name="herbs">2</numericResource>`,
        all: 2,
    },
    {
        name: "booleanResource grant",
        actions: ["Buy Pickaxe"],
        find: `<booleanResource name="pickaxe" />`,
        with: `<booleanResource name="pegasus" />`,
    },
    {
        name: "setStoryFlag",
        actions: ["Purchase Key"],
        find: `<setStoryFlag name="keyBought" />`,
        with: `<setStoryFlag name="pickaxeBought" />`,
    },
    {
        name: "setStoryFlag guard",
        actions: ["Build Housing"],
        find: `<setStoryFlag name="built50Houses"><ifResource resourceName="houses" min="50" /></setStoryFlag>`,
        with: `<setStoryFlag name="built50Houses"><ifResource resourceName="houses" min="5" /></setStoryFlag>`,
    },
    {
        name: "storyVarMin",
        actions: ["Raise Zombie"],
        find: `<storyVarMin name="maxZombiesRaised"><resourceValue name="zombie" /></storyVarMin>`,
        with: `<storyVarMin name="maxZombiesRaised"><resourceValue name="blood" /></storyVarMin>`,
    },
    {
        name: "skillExp",
        actions: ["Build Housing"],
        find: `<skillExp />\n            <setStoryFlag name="houseBuilt" />`,
        with: `<setStoryFlag name="houseBuilt" />`,
    },
    {
        // all four Haul actions share the primitive; dropping it everywhere is
        // still a single-element mutation
        name: "effect primitive",
        actions: ["HaulZ1", "HaulZ3", "HaulZ5", "HaulZ6"],
        find: `                <effect name="setStoneLoc" />\n`,
        with: ``,
        all: 4,
    },
    {
        name: "ledger amount",
        actions: ["Mana Geyser"],
        find: `<ledger>5000</ledger>`,
        with: `<ledger>4999</ledger>`,
    },
    {
        name: "before placement (outside finishRegular)",
        actions: ["Accept Donations"],
        find: `            <before>\n                <setStoryFlag name="receivedDonation" />\n            </before>\n`,
        with: `            <setStoryFlag name="receivedDonation" />\n`,
    },
    {
        name: "after placement (outside finishRegular)",
        actions: ["Mana Well"],
        find: `<setStoryFlag name="drew10Wells"><ifGoodItems min="10" /></setStoryFlag>`,
        with: `<setStoryFlag name="drew10Wells"><ifGoodItems min="11" /></setStoryFlag>`,
    },
    {
        name: "cost deduction",
        actions: ["Purchase Key"],
        find: `<cost>\n            <numericResource name="gold">1000000</numericResource>\n        </cost>`,
        with: `<cost>\n            <numericResource name="gold">999999</numericResource>\n        </cost>`,
    },
    {
        name: "cost <deduction> override",
        actions: ["Gather Team"],
        find: `            <deduction>\n                <numericResource name="gold">\n                    <resourceValue name="teamMembers" />\n                    <multiplier value="100" />\n                </numericResource>\n            </deduction>\n`,
        with: ``,
    },
    {
        // the marker that executes the action's own <progress> data field
        // every progress action carries one, so the count grows each slice —
        // `all: true` means "mutate them all, at least one must exist"
        name: "grantProgress marker",
        find: `<grantProgress />`,
        with: `<progressExp>1</progressExp>`,
        all: true,
    },
    {
        name: "progressExp (cross-variable)",
        actions: ["Throw Party"],
        find: `<progressExp varName="Met">3200</progressExp>`,
        with: `<progressExp varName="Met">3201</progressExp>`,
    },
    {
        name: "progressExp target varName",
        actions: ["Throw Party"],
        find: `<progressExp varName="Met">3200</progressExp>`,
        with: `<progressExp varName="Secrets">3200</progressExp>`,
    },
    {
        name: "setSkill (dynamic skills amount)",
        actions: ["Seek Blessing"],
        find: `<setSkill name="Divine" value="50">`,
        with: `<setSkill name="Divine" value="51">`,
    },
    {
        name: "currentFloor base value",
        actions: ["Secret Trial"],
        find: `<setStoryFlag name="trailSecret10Done"><if min="10"><currentFloor /></if></setStoryFlag>`,
        with: `<setStoryFlag name="trailSecret10Done"><if min="11"><currentFloor /></if></setStoryFlag>`,
    },
    {
        name: "loopCounter varName (another action's counter)",
        actions: ["Prepare Buffet"],
        find: `<setStoryFlag name="buffetFor6"><if min="6"><loopCounter varName="Rescue" /></if></setStoryFlag>`,
        with: `<setStoryFlag name="buffetFor6"><if min="6"><loopCounter varName="Tidy" /></if></setStoryFlag>`,
    },
    {
        name: "guild-rank bonus function",
        actions: ["Pick Pockets"],
        find: `<progress value="30">\n            <multiplier><function name="getThievesGuildRankBonus" /></multiplier>\n        </progress>`,
        with: `<progress value="30">\n            <multiplier><function name="getCraftGuildRankBonus" /></multiplier>\n        </progress>`,
    },
    {
        name: "spatiomancyFinish primitive",
        actions: ["Spatiomancy"],
        find: `<effect name="spatiomancyFinish" />`,
        with: `<skillExp />`,
    },
    {
        name: "guildSegmentIncrement",
        actions: ["Adventure Guild"],
        find: `<guildSegmentIncrement name="advGuild" />`,
        with: `<guildSegmentIncrement name="craftGuild" />`,
    },
    {
        // upstream emits stateChanged for wizCollege only; swapping the target
        // changes both the counter and the notification
        name: "guildSegmentIncrement (wizCollege emission)",
        actions: ["Wizard College"],
        find: `<guildSegmentIncrement name="wizCollege" />`,
        with: `<guildSegmentIncrement name="gods" />`,
    },
    {
        name: "segmentReward slot",
        actions: ["Fight Monsters"],
        find: `<segmentReward>\n            <numericResource name="gold">20</numericResource>\n        </segmentReward>`,
        with: `<segmentReward>\n            <numericResource name="gold">21</numericResource>\n        </segmentReward>`,
    },
    {
        name: "loopReward slot",
        actions: ["Heal The Sick"],
        find: `<loopReward>\n            <numericResource name="reputation">3</numericResource>\n        </loopReward>`,
        with: `<loopReward>\n            <numericResource name="reputation">4</numericResource>\n        </loopReward>`,
    },
    {
        name: "floorReward slot",
        actions: ["Dead Trial"],
        find: `<floorReward>\n            <numericResource name="zombie">1</numericResource>\n        </floorReward>`,
        with: `<floorReward>\n            <numericResource name="zombie">2</numericResource>\n        </floorReward>`,
    },
    {
        name: "pushHeart primitive",
        actions: ["AssassinZ0"],
        find: `<numericResource name="heart">1</numericResource>\n            <effect name="pushHeart" />`,
        with: `<numericResource name="heart">1</numericResource>`,
        all: true,
    },
    {
        name: "buff grant",
        actions: ["Dark Ritual"],
        find: `<buff name="Ritual" spendType="soulstone">`,
        with: `<buff name="Feast" spendType="soulstone">`,
    },
    {
        name: "sacrifice amount",
        actions: ["Great Feast"],
        find: `<buff name="Feast" spendType="soulstone">\n                <sacrifice variant="bySegments"><primaryValue /></sacrifice>\n            </buff>`,
        with: `<buff name="Feast" spendType="soulstone">\n                <sacrifice variant="bySegments"><primaryValue /><addition value="1" /></sacrifice>\n            </buff>`,
    },
    {
        name: "addTrainingLimit",
        actions: ["Imbue Mind"],
        find: `<addTrainingLimit />`,
        with: ``,
    },
    {
        name: "buff guard (Heroism floor gate)",
        actions: ["Heroes Trial"],
        find: `<if min="0"><currentFloor /><subtraction><buffLevel buffName="Heroism" /></subtraction></if>`,
        with: `<if min="1"><currentFloor /><subtraction><buffLevel buffName="Heroism" /></subtraction></if>`,
    },
    {
        name: "imbueBodyEffect primitive",
        actions: ["Imbue Body"],
        find: `<effect name="imbueBodyEffect" />`,
        with: `<noEffect />`,
    },
    {
        name: "imbueSoulReset primitive",
        actions: ["Imbue Soul"],
        find: `<effect name="imbueSoulReset" />`,
        with: `<noEffect />`,
    },
    {
        name: `cost deduction="none"`,
        actions: ["Map"],
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
        if (c.all === true) assert.ok(n >= 1, `canary "${c.name}": anchor not found`);
        else assert.equal(n, c.all ?? 1, `canary "${c.name}": anchor must appear ${c.all ?? 1}×, found ${n}`);
        const mutated = c.all ? base.split(c.find).join(c.with) : base.replace(c.find, c.with);
        // only the actions the mutated element lives in need evaluating —
        // same claim, a fraction of the sweep
        const r = buildEffectDifferential({ xmlText: mutated, maxMismatches: 3, onlyActions: c.actions ?? null });
        // A mutation that stops a slot COMPILING is not a valid canary: the slot
        // falls back to JS and matches JS trivially, so a green differential
        // proves nothing about the element. (Emptying a <reward> does exactly
        // this — it cost one canary before the check existed.)
        // Only a DECREASE is suspect. Some canaries deliberately ENABLE a slot
        // (dropping deduction="none" compiles Map's cost); that adds behavior
        // JS lacks, which the differential reports as js-slot-absent.
        const counts = slotManifest(r.plan).counts;   // plan is unfiltered
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
