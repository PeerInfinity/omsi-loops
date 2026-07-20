// regen-unlock-table.mjs — generate data/unlockTable.json from the structured
// <visible>/<unlocked>/<totalDiscovered> elements in data/actionList.xml.
//
// Run:  node test/regen-unlock-table.mjs
//
// Regenerate only after a DELIBERATE change to the XML conditions or to the
// adjust*() formulas, and review the diff — the table is a golden, and it is
// also the artifact the Archipelago side reads to build its location pool, so
// an unreviewed change here silently changes what a generated world contains.
//
// This script also runs the full verifier, because a table that has not been
// checked against the running game is not worth committing. Three legs:
//   1. the rows vs the live JS closures, over threshold-adjacent sweeps and a
//      seeded random corpus (the differential);
//   2. the same, over the three ui-parity save fixtures (real progressed
//      states, which catch anything the synthetic dim model gets wrong);
//   3. an independent extraction by perturbation-probing the closures,
//      compared structurally to the walked rows.
// Leg 3 shares no code and no input with the walk. That is the point: a
// verifier built on the generator's own assumptions verifies nothing.

import fs from "node:fs";
import {
    makeUnlockContext, readXml, buildTable, serializeTable, TABLE_PATH,
    verifyAgainstClosures, verifyAgainstFixtures, extractByProbing, compareWithProbe,
} from "./unlock-table.lib.mjs";

const t0 = performance.now();
const ctx = makeUnlockContext();
const xml = readXml();

const table = buildTable(ctx, xml);
console.log(`walked ${table.rows.length} predicate rows + ${table.quantities.length} quantity rows`);

const modes = {};
for (const r of table.rows) modes[r.mode] = (modes[r.mode] ?? 0) + 1;
console.log(`  modes: ${Object.entries(modes).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
const nonMonotone = table.rows.filter(r => !r.monotone);
console.log(`  non-monotone (never AP-eligible): ${nonMonotone.length ? nonMonotone.map(r => r.id).join(", ") : "none"}`);

let failures = 0;
const check = (ok, label, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
};

// --- leg 1: the differential against the live closures ---------------------
const v = verifyAgainstClosures(ctx, table.rows);
check(v.mismatches.length === 0,
    `rows === closures over ${v.checks.toLocaleString()} checks / ${v.states.toLocaleString()} states`,
    v.mismatches.slice(0, 5).map(m => `${m.id}@${m.state} row=${m.row} closure=${m.closure}`).join("; "));

// --- leg 2: real save fixtures ---------------------------------------------
const f = verifyAgainstFixtures(table.rows);
check(f.mismatches.length === 0,
    `rows === closures on the ${f.states} ui-parity save fixtures (${f.checks} checks)`,
    f.mismatches.slice(0, 5).map(m => `${m.id}@${m.state}`).join("; "));

// --- leg 3: independent extraction by probing ------------------------------
const probed = extractByProbing(ctx);
const cmp = compareWithProbe(table.rows, probed);
check(cmp.diffs.length === 0,
    `walked rows === probe-extracted rows (${cmp.compared} monotone rows, ${probed.evals.toLocaleString()} closure evals)`,
    cmp.diffs.slice(0, 5).map(d => `${d.id}: ${d.why}`).join("; "));
console.log(`      (${cmp.skippedNonMonotone} non-monotone row skipped — probing cannot see upper bounds; ` +
    `${cmp.redundantDropped} rows used the exploreProgress>=1 redundancy tolerance)`);

if (failures) {
    console.log(`\n${failures} FAILURE(S) — table NOT written`);
    process.exit(1);
}

// --- write, with a diff summary -------------------------------------------
const next = serializeTable(table);
const prev = fs.existsSync(TABLE_PATH) ? fs.readFileSync(TABLE_PATH, "utf8") : null;
if (prev === next) {
    console.log(`\nunchanged: ${TABLE_PATH}`);
} else {
    if (prev !== null) {
        const old = JSON.parse(prev);
        const ids = (t) => new Set([...t.rows, ...t.quantities].map(r => r.id));
        const before = ids(old), after = ids(table);
        const added = [...after].filter(x => !before.has(x));
        const removed = [...before].filter(x => !after.has(x));
        console.log(`\ndiff vs committed: ${added.length} added, ${removed.length} removed, ` +
            `${before.size - removed.length} carried over`);
        if (added.length) console.log(`  + ${added.slice(0, 20).join(", ")}${added.length > 20 ? " …" : ""}`);
        if (removed.length) console.log(`  - ${removed.slice(0, 20).join(", ")}${removed.length > 20 ? " …" : ""}`);
        console.log("  (row ids are a stability contract: rebalancing must not rename rows, and " +
            "removed ids are never recycled — review any +/- above carefully)");
    }
    fs.writeFileSync(TABLE_PATH, next);
    console.log(`wrote ${TABLE_PATH}`);
}
console.log(`\nALL CHECKS PASSED (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
