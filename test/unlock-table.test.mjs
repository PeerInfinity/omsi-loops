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
    walkQuantityDims, measureQuantityCurves, verifyQuantityRows, QUANTITY_EXCLUDED_VARS,
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
    assert.equal(table.meta.quantityModel, "loot-batch");
    assert.equal(table.quantities.length, 620,
        "14 randomized discovery vars x their complete base-rate batches");

    // §7.5's pool scoping filters BOTH row families by town, so every row must
    // carry one — quantity rows in the id, predicate rows in a field.
    for (const r of table.rows) {
        assert.equal(typeof r.town, "number", `${r.id} has no town`);
    }

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

test("unlock table: quantity rows are well-formed loot batches", () => {
    // The row shape IS the AP contract (§3.5): batch k costs one item worth
    // oneInEvery capacity and unlocks at k * oneInEvery. Assert it structurally
    // so a generator change that broke the arithmetic could not ride along
    // behind a regenerated golden.
    const byVar = new Map();
    for (const r of table.quantities) {
        const key = `${r.town}:${r.var}`;
        if (!byVar.has(key)) byVar.set(key, []);
        byVar.get(key).push(r);
    }
    assert.equal(byVar.size, 14, "18 discovery vars, less the 4 excluded Hauls");

    for (const [key, rows] of byVar) {
        const N = rows[0].grant.batch;
        assert.deepEqual(rows.map(r => r.step), rows.map((_, i) => i + 1),
            `${key}: steps must be 1..n with no gaps`);
        for (const r of rows) {
            assert.equal(r.grant.batch, N, `${key}: batch size must be constant per var`);
            assert.equal(r.trigger.baseTotalAtLeast, r.step * N,
                `${r.id}: trigger must be step * oneInEvery`);
            assert.equal(r.id, `q:${r.town}:${r.var}:${r.step}`);
        }
    }

    // the two spot-checks the ruling names explicitly
    assert.equal(byVar.get("0:Pots").length, 50, "Pots: 50 batches (Explored 2,4..100)");
    assert.equal(byVar.get("0:Locks").length, 10, "Locks: 10 batches (Explored 10..100)");
});

test("unlock table: the Hauls are excluded from randomization entirely", () => {
    // USER RULING 2026-07-20: no AP locations and no AP items for the four
    // soulstone hauls. They still carry <totalDiscovered> and would otherwise
    // mint 250 batch rows each (2500 capacity/level over a 1000 ratio) — 62%
    // of the pool — so this is the assertion that keeps them out.
    assert.deepEqual([...QUANTITY_EXCLUDED_VARS], ["StonesZ1", "StonesZ3", "StonesZ5", "StonesZ6"]);
    assert.deepEqual(table.meta.excludedVars, [...QUANTITY_EXCLUDED_VARS],
        "the committed artifact must record the exclusion");

    for (const r of table.quantities) {
        assert.ok(!QUANTITY_EXCLUDED_VARS.includes(r.var), `${r.id} is an excluded var`);
    }

    // and they really are vars the generator SAW and dropped, not vars that
    // happen not to exist — otherwise this test would pass on a typo
    const dims = walkQuantityDims(ctx, xml);
    for (const v of QUANTITY_EXCLUDED_VARS) {
        assert.ok(dims.some(d => d.action === v), `${v} must be a real <totalDiscovered> var`);
    }
    assert.equal(dims.length, 18, "all 18 vars are still walked; 4 are filtered at row-minting");
});

// The same ruling's OTHER surface — cross-game loot shuffling — is guarded in
// the outer repo (omsiSubstrateWrapper/generateAwardSchedule.test.js), not
// here: that generator is not part of the fork, and this suite must keep
// running standalone in fork CI.

test("unlock table: loot batches fire when the live formula completes them", () => {
    // The load-bearing quantity check: replays each var's source dims against
    // the running game and compares the frozen thresholds to the batch count
    // the live base-rate total actually supports, in several dim orderings.
    const curves = measureQuantityCurves(ctx, walkQuantityDims(ctx, xml));
    const q = verifyQuantityRows(ctx, curves, table.quantities);
    assert.deepEqual(q.problems, []);
    // 14 randomized vars, 101 levels per dim, plus the extra orderings the two
    // multi-source vars get: an empty or short-circuited replay must not read
    // as a pass
    assert.equal(q.checks, 2727, `expected the full replay, got ${q.checks} states`);
    assert.equal(q.orderings, 21, `expected every dim + multi-source ordering, got ${q.orderings}`);
});

test("unlock table: canary — mutating <oneInEvery> moves the batch rows", () => {
    // Anti-vacuity for the quantity half. If the walk ignored <oneInEvery> and
    // used a hard-coded ratio, every assertion above would still pass.
    const start = xml.indexOf(`varName="Locks"`);
    const open = xml.indexOf("<oneInEvery>", start);
    const close = xml.indexOf("</oneInEvery>", open);
    assert.ok(open !== -1 && close !== -1);
    assert.equal(xml.slice(open + 12, close), "10");
    // 20 per batch over the same base-rate ceiling of 100 => 5 rows, not 10
    const mutated = xml.slice(0, open) + "<oneInEvery>20" + xml.slice(close);

    const dims = walkQuantityDims(ctx, mutated);
    assert.equal(dims.find(d => d.action === "Locks").oneInEvery, 20,
        "the walk did not read the mutated ratio");

    // and the provenance cross-check must reject it: the XML now disagrees
    // with the finishRegular(…, 10, …) the game really walks
    assert.throws(() => buildTable(ctx, mutated),
        /Locks: <oneInEvery> is 20 but finishRegular walks 10/);
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
