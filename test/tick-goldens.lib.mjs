// test/tick-goldens.lib.mjs — Tier-2 end-to-end tick goldens (XML migration
// plan §4 Phase 5) + the option-OFF vs option-ON tick differential.
//
// A fixture is persistent state (cheats/town exp/townsUnlocked — everything
// doSave() would carry) plus a queued action list, driven through the REAL
// engine loop (__stepLoop from test/harness.mjs) for a fixed number of
// steps under the seeded mulberry32 RNG. After every step the full state is
// hashed — including the reward surfaces __snapshot() alone misses
// (soulstones, dungeon ssChance/completed, trials, buffs, prestige values,
// loop counters) — so a divergence anywhere in a reward path moves the very
// next hash.
//
// Two gates consume the runs:
//   - the committed golden (test/goldens/tick-goldens.json) pins the JS
//     build against drift (regen: node test/regen-tick-goldens.mjs);
//   - the differential runs every fixture twice, option OFF (JS closures)
//     and option ON (actionListXml override applied to the live actions,
//     exactly what options.useActionListXml does), and requires
//     tick-for-tick hash equality.
//
// The §2.3 zero-ticks trap is closed twice: __stepLoop throws on a stalled
// step (0 mana spent without a restart) instead of swallowing, and every
// fixture asserts total mana spent > 0 plus a per-fixture probe proving the
// mechanism under test actually fired (soulstones gained, trial floors
// completed, survey exp granted...).
//
// RNG sites (all four Math.random call sites in actionList.js, verified
// 2026-07-16 — trials consume NO RNG, their floorReward is deterministic):
//   dungeon roll + dungeon stat pick   finishDungeon (~1703/1705) — `dungeon`
//   mine-soulstone stat pick           Mine Soulstones (~4223)    — `mine`
//                                      (the Divine-skill/prestige site)
//   survey zone pick                   exchangeMap (~6762)        — `survey`
// The `early` and `trial` fixtures assert rng === 0 — a pin, so a wiring
// change that starts consuming RNG on those paths fails loudly.
//
// doSave() does not persist mid-loop state (timer, resources, curTown), so
// per-loop needs (reputation gates, pickaxe, completedMap, mana budget,
// travel position) are injected by each fixture's `eachLoop` snippet right
// after every restart — deterministically, and identically in both arms.

import crypto from "node:crypto";
import { makeContext } from "./harness.mjs";
import { WIRED_FILES, WIRED_PREP } from "./field-matrix.lib.mjs";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

const TG_INSTALL = `
// dungeons/trials are populated by load(), not loadDefaults() — mirror
// load()'s fresh-init branch (same as FM_INSTALL in field-matrix.lib.mjs)
for (let i = 0; i < dungeons.length; i++) {
    dungeons[i].length = 0;
    for (let j = 0; j < dungeonFloors[i]; j++) dungeons[i][j] = { ssChance: 1, completed: 0, lastStat: "NA" };
}
for (let i = 0; i < trials.length; i++) {
    trials[i].length = 0;
    trials[i].highestFloor = 0;
    for (let j = 0; j < trialFloors[i]; j++) trials[i][j] = { completed: 0 };
}
function __tickState() {
    const extras = {
        timeNeeded, curTown, currentLoop,
        soulstones: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.soulstone ?? 0])),
        buffAmts: Object.fromEntries(Object.entries(buffs).map(([k, v]) => [k, v.amt])),
        dungeons: dungeons.map(d => d.map(f => [f.ssChance, f.completed, f.lastStat])),
        trials: trials.map(t => [t.highestFloor ?? 0, ...t.map(f => f.completed)]),
        prestigeValues, goldInvested, trainingLimits, stonesUsed,
        guild, effectiveTime, escapeStarted, portalUsed, stoneLoc, totalMerchantMana, hearts,
        skillLevels: Object.fromEntries(Object.entries(skills).map(([k, v]) => [k, [v.levelExp.level, v.levelExp.exp]])),
        loopCounters: towns.map(t => {
            const o = {};
            for (const v of t.allVarNames) {
                const k = v + "LoopCounter";
                if (typeof t[k] === "number") o[k] = t[k];
            }
            return o;
        }),
        guildSegments: [curAdvGuildSegment, curCraftGuildSegment, curWizCollegeSegment,
            curFightFrostGiantsSegment, curFightJungleMonstersSegment, curThievesGuildSegment, curGodsSegment],
    };
    return __snapshot() + "|" + JSON.stringify(extras);
}
`;

// Each fixture: recipe (persistent state), queue ([[name, reps]...]),
// eachLoop (deterministic per-loop injection, applied after every restart),
// steps × cap (mana per step), probe (in-vm expression whose value the
// golden records; minProbe asserts the mechanism fired), rng: "some"|"none".
export const TICK_FIXTURES = {
    early: {
        // fresh town 0, no cheats: the plain-vanilla tick path
        recipe: "",
        queue: [["Wander", 3], ["Smash Pots", 6]],
        eachLoop: "",
        steps: 60, cap: 100,
        probe: "towns[0].expWander + towns[0].goodTempPots",
        minProbe: 1,
        rng: "none",
    },
    dungeon: {
        // Small Dungeon (town 0): finishDungeon's soulstone roll + stat pick
        recipe: "cheatSkill('Combat', 500); cheatSkill('Magic', 500);",
        queue: [["Small Dungeon", 10]],
        eachLoop: "resources.reputation = 5; timeNeeded = 30000;",
        steps: 120, cap: 1000,
        probe: "Object.values(stats).reduce((a, s) => a + (s.soulstone ?? 0), 0)",
        minProbe: 1,
        rng: "some",
    },
    trial: {
        // Heroes Trial (town 2): the multipart trial machinery — floorReward
        // is deterministic (no RNG), asserted as such
        recipe: "cheatSkill('Combat', 200000); townsUnlocked = [0, 1, 2]; towns[2].expSurveyZ2 = 505000;",
        queue: [["Heroes Trial", 3]],
        eachLoop: "curTown = 2; timeNeeded = 2000000;",
        steps: 120, cap: 50000,
        probe: "trials[0].reduce((a, f) => a + f.completed, 0)",
        minProbe: 1,
        rng: "none",
    },
    mine: {
        // Mine Soulstones (town 3): the Divine-skill soulstone site's stat pick
        recipe: "townsUnlocked = [0, 1, 2, 3]; towns[3].expCavern = 505000;",
        queue: [["Mine Soulstones", 20]],
        eachLoop: "curTown = 3; resources.pickaxe = true; timeNeeded = 200000;",
        steps: 120, cap: 5000,
        probe: "Object.values(stats).reduce((a, s) => a + (s.soulstone ?? 0), 0)",
        minProbe: 1,
        rng: "some",
    },
    survey: {
        // Explorers Guild (town 7): exchangeMap's random-zone survey grants
        recipe: "townsUnlocked = [0, 1, 2, 3, 4, 5, 6, 7]; towns[7].expExcursion = 505000; towns[0].expSurveyZ0 = 5050;",
        queue: [["Explorers Guild", 1]],
        eachLoop: "curTown = 7; resources.completedMap = 4; timeNeeded = 100000;",
        steps: 40, cap: 5000,
        probe: "towns.reduce((a, t, i) => a + t['expSurveyZ' + i], 0)",
        minProbe: 5051,
        rng: "some",
    },
};

export const TICK_SEED = 424242;

/**
 * Run one fixture through the real engine, hashing after every step.
 * @param {object} fix  a TICK_FIXTURES entry
 * @param {object} [opts]
 * @param {boolean} [opts.wired]  apply the actionListXml override (option ON)
 * @param {string} [opts.xmlText]  override the carrier's XML (canary hook)
 */
export function runTickFixture(fix, { wired = false, xmlText = null } = {}) {
    const ctx = makeContext(TICK_SEED, wired ? WIRED_FILES : []);
    if (wired) {
        // exactly what the load-time option handler does
        ctx.ev("options.useActionListXml = true");
        if (xmlText) {
            ctx.sandbox.__tgXml = xmlText;
            ctx.ev("{ const r = ActionListXml.applyOverrides(__tgXml); if (!r || r.applied !== r.total) throw new Error('applyOverrides failed'); }");
        } else {
            ctx.ev(WIRED_PREP);
        }
    }
    ctx.ev(TG_INSTALL);
    if (fix.recipe) ctx.ev(fix.recipe);
    // load() runs adjustAll() once after restoring state; without it the
    // limited-action ledgers (totalMineSoulstones, ...) stay undefined
    ctx.ev("adjustAll()");
    ctx.setQueue(fix.queue);
    ctx.restart();
    if (fix.eachLoop) ctx.ev(fix.eachLoop);
    const hashes = [];
    let loops = 0, totalMana = 0;
    const rng0 = ctx.rngCount();
    for (let i = 0; i < fix.steps; i++) {
        const r = ctx.step(fix.cap ?? 0);
        totalMana += r.spent;
        if (r.ended) {
            loops++;
            if (fix.eachLoop) ctx.ev(fix.eachLoop);
        }
        hashes.push(sha(ctx.ev("__tickState()")));
    }
    return {
        hashes,
        finalHash: hashes[hashes.length - 1],
        seqHash: sha(hashes.join("\n")),
        steps: fix.steps,
        loops,
        totalMana,
        rng: ctx.rngCount() - rng0,
        probe: fix.probe ? ctx.ev(fix.probe) : null,
    };
}

/** golden-shaped summary of a run (what regen commits) */
export function summarize(run) {
    return {
        steps: run.steps, loops: run.loops, totalMana: run.totalMana,
        rng: run.rng, probe: run.probe,
        finalHash: run.finalHash, seqHash: run.seqHash,
    };
}
