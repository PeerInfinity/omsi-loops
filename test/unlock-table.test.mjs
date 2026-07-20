// unlock-table.test.mjs — the unlock table is a golden AND a live claim about
// the game's behavior, so this asserts both:
//   1. regenerating in memory reproduces the committed data/unlockTable.json;
//   2. the rows still say exactly what the JS closures say, over a synthetic
//      corpus, real save fixtures, and an independent probe extraction.
//
// (2) is the load-bearing half. The golden alone would only prove the table
// has not changed, which is worthless if it was wrong when it was frozen.
//
// To update the golden after a DELIBERATE content change: node test/regen-unlock-table.mjs

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";

import {
    makeUnlockContext, readXml, buildTable, serializeTable, walkRows, TABLE_PATH,
    verifyAgainstClosures, verifyAgainstFixtures, extractByProbing, compareWithProbe,
} from "./unlock-table.lib.mjs";

const xml = readXml();
const ctx = makeUnlockContext();
const table = buildTable(ctx, xml);

test("unlock table: regenerating reproduces the committed golden", () => {
    const committed = fs.readFileSync(TABLE_PATH, "utf8");
    assert.equal(serializeTable(table), committed,
        "unlock table is stale — regenerate with: node test/regen-unlock-table.mjs");
});

test("unlock table: shape and the AP-eligibility rule", () => {
    assert.equal(table.rows.length, 314, "157 actions x 2 predicates");
    assert.equal(table.quantities.length, 18 * table.meta.granularity, "18 discovery vars x G steps");

    // ids are a stability contract (plan §3.3): unique, and never encoding a
    // threshold, so rebalancing a number cannot rename a row.
    const ids = [...table.rows, ...table.quantities].map(r => r.id);
    assert.equal(new Set(ids).size, ids.length, "row ids must be unique");

    // §3.4: a row that can turn back OFF as the player progresses can never
    // carry an AP check. Buy Glasses' visible row is the only one in the game
    // (it hides once exploring completes or after any prestige).
    const nonMonotone = table.rows.filter(r => !r.monotone);
    assert.deepEqual(nonMonotone.map(r => r.id), ["v:BuyGlasses"]);
    for (const r of [...table.rows, ...table.quantities]) {
        if (r.monotone === false) assert.equal(r.apEligible, false, `${r.id} is non-monotone but AP-eligible`);
    }
    // visible rows are cosmetic, never locations (§3.2)
    assert.ok(!table.rows.some(r => r.pred === "visible" && r.apEligible));
});

test("unlock table: rows agree with the live JS closures", () => {
    const v = verifyAgainstClosures(ctx, table.rows);
    assert.ok(v.checks > 500000, `expected a large corpus, got ${v.checks} checks`);
    assert.deepEqual(v.mismatches, [],
        "a row disagrees with the closure it was derived from");
});

test("unlock table: canary — the differential CATCHES a wrong row", () => {
    // Anti-vacuity. Every assertion above is "zero mismatches", which a
    // comparison that silently compares nothing would also satisfy. Corrupt
    // one threshold and the differential must notice; otherwise the green
    // above means nothing.
    const corrupted = table.rows.map(r =>
        r.id !== "u:Locks" ? r
            : { ...r, requires: [{ ...r.requires[0], level: r.requires[0].level + 5 }] });
    const v = verifyAgainstClosures(ctx, corrupted, { corpus: 40 });
    assert.ok(v.mismatches.length > 0, "a corrupted threshold went undetected");
    assert.ok(v.mismatches.every(m => m.id === "u:Locks"),
        `only the corrupted row should mismatch, got ${[...new Set(v.mismatches.map(m => m.id))]}`);
});

test("unlock table: rows agree with the closures on real save fixtures", () => {
    const f = verifyAgainstFixtures(table.rows);
    assert.equal(f.states, 3);
    assert.deepEqual(f.mismatches, []);
});

test("unlock table: an independent probe extraction agrees with the walk", () => {
    // probes the JS closures directly — shares no code and no input with the
    // XML walk, so this is a genuine second stratum rather than a restatement
    const cmp = compareWithProbe(table.rows, extractByProbing(ctx));
    assert.deepEqual(cmp.diffs, []);
    assert.equal(cmp.compared, 313);
    // the tolerances must still be needed; if one stops applying, that is a
    // real change and should fail here rather than quietly widen
    assert.equal(cmp.skippedNonMonotone, 1, "probing can only be blind to Buy Glasses");
    assert.equal(cmp.redundantDropped, 20, "the exploreProgress>=1 class covers Map + 9 surveys, both predicates");
});

/**
 * Replace one action's <unlocked> body, positionally.
 *
 * Anchoring by string match is not safe here: `<unlocked><ifProgress
 * varName="Wander" min="20"/></unlocked>` appears three times (several
 * actions share that gate), so a plain replace would mutate whichever came
 * first. Slice to the named action's element and edit inside it.
 */
function replaceUnlockedBody(xmlText, actionName, body) {
    const start = xmlText.indexOf(`name="${actionName}"`);
    assert.notEqual(start, -1, `no <action name="${actionName}">`);
    const open = xmlText.indexOf("<unlocked>", start);
    const close = xmlText.indexOf("</unlocked>", open);
    assert.ok(open !== -1 && close !== -1, "action has no <unlocked> block");
    // guard against running past the end of this action into the next one
    assert.equal(xmlText.slice(start, open).includes("</action>"), false);
    return xmlText.slice(0, open) + "<unlocked>" + body + xmlText.slice(close);
}

test("unlock table: canary — mutating an XML threshold moves the table", () => {
    // Guards against the walk silently ignoring the elements it claims to
    // read: without this, a walk that returned stale or hard-coded rows would
    // still pass every equality assertion above.
    const before = walkRows(ctx, xml).find(r => r.id === "u:Locks");
    assert.deepEqual(before.requires, [{ kind: "townLevel", town: 0, v: "Wander", op: "gte", level: 20 }]);

    const mutated = replaceUnlockedBody(xml, "Pick Locks", `<ifProgress varName="Wander" min="21" />`);
    const after = walkRows(ctx, mutated).find(r => r.id === "u:Locks");
    assert.equal(after.requires[0].level, 21, "the walk did not read the mutated threshold");

    // and only that row moved
    const others = walkRows(ctx, mutated).filter(r => r.id !== "u:Locks");
    assert.deepEqual(others, walkRows(ctx, xml).filter(r => r.id !== "u:Locks"));
});

test("unlock table: an unmapped condition is a hard error, not a skip", () => {
    // The closed-vocabulary rule. A silent skip would drop a real condition
    // and hand AP a location reachable under conditions nobody modelled.
    // <ifGuild> is a real interpreter conditional that predicates never use.
    const unmappedTag = replaceUnlockedBody(xml, "Pick Locks", `<ifGuild guild="Explorer" />`);
    assert.throws(() => walkRows(ctx, unmappedTag), /unmapped condition <ifGuild>/);

    // an unmapped ATTRIBUTE on a mapped tag must fail just as hard — this is
    // the likelier drift (a new comparison form on an existing condition)
    const unmappedAttr = replaceUnlockedBody(xml, "Pick Locks", `<ifProgress varName="Wander" notEquals="3" />`);
    assert.throws(() => walkRows(ctx, unmappedAttr), /unmapped attribute notEquals/);
});
