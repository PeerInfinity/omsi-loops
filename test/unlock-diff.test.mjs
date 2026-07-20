// unlock-diff.test.mjs — the dim index and the diff pass (plan §5.3).
//
// The index is the load-bearing half: check(dims) only re-evaluates the rows
// the index hands it, so a row missing from its own dim's bucket is a row that
// silently stops being noticed. Both directions are asserted — every row
// reachable from every dim it reads, and no key in the index that no row reads.
//
// Nothing consumes the pass yet (U2 slice A); these tests pin the mechanism.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

const ctx = makeContext(12345);
const ev = (expr) => JSON.parse(ctx.ev(`JSON.stringify(${expr})`));

// makeContext already builds `towns`, which is all the lazy walk needs; the
// harness has no load() (it is a sim context, not a page).

test("dim index: every row is reachable from every dim it reads", () => {
    const problems = ev(`(() => {
        const index = Unlocks.getDimIndex();
        const rows = [...Unlocks.getRows(), ...Unlocks.getQuantityRows()];
        const problems = [];
        for (const row of rows) {
            // recompute the row's dims independently of the index build, via
            // the shapes the table itself carries
            const keys = new Set();
            if (row.trigger !== undefined) {
                for (const k of Unlocks.getDimIndex().keys()) {
                    // quantity rows: the progress keys naming their own dims
                    for (const v of row.dims) if (k.endsWith(":" + v)) keys.add(k);
                }
            } else {
                for (const c of row.requires) {
                    if (c.kind === "townLevel" || c.kind === "surveyLevel") keys.add("progress:" + c.town + ":" + c.v);
                    else if (c.kind === "skillLevel") keys.add("skill:" + c.v);
                    else if (c.kind === "skillSum") for (const v of c.vs) keys.add("skill:" + v);
                    else if (c.kind === "buffLevel") keys.add("buff:" + c.v);
                    else if (c.kind === "storyFlag") keys.add("storyFlag:" + c.v);
                    else if (c.kind === "storyMax") keys.add("storyMax");
                    else if (c.kind === "prestige") keys.add("prestige");
                    else if (c.kind === "exploreProgress") {
                        for (const t of towns) for (const v of t.progressVars) {
                            if (v.startsWith("SurveyZ")) keys.add("progress:" + t.index + ":" + v);
                        }
                    } else problems.push(row.id + ": test does not model clause kind " + c.kind);
                }
            }
            for (const k of keys) {
                const bucket = index.get(k) ?? [];
                if (!bucket.some(r => r.id === row.id)) problems.push(row.id + " is missing from index key " + k);
            }
        }
        return problems;
    })()`);
    assert.deepEqual(problems, []);
});

test("dim index: no orphan keys, and constant rows are indexed nowhere", () => {
    const info = ev(`(() => {
        const index = Unlocks.getDimIndex();
        const rows = [...Unlocks.getRows(), ...Unlocks.getQuantityRows()];
        const ids = new Set(rows.map(r => r.id));
        const orphanKeys = [], unknownRows = [];
        for (const [k, bucket] of index) {
            if (!bucket.length) orphanKeys.push(k);
            for (const r of bucket) if (!ids.has(r.id)) unknownRows.push(k + " -> " + r.id);
        }
        // ALWAYS/NEVER rows read no dims: they are constant, so a partial pass
        // must never waste work on them (the full pass at load covers them)
        const indexed = new Set();
        for (const bucket of index.values()) for (const r of bucket) indexed.add(r.id);
        const constantIndexed = rows.filter(r => (r.mode === "ALWAYS" || r.mode === "NEVER") && indexed.has(r.id));
        return { orphanKeys, unknownRows, constantIndexed: constantIndexed.map(r => r.id), keys: index.size };
    })()`);
    assert.deepEqual(info.orphanKeys, []);
    assert.deepEqual(info.unknownRows, []);
    assert.deepEqual(info.constantIndexed, [], "ALWAYS/NEVER rows have no dims and must not be indexed");
    assert.ok(info.keys > 50, `expected a real index, got ${info.keys} keys`);
});

test("diff pass: a partial check sees exactly what a full check sees", () => {
    // The soundness claim behind the index: re-evaluating only the rows that
    // read a moved dim reaches the same state as re-evaluating everything.
    // Drive Wander to level 22 one level at a time through the real
    // finishProgress funnel, then compare against a full pass.
    const result = ev(`(() => {
        Unlocks.check();                       // baseline
        const town = towns[0];
        // exp for level 22 on the quadratic scaling, added in one gulp per level
        for (let L = 1; L <= 22; L++) {
            const target = 100 * L * (L + 1) / 2;
            town.finishProgress("Wander", target - town.expWander);
        }
        const afterIncremental = [...Unlocks.achieved].sort();
        Unlocks.check();                       // full pass over every row
        const afterFull = [...Unlocks.achieved].sort();
        return { afterIncremental, afterFull, level: town.getLevel("Wander") };
    })()`);
    assert.equal(result.level, 22);
    assert.deepEqual(result.afterIncremental, result.afterFull,
        "the dim-indexed pass missed rows a full pass caught");

    // and it really did move: the Wander-20/22 milestones are in the set
    for (const id of ["u:BuyGlasses", "u:BuyManaZ1", "u:Locks", "u:Met", "q:0:Pots:1", "q:0:Locks:1"]) {
        assert.ok(result.afterFull.includes(id), `${id} should be achieved at Wander 22`);
    }
});

test("diff pass: quantity rows evaluate at BASE rates, not the inflated total", () => {
    // A survey bonus inflates the displayed total; it must NOT hand the player
    // a batch location early (plan §3.5 — triggers are base-rate).
    const r = ev(`(() => {
        const town = towns[0];
        town.expWander = 100 * 10 * 11 / 2;   // Wander 10 => base Pots 50
        adjustAll();
        const baseBefore = Unlocks.quantityBaseTotal(Unlocks.getQuantityRows().find(q => q.id === "q:0:Pots:1"));
        const totalBefore = town.totalPots;
        // grant survey progress: adjustAll() inflates totalPots, base is fixed
        town.expSurveyZ0 = 5050 * 100;
        adjustAll();
        return { baseBefore, totalBefore, baseAfter: Unlocks.quantityBaseTotal(
            Unlocks.getQuantityRows().find(q => q.id === "q:0:Pots:1")), totalAfter: town.totalPots };
    })()`);
    assert.equal(r.baseBefore, 50);
    assert.equal(r.baseAfter, 50, "survey progress must not move the base-rate total");
    assert.ok(r.totalAfter > r.totalBefore, "the LIVE total should have been inflated by the survey bonus");
});
