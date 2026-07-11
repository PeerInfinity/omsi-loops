// Regenerate the introspection golden (test/goldens/introspection.json).
//
// The golden freezes the answers of the three SOURCE-TEXT introspection sites
// (Action.teachesSkill's unlocked().toString() grep in actionList.js, and the
// finish().toString() greps for handleSkillExp / updateBuff in
// views/main.view.js) so they can be replaced by explicit metadata without
// changing behavior — and so the XML migration can later compile actions
// without silently breaking skill tooltips or the skills/buffs columns.
//
// This script derives the golden FROM the greps, so it only works while
// actionList.js still defines actions as hand-written JS. After the XML
// cutover the golden becomes hand-maintained (edit it alongside deliberate
// content changes, like action-shapes.json).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeContext } from "./harness.mjs";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "introspection.json");

const ctx = makeContext();
const rows = JSON.parse(ctx.ev(`JSON.stringify(totalActionList.map(a => {
    const unlockedSrc = a.unlocked ? a.unlocked.toString() : "";
    const finishSrc = a.finish ? a.finish.toString() : "";
    const skills = a.skills ? Object.keys(a.skills).sort() : null;
    // every skill referenced via getSkillLevel("X") in unlocked() source
    const unlockSkillRefs = [...new Set([...unlockedSrc.matchAll(/getSkillLevel\\("(\\w+)"\\)/g)].map(m => m[1]))].sort();
    // teachesSkill over the full skill list, at the loadDefaults() baseline
    const teaches = skillList.filter(sk => a.teachesSkill(sk)).sort();
    return {
        name: a.name,
        skills,
        unlockSkillRefs,
        finishGrantsSkillExp: finishSrc.includes("handleSkillExp"),
        finishGrantsBuff: finishSrc.includes("updateBuff"),
        teaches,
    };
}))`));

fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
fs.writeFileSync(goldenPath, JSON.stringify(rows, null, 2) + "\n");
console.log(`wrote introspection golden for ${rows.length} actions to ${goldenPath}`);
console.log(`  finishGrantsSkillExp: ${rows.filter(r => r.finishGrantsSkillExp).length}`);
console.log(`  finishGrantsBuff:     ${rows.filter(r => r.finishGrantsBuff).length}`);
console.log(`  with unlockSkillRefs: ${rows.filter(r => r.unlockSkillRefs.length).length}`);
