// Tier 0 shape invariants: every action's (name, varName, type, townNum,
// expMult, stats, affectedBy, allowed) frozen against a committed golden.
//
// This is the SAVE-COMPATIBILITY guard: `varName` keys live game state inside
// player saves (the Action constructor documents that many actions override
// it in extras precisely for save compatibility). A silent varName change
// corrupts every existing save. This test outlives actionList.js itself —
// keep it green through the XML migration and every substrate mod.
//
// To update the golden after a DELIBERATE content change:
//   node test/regen-action-shapes.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeContext } from "./harness.mjs";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "action-shapes.json");

test("action shapes match the committed golden", () => {
    const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
    const current = makeContext().actionShapes();

    assert.equal(current.length, golden.length,
        `action count changed: golden ${golden.length}, current ${current.length}`);

    const byName = new Map(golden.map(g => [g.name, g]));
    for (const a of current) {
        const g = byName.get(a.name);
        assert.ok(g, `action "${a.name}" is not in the golden (new action? regen deliberately)`);
        for (const field of ["varName", "type", "townNum", "expMult", "allowed"]) {
            assert.deepEqual(a[field], g[field],
                `"${a.name}".${field} changed: golden ${JSON.stringify(g[field])}, current ${JSON.stringify(a[field])}`
                + (field === "varName" ? "  <-- varName is SAVE-FORMAT-BREAKING" : ""));
        }
        for (const field of ["stats", "affectedBy"]) {
            assert.deepEqual(a[field], g[field], `"${a.name}".${field} changed`);
        }
    }
});
