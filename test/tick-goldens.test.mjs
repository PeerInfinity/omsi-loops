// Tier-2 end-to-end tick goldens (XML migration plan §4 Phase 5).
//
// Two gates per fixture (see tick-goldens.lib.mjs for the fixture design):
//   1. the JS build (option OFF) must reproduce the committed golden —
//      per-step sequence hash, final hash, loop count, RNG consumption and
//      the per-fixture mechanism probe (regen after a deliberate change:
//      node test/regen-tick-goldens.mjs);
//   2. option OFF vs option ON (actionListXml override on the live actions)
//      must be tick-for-tick hash-identical — the Tier-2 XML gate.
// Anti-vacuity: total mana spent > 0 (the §2.3 zero-ticks trap), probe >=
// minProbe (the mechanism under test actually fired), rng > 0 for the
// RNG-site fixtures and rng === 0 for the deterministic ones (a pin).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TICK_FIXTURES, runTickFixture, summarize } from "./tick-goldens.lib.mjs";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "tick-goldens.json");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));

test("canary: a mutated XML value diverges the tick stream", () => {
    // Wander effortCost 250 -> 251 (the first occurrence in the file is
    // Wander's); the early fixture queues Wander, so its mana consumption —
    // and every hash after step 1 — must move. Proves the tick gate is
    // watching the wired engine, not two copies of the JS build.
    const xmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "actionList.xml");
    const xml = fs.readFileSync(xmlPath, "utf8");
    const mutated = xml.replace('<effortCost value="250"/>', '<effortCost value="251"/>');
    assert.notEqual(mutated, xml, "mutation target not found");
    const off = runTickFixture(TICK_FIXTURES.early);
    const on = runTickFixture(TICK_FIXTURES.early, { wired: true, xmlText: mutated });
    assert.notEqual(on.seqHash, off.seqHash,
        "a mutated manaCost produced an identical tick stream — the tick gate cannot see the override");
});

for (const [name, fix] of Object.entries(TICK_FIXTURES)) {
    test(`tick golden: ${name} (JS build matches golden; option ON tick-identical)`, () => {
        const off = runTickFixture(fix);

        // anti-vacuity before anything else
        assert.ok(off.totalMana > 0, "zero mana spent — the fixture never ticked (§2.3 trap)");
        assert.ok(off.probe >= fix.minProbe,
            `probe ${off.probe} < ${fix.minProbe} — the ${name} mechanism never fired`);
        if (fix.rng === "some") {
            assert.ok(off.rng > 0, `expected RNG consumption on the ${name} reward path, got 0`);
        } else {
            assert.equal(off.rng, 0, `the ${name} path is deterministic — it consumed RNG`);
        }

        // gate 1: JS build vs committed golden
        assert.deepEqual(summarize(off), golden.fixtures[name],
            "JS build drifted from the committed tick golden (deliberate change? node test/regen-tick-goldens.mjs)");

        // gate 2: option OFF vs option ON, tick-for-tick
        const on = runTickFixture(fix, { wired: true });
        assert.equal(on.hashes.length, off.hashes.length);
        for (let i = 0; i < off.hashes.length; i++) {
            assert.equal(on.hashes[i], off.hashes[i],
                `tick divergence at step ${i + 1}/${off.hashes.length} (loops so far: ${off.loops})`);
        }
        assert.equal(on.rng, off.rng, "option ON consumed a different amount of RNG");
        assert.equal(on.loops, off.loops);
        assert.equal(on.totalMana, off.totalMana);
    });
}
