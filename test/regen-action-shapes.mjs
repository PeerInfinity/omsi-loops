// Regenerate the action-shape golden after a DELIBERATE content change.
// Review the diff before committing — a varName change breaks player saves.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeContext } from "./harness.mjs";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "action-shapes.json");
fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
const shapes = makeContext().actionShapes();
fs.writeFileSync(goldenPath, JSON.stringify(shapes, null, 2) + "\n");
console.log(`wrote ${shapes.length} action shapes to ${goldenPath}`);
