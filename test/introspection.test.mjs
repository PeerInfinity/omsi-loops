// Introspection-site guard (XML-migration Phase 1).
//
// Three upstream sites decide view behavior by grepping FUNCTION SOURCE TEXT:
//   - actionList.js Action.teachesSkill: unlocked().toString() regex per skill
//     (drives "Learn skill" tooltip sections);
//   - views/main.view.js updateSkills-column gate: finish().toString()
//     .includes("handleSkillExp");
//   - views/main.view.js updateBuffs-column gate: finish().toString()
//     .includes("updateBuff").
// The moment unlocked/finish become closures compiled from XML, all three
// silently return the wrong answer. This test freezes their answers in a
// committed golden so explicit metadata can replace them provably
// behavior-neutrally, and so the XML build can be held to the same answers.
//
// To update the golden after a DELIBERATE content change:
//   node test/regen-introspection.mjs   (grep-derived; JS-source era only)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeContext } from "./harness.mjs";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "goldens", "introspection.json");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));

function currentRows(ctx) {
    return JSON.parse(ctx.ev(`JSON.stringify(totalActionList.map(a => {
        const unlockedSrc = a.unlocked ? a.unlocked.toString() : "";
        const finishSrc = a.finish ? a.finish.toString() : "";
        return {
            name: a.name,
            skills: a.skills ? Object.keys(a.skills).sort() : null,
            unlockSkillRefs: [...new Set([...unlockedSrc.matchAll(/getSkillLevel\\("(\\w+)"\\)/g)].map(m => m[1]))].sort(),
            finishGrantsSkillExp: finishSrc.includes("handleSkillExp"),
            finishGrantsBuff: finishSrc.includes("updateBuff"),
            teaches: skillList.filter(sk => a.teachesSkill(sk)).sort(),
        };
    }))`));
}

test("explicit metadata matches the golden's grep-frozen answers", () => {
    // The metadata that replaced the greps (skillPrereqs, grantsSkillExp,
    // grantsBuff) must answer exactly what the source-text greps answered
    // when the golden was frozen.
    const rows = JSON.parse(makeContext().ev(`JSON.stringify(totalActionList.map(a => ({
        name: a.name,
        skillPrereqs: [...(a.skillPrereqs ?? [])].sort(),
        grantsSkillExpPredicate: a.grantsSkillExp ?? a.skills !== undefined,
        grantsBuffPredicate: a.grantsBuff !== undefined,
    })))`));
    const byName = new Map(golden.map(g => [g.name, g]));
    for (const a of rows) {
        const g = byName.get(a.name);
        assert.ok(g, `action "${a.name}" is not in the golden`);
        assert.deepEqual(a.skillPrereqs, g.unlockSkillRefs,
            `"${a.name}".skillPrereqs disagrees with the frozen unlocked() skill refs`);
        assert.equal(a.grantsSkillExpPredicate, g.finishGrantsSkillExp,
            `"${a.name}" skills-column predicate disagrees with the frozen handleSkillExp grep`);
        assert.equal(a.grantsBuffPredicate, g.finishGrantsBuff,
            `"${a.name}" buffs-column predicate disagrees with the frozen updateBuff grep`);
    }
});

test("teachesSkill and the view-column predicates match the committed golden", () => {
    const current = currentRows(makeContext());
    assert.equal(current.length, golden.length,
        `action count changed: golden ${golden.length}, current ${current.length}`);
    const byName = new Map(golden.map(g => [g.name, g]));
    for (const a of current) {
        const g = byName.get(a.name);
        assert.ok(g, `action "${a.name}" is not in the golden (new action? regen deliberately)`);
        assert.deepEqual(a.teaches, g.teaches, `"${a.name}".teachesSkill answers changed`);
        // source-grep oracles — these three mirror the upstream introspection
        // sites verbatim and stay valid while actionList.js is JS source
        assert.deepEqual(a.unlockSkillRefs, g.unlockSkillRefs, `"${a.name}" unlocked() skill refs changed`);
        assert.equal(a.finishGrantsSkillExp, g.finishGrantsSkillExp, `"${a.name}" finish() handleSkillExp grep changed`);
        // The finish()/updateBuff grep is RETIRED (view-subscribe refactor,
        // 2026-07-18). It is dead for exactly the reason Phase 1 predicted for
        // the XML cutover: buff displays now refresh from addBuffAmt's own
        // notification, so finish() bodies no longer name updateBuff and the
        // grep answers false for actions that do grant buffs. The `grantsBuff`
        // metadata that replaced it at the real view site is still checked
        // against this same golden by the test above — that assertion, not this
        // one, is the live guard. The golden's frozen column is deliberately
        // left in place as the historical record of what the grep answered.
        assert.deepEqual(a.skills, g.skills, `"${a.name}".skills keys changed`);
    }
});
