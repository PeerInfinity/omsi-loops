// Regenerate test/goldens/slot-manifest.json — the frozen per-slot record of
// which of the 157 actions have each effect slot compiled from XML (and which
// are explicitly native). Phase 6 lands slot by slot; this is what makes each
// slice's claim about coverage checkable instead of asserted.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./harness.mjs";
import { buildEffectDifferential, slotManifest } from "./effect-differential.lib.mjs";

const r = buildEffectDifferential({ onlyStates: ["boot"] });
const out = path.join(ROOT, "test", "goldens", "slot-manifest.json");
fs.writeFileSync(out, JSON.stringify(slotManifest(r.plan), null, 2) + "\n");
console.log("wrote", out, JSON.stringify(slotManifest(r.plan).counts));
