// Tier-1 declarative-field equivalence matrix (XML migration Phase 3).
//
// Regenerates the full deterministic state corpus and compares it against the
// committed golden (test/goldens/field-matrix.json). Any drift in
// manaCost/goldCost/visible/unlocked/canStart/allowed/storyReqs across the
// corpus fails here with the exact state id that moved. Phase 4's JS-vs-XML
// differential replays this same corpus with === comparison.
//
// Regen after a deliberate content change: node test/regen-field-matrix.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFieldMatrix } from "./field-matrix.lib.mjs";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "field-matrix.json");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));

test("field matrix matches the committed golden (full corpus)", () => {
    const m = buildFieldMatrix();
    assert.equal(m.rngConsumed, 0,
        "declarative fields must be pure — they consumed Math.random()");
    assert.equal(m.meta.states, golden.meta.states, "state-corpus size changed");
    const goldenByState = new Map(golden.perState.map(s => [s.id, s.hash]));
    for (const s of m.perState) {
        assert.equal(s.hash, goldenByState.get(s.id), `field drift in state '${s.id}'`);
    }
    assert.equal(m.matrixHash, golden.matrixHash, "matrix hash drifted");
});

test("matrix is not vacuous: a perturbed state changes its hash", () => {
    // raise dim 0 to an arbitrary level inside the boot state — the recorded
    // fields must move, proving the corpus actually reaches the closures
    const m = buildFieldMatrix({ only: ["boot"], perturb: { id: "boot", dim: 0, level: 37 } });
    const bootGolden = golden.perState.find(s => s.id === "boot");
    assert.equal(m.perState.length, 1);
    assert.notEqual(m.perState[0].hash, bootGolden.hash,
        "perturbing game state did not change the recorded fields — the matrix is measuring nothing");
});
