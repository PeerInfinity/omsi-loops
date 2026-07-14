// metadata-census — the INDEPENDENT stratum for the planner vocabulary
// (vocabulary plan §4). It re-extracts effect verbs from the LIVE action reward
// code and asserts every extracted effect site is covered by a measured channel,
// a dimEffects/context declaration, or an explicit allowlist. A hand-authored
// metadata table rots silently; this guard reads the CODE — not the metadata it
// validates — so any new reward mechanism (upstream sync, fork edit) becomes a
// TEST FAILURE rather than a blind spot. It shares no assumptions with the
// metadata author: it walks totalActionList, captures each reward method's
// source, and tags effect verbs (the census's mechanical-extraction method;
// ACTION-CENSUS.md §1 — the original script was scratchpad-only and lost).

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

// Reward-path methods whose bodies write game state.
const REWARD_METHODS = ["finish", "segmentFinished", "loopsFinished", "floorReward"];

// Effect-verb-shaped call detector: a mutation-verb prefix + CamelCase, before
// an open paren. Deliberately broad — a NEW helper shaped like a reward writer
// must be classified in VERB_COVERAGE below or this guard fails.
const VERB_RE = /\b(add|finish|unlock|sacrifice|adjust|increase|gain|grant|spend|consume|set|give|remove|take|apply|exchange|handle)[A-Z][A-Za-z0-9]*(?=\s*\()/g;

// Every reward verb found in the live code, classified. Categories:
//   measured  — an empirical measureAction channel captures its effect
//   declared  — measured grant + a dimEffects edge names the downstream channel
//   allowlist — deliberately uncovered (story flags gate other actions;
//               probeable:false, census 2.2e — scoring is out of v1 scope)
const VERB_COVERAGE = {
    addMana: "measured",               // manaPerExec
    addResource: "measured",           // grants / consumes (Layer E)
    handleSkillExp: "measured",        // skillExpPerExec
    finishProgress: "measured",        // progressExpPerExec
    finishRegular: "measured",         // limited-pool harvest (bank / bankPot)
    unlockTown: "measured",            // town term
    finishDungeon: "measured",         // dungeon floors persistentDelta (Layer E)
    floorReward: "measured",           // dungeon/trial persistentDelta + grants
    addSoulstones: "measured",         // actionLog mirror of the soulstone += grant (persistentDelta)
    sacrificeSoulstones: "measured",   // soulstone consume (persistentDelta)
    setLevel: "measured",              // talentLevelExp.setLevel — talentPerExec (Imbue Body/Soul talent spend)
    adjustTrainingExpMult: "measured", // trainingLimits recompute (Imbue Mind; persistentDelta)
    exchangeMap: "measured",           // cross-town survey exp (crossTown{})
    adjustRocks: "measured",           // cross-town stone pools (crossTown{}) + consumes
    adjustAll: "measured",             // game-wide pool resize (crossTown{} / Spatiomancy poolSize)
    addBuffAmt: "declared",            // buffs persistentDelta + dimEffects buff:X downstream
    setStoryFlag: "allowlist",         // story flags gate other actions (probeable:false)
    unlockGlobalStory: "allowlist",
    increaseStoryVarTo: "allowlist",
};

function rewardSources(ctx) {
    const list = ctx.ev("totalActionList");
    return list.map(a => {
        let src = "";
        for (const m of REWARD_METHODS)
            if (typeof a[m] === "function") src += "\n" + Function.prototype.toString.call(a[m]);
        return { name: a.name, src };
    });
}
const meta = (ctx, key) => JSON.parse(ctx.ev(`JSON.stringify(PLANNER_METADATA.${key})`));

test("drift guard: every reward-path effect verb is classified", () => {
    const ctx = makeContext(1, ["planner-metadata.js"]);
    const unclassified = new Map();
    for (const { name, src } of rewardSources(ctx)) {
        let m; VERB_RE.lastIndex = 0;
        while ((m = VERB_RE.exec(src))) {
            const verb = m[0];
            if (verb in VERB_COVERAGE) continue;
            if (!unclassified.has(verb)) unclassified.set(verb, new Set());
            unclassified.get(verb).add(name);
        }
    }
    assert.equal(unclassified.size, 0,
        "unclassified reward verb(s) — a new reward mechanism appeared; classify it in " +
        "VERB_COVERAGE and add the matching measured channel / dimEffects / context entry:\n" +
        [...unclassified].map(([v, s]) => `  ${v}  (${[...s].slice(0, 4).join(", ")}${s.size > 4 ? ", …" : ""})`).join("\n"));
});

test("every reward verb the guard knows is actually reachable (no dead classifications)", () => {
    // keeps VERB_COVERAGE honest as the code evolves: a verb that no reward path
    // uses anymore should be pruned, not left implying phantom coverage. floorReward
    // is a METHOD name (captured, not called) — exempt.
    const ctx = makeContext(1, ["planner-metadata.js"]);
    const all = rewardSources(ctx).map(x => x.src).join("\n");
    const dead = Object.keys(VERB_COVERAGE).filter(v => v !== "floorReward" && !new RegExp(`\\b${v}\\s*\\(`).test(all));
    assert.deepEqual(dead, [], `classified but unused reward verbs (prune them): ${dead.join(", ")}`);
});

test("code→metadata: buff-granting actions declare a dimEffects buff edge", () => {
    const ctx = makeContext(1, ["planner-metadata.js"]);
    const de = meta(ctx, "dimEffects");
    const missing = [];
    for (const { name, src } of rewardSources(ctx)) {
        let m; const re = /addBuffAmt\(\s*"([^"]+)"/g;
        while ((m = re.exec(src))) if (!de["buff:" + m[1]]) missing.push(`${name} grants ${m[1]} — no dimEffects["buff:${m[1]}"]`);
    }
    assert.deepEqual(missing, [], missing.join("\n"));
});

test("code→metadata: RNG-drawing reward paths carry context.rng", () => {
    const ctx = makeContext(1, ["planner-metadata.js"]);
    const cx = meta(ctx, "context");
    const bad = [];
    for (const { name, src } of rewardSources(ctx)) {
        const drawsRng = /Math\.random/.test(src) || /\bfinishDungeon\b/.test(src) || /\bexchangeMap\b/.test(src);
        if (drawsRng && !cx[name]?.rng) bad.push(`${name} draws RNG but context.rng is unset (rngMode-cycle requirement)`);
    }
    assert.deepEqual(bad, [], bad.join("\n"));
});

test("code→metadata: cross-town writers carry context.crossTown", () => {
    const ctx = makeContext(1, ["planner-metadata.js"]);
    const cx = meta(ctx, "context");
    const bad = [];
    for (const { name, src } of rewardSources(ctx)) {
        if (/\bexchangeMap\b|\badjustRocks\b|\badjustAll\b/.test(src) && !cx[name]?.crossTown)
            bad.push(`${name} writes another town but context.crossTown is unset`);
    }
    assert.deepEqual(bad, [], bad.join("\n"));
});

test("metadata integrity: dimEffects targets + context keys are real action names", () => {
    const ctx = makeContext(1, ["planner-metadata.js"]);
    const names = new Set(ctx.ev("totalActionList").map(a => a.name));
    const de = meta(ctx, "dimEffects"), cx = meta(ctx, "context");
    const bad = [];
    for (const [dim, edges] of Object.entries(de))
        for (const e of edges) if (e.target && !names.has(e.target)) bad.push(`dimEffects[${dim}] → unknown target "${e.target}"`);
    for (const n of Object.keys(cx)) if (!names.has(n)) bad.push(`context key "${n}" is not an action`);
    assert.deepEqual(bad, [], bad.join("\n"));
});
