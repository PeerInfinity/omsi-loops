// Regenerate the Tier-1 field-matrix golden (test/goldens/field-matrix.json).
//
// The golden pins the declarative-field values of all 157 actions across the
// deterministic state corpus (see field-matrix.lib.mjs). It is the Phase-3
// oracle for the XML migration: Phase 4's JS-vs-XML differential replays the
// same corpus, and this file catches drift in the JS reference itself.
//
// While actionList.js is still the source of truth, regenerating after a
// deliberate content change is the way to update it — same convention as
// regen-action-shapes.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFieldMatrix } from "./field-matrix.lib.mjs";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "field-matrix.json");

const t0 = performance.now();
const m = buildFieldMatrix();
if (m.rngConsumed !== 0) {
    console.error(`FATAL: declarative fields consumed ${m.rngConsumed} Math.random() calls — they must be pure`);
    process.exit(1);
}

fs.writeFileSync(goldenPath, JSON.stringify({
    meta: m.meta,
    matrixHash: m.matrixHash,
    perState: m.perState,
    // human-readable sample: the full boot-state row per action
    bootSample: m.baseline,
}, null, 1) + "\n");

console.log(`wrote field-matrix golden: ${m.meta.states} states × ${m.meta.predicates / 2} actions`);
console.log(`  probe evals: ${m.meta.probeEvals} · matrixHash: ${m.matrixHash}`);
console.log(`  wall: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
