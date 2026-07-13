// Regenerate the town-0 candidate golden after a DELIBERATE sizing change.
// This MUST reproduce, byte-for-byte, the construction in planner.test.mjs's
// "inertness: candidate labels+queues at townsUnlocked=[0] equal the v0
// golden" test — it is the authoritative capture. Review the diff before
// committing (Part A §11.9: A1's un-gated [0] capacity probe grows the
// cushion-chunked economy queues; A2 may add an optimistic h-variant).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeContext } from "./harness.mjs";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "candidates-town0.json");
const j = (x) => JSON.parse(JSON.stringify(x));

const ctx = makeContext(31337, ["planner-metadata.js", "planner.js"]);
ctx.sandbox.__rngGet = ctx.getRng;
ctx.sandbox.__rngSet = ctx.setRng;
ctx.ev("IdlePlanner.setRngHooks({ get: __rngGet, set: __rngSet })");
const sess = ctx.ev("new IdlePlanner.Session()");
const IP = ctx.ev("IdlePlanner");
const play = (queues) => { for (const q of queues) { sess.setQueue(q); sess.restart(); sess.runLoop(); } };
play(Array.from({ length: 12 }, () => [["Wander", 5], ["Smash Pots", 6]]));
play(Array.from({ length: 12 }, (_, i) => [["Wander", 3 + (i % 3)], ["Smash Pots", 8]]));

const states = [
    ["plain", null],
    ["travelReady", () => {
        const th = sess.probe();
        for (const name of ["Start Journey", "Buy Supplies"])
            for (const r of th[name]?.requires ?? [])
                ctx.ev(`skills[${JSON.stringify(r.v)}].levelExp.level = ${r.need}`);
        ctx.ev("adjustAll()");
    }],
];

const golden = {};
for (const [key, prep] of states) {
    if (prep) prep();
    const pre = sess.read();
    const snap = sess.save();
    const thresholds = sess.probe();
    const P = IP.newPlanningState();
    await IP.refreshKnowledge(sess, snap, pre, P.know, {});
    sess.restore(snap);
    const cands = IP.generateCandidates(pre, P.know, thresholds, sess, [["Wander", 3]]);
    golden[key] = j(cands.map(c => ({ label: c.label, q: c.q })));
    sess.restore(snap);
}

fs.writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + "\n");
console.log(`wrote candidate golden to ${goldenPath}`);
for (const key of Object.keys(golden))
    console.log(`  ${key}: ${golden[key].map(c => c.label).join(", ")}`);
