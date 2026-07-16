// JS-vs-XML differential (XML migration Phase 4).
//
// actionList.js is the oracle: every action defined in data/actionList.xml is
// compiled by actionListXml.js and compared field-by-field against its
// hand-written JS implementation across the full Phase-3 state corpus
// (thresholds + random sweeps + load() fixtures). Numeric fields compare ===,
// boolean fields by truthiness, missing fields never equal present ones.
//
// The perturbation canaries are the anti-vacuity stratum (the JtA gate
// triple's third leg): a NON-vanilla value in the XML must produce a
// divergence, proving the XML data path is live for that action — a compiled
// field that silently fell back to JS would pass the equality gate vacuously.
import test from "node:test";
import assert from "node:assert/strict";
import { buildXmlDifferential } from "./field-matrix.lib.mjs";

test("every XML-defined action matches its JS implementation across the corpus", () => {
    const d = buildXmlDifferential();
    assert.ok(d.names.length >= 4, `expected at least the 4 upstream-migrated actions, got ${d.names.length}`);
    assert.equal(d.rngConsumed, 0, "the differential must not consume RNG");
    assert.deepEqual(d.statics, [], "static field mismatches (varName/townNum/type/expMult/stats/affectedBy)");
    assert.deepEqual(d.mismatches, [],
        `field mismatches JS vs XML (first: ${JSON.stringify(d.mismatches[0])})`);
});

test("canary: a non-vanilla effortCost diverges for every migrated action", () => {
    // discover the migrated set once, cheaply
    const names = buildXmlDifferential({ probe: false, randomStates: 0, fixtures: false }).names;
    for (const name of names) {
        const d = buildXmlDifferential({
            probe: false, randomStates: 4, fixtures: false, maxMismatches: 1,
            mutate: (doc) => {
                const ec = doc.actions[name].children.find(c => c.tag === "effortCost");
                if ("value" in ec.attrs) ec.attrs.value = String(Number(ec.attrs.value) + 1);
                else ec.text = String(Number(ec.text.trim()) + 1);
            },
        });
        assert.ok(d.mismatches.some(m => m.name === name && m.col === "manaCost"),
            `${name}: effortCost+1 in the XML produced no manaCost divergence — its XML path is dead`);
    }
});

test("canary: a non-vanilla unlock threshold diverges (Pick Locks, Wander 20 -> 21)", () => {
    const d = buildXmlDifferential({
        maxMismatches: 5,
        mutate: (doc) => {
            const unlocked = doc.actions["Pick Locks"].children.find(c => c.tag === "unlocked");
            unlocked.children.find(c => c.tag === "ifProgress").attrs.min = "21";
        },
    });
    assert.ok(d.mismatches.some(m => m.name === "Pick Locks" && m.col === "unlocked"),
        "threshold mutation produced no unlocked divergence — the corpus does not straddle the threshold");
});
