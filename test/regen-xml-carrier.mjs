// Regenerates data/actionListXml.data.js (the XML carrier) from
// data/actionList.xml.
//
// Why a carrier exists: with options.useActionListXml on, the sim needs the
// XML text synchronously at boot in all three contexts it boots in — the
// main window (<script> tags), predictor-worker.js and planner-worker.js
// (importScripts) — and none of those can load an .xml file synchronously.
// The XML therefore travels as this generated JS file assigning the text to
// globalThis.actionListXmlText. data/actionList.xml stays the source of
// truth (it is what the editor reads and what humans edit); the staleness
// guard in test/xml-wiring.test.mjs fails the suite whenever the two drift.
//
// Run: node test/regen-xml-carrier.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const xml = fs.readFileSync(path.join(ROOT, "data", "actionList.xml"), "utf8");
const out = `// AUTO-GENERATED from data/actionList.xml — do not edit by hand.
// Regenerate with: node test/regen-xml-carrier.mjs
// (see that script's header for why this carrier exists)
globalThis.actionListXmlText = ${JSON.stringify(xml)};
`;
fs.writeFileSync(path.join(ROOT, "data", "actionListXml.data.js"), out);
console.log(`wrote data/actionListXml.data.js (${xml.length} chars of XML)`);
