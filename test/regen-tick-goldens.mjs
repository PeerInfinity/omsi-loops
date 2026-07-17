// Regenerates test/goldens/tick-goldens.json from the JS build (option OFF).
// Run after a deliberate content change: node test/regen-tick-goldens.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TICK_FIXTURES, TICK_SEED, runTickFixture, summarize } from "./tick-goldens.lib.mjs";

const golden = { seed: TICK_SEED, fixtures: {} };
for (const [name, fix] of Object.entries(TICK_FIXTURES)) {
    const run = runTickFixture(fix);
    golden.fixtures[name] = summarize(run);
    console.log(name, JSON.stringify(golden.fixtures[name]));
}
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "tick-goldens.json");
fs.writeFileSync(out, JSON.stringify(golden, null, 1) + "\n");
console.log(`wrote ${out}`);
