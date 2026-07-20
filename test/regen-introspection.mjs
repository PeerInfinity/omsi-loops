// Regenerate the introspection golden (test/goldens/introspection.json).
//
// The golden freezes the answers of the three SOURCE-TEXT introspection sites
// (Action.teachesSkill's unlocked().toString() grep in actionList.js, and the
// finish().toString() greps for handleSkillExp / updateBuff in
// views/main.view.js) so they can be replaced by explicit metadata without
// changing behavior — and so the XML migration can later compile actions
// without silently breaking skill tooltips or the skills/buffs columns.
//
// TWO COLUMNS ARE FROZEN HISTORY AND ARE CARRIED FORWARD, NOT RECOMPUTED:
//
//   unlockSkillRefs  — its grep read getSkillLevel("X") out of unlocked()
//                      source. The unlock cutover (2026-07-19) deleted those
//                      closures, so the grep now answers [] for every action.
//   finishGrantsBuff — its grep read updateBuff out of finish() source. The
//                      view-subscribe refactor (2026-07-18) moved buff
//                      refreshes to addBuffAmt's notification, so it answers
//                      false for actions that do grant buffs.
//
// Both are still LIVE GUARDS: the test asserts the metadata that replaced them
// (skillPrereqs, grantsBuff) answers exactly what the grep answered when it
// was frozen. Recomputing them from today's source would quietly overwrite
// that record with empty/false and disarm those assertions while leaving the
// suite green — the failure mode a golden exists to prevent. The remaining
// columns are still derived from the live game.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeContext } from "./harness.mjs";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "introspection.json");

const frozen = new Map(JSON.parse(fs.readFileSync(goldenPath, "utf8"))
    .map(g => [g.name, { unlockSkillRefs: g.unlockSkillRefs, finishGrantsBuff: g.finishGrantsBuff }]));

const ctx = makeContext();
const rows = JSON.parse(ctx.ev(`JSON.stringify(totalActionList.map(a => {
    const finishSrc = a.finish ? a.finish.toString() : "";
    const skills = a.skills ? Object.keys(a.skills).sort() : null;
    // teachesSkill over the full skill list, at the loadDefaults() baseline
    const teaches = skillList.filter(sk => a.teachesSkill(sk)).sort();
    return {
        name: a.name,
        skills,
        finishGrantsSkillExp: finishSrc.includes("handleSkillExp"),
        teaches,
    };
}))`));

const out = rows.map(r => {
    const f = frozen.get(r.name);
    if (!f) throw new Error(`introspection: "${r.name}" is new; add its frozen columns by hand ` +
        `(unlockSkillRefs from its unlock condition, finishGrantsBuff from whether it grants a buff)`);
    return {
        name: r.name,
        skills: r.skills,
        unlockSkillRefs: f.unlockSkillRefs,
        finishGrantsSkillExp: r.finishGrantsSkillExp,
        finishGrantsBuff: f.finishGrantsBuff,
        teaches: r.teaches,
    };
});

fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
fs.writeFileSync(goldenPath, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote introspection golden for ${out.length} actions to ${goldenPath}`);
console.log(`  finishGrantsSkillExp: ${out.filter(r => r.finishGrantsSkillExp).length}  (derived)`);
console.log(`  finishGrantsBuff:     ${out.filter(r => r.finishGrantsBuff).length}  (frozen, carried forward)`);
console.log(`  with unlockSkillRefs: ${out.filter(r => r.unlockSkillRefs.length).length}  (frozen, carried forward)`);
