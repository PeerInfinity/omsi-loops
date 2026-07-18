// test/field-matrix.lib.mjs — Tier-1 declarative-field equivalence matrix
// (XML migration plan §4 Phase 3) + the JS-vs-XML differential (Phase 4).
//
// Builds a deterministic state corpus and records, for every action and every
// state, the values of the declarative fields the XML models:
//   manaCost, goldCost, visible, unlocked, canStart, allowed, storyReqs(1..8).
// These are pure functions of game state (verified: zero Math.random across
// the whole matrix — the build asserts it), so the matrix is exact and needs
// no seeding or tolerance. The golden (buildFieldMatrix) pins the JS oracle
// against drift; the differential (buildXmlDifferential) replays the same
// corpus comparing the hand-written JS implementation against the
// actionListXml-compiled one, exact equality, no epsilon.
//
// Corpus strata (all deterministic):
//   boot        — the harness boot state (loadDefaults + stonesUsed + [0]);
//   all-zero    — every probe dim at zero;
//   all-max     — every probe dim at max (skill 2000, buffs at buffHardCaps,
//                 storyMax 20, every storyFlag + prestige on);
//   thresholds  — for each (dim, level) found by perturbation probing the
//                 157×2 visible()/unlocked() closures (pass A: single dim
//                 raised from all-zero, binary-searched; pass B: single dim
//                 lowered from all-max — catches conjunction floors), one
//                 state at level-1 and one at level, in both profiles; plus
//                 the boolean dims that flip a predicate in either profile;
//   random      — seeded mulberry32 sweep states that additionally randomize
//                 resources (reputation goes negative), town ledger vars
//                 (total ≥ checked ≥ good ≥ goodTemp), stonesUsed,
//                 goldInvested (threshold-aware: 1e6 / 1e9 / 999999999999 are
//                 storyReqs breakpoints), trainingLimits, townsUnlocked,
//                 guild, effectiveTime, storyVars, guild-rank segments and
//                 the adjustPockets()-family totals;
//   exotics     — deterministic strata for the enum/latch globals the probe
//                 can't see: guild × profile, effectiveTime, storyVars,
//                 guildSegments (craft/wiz rank bonuses), fullSurveys
//                 (fullyExploredZones), assassinations (totalAssassinations);
//   fixtures    — the ui-parity mid/deep crafted saves, round-tripped through
//                 the real load(false, saveJson) in a fresh context each.
//
// The perturbation prober is adapted from the unlock-discretization prototype
// (NewDocs/plans/omsiloops/experiments/unlock-extract-probe.mjs, 2026-07-11).
// Here we only need the threshold VALUES for corpus placement, not clause
// semantics, so the sum/survey disambiguation passes are deliberately absent.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeContext, ROOT } from "./harness.mjs";

export const FIELD_COLUMNS = ["manaCost", "goldCost", "visible", "unlocked", "canStart", "allowed", "storyReqs1to18", "multipartSweep"];

const XML_FILES = ["xmlLite.js", "actionListXml.js"];

export const FM_INSTALL_SRC = `
globalThis.__fm = (() => {
    // dungeons/trials are populated by load(), not loadDefaults() — mirror
    // load()'s fresh-init branch so multipart fields evaluate instead of
    // throwing across the synthetic corpus (fixture contexts re-run load()
    // afterwards, which overwrites this)
    for (let i = 0; i < dungeons.length; i++) {
        dungeons[i].length = 0;
        for (let j = 0; j < dungeonFloors[i]; j++) dungeons[i][j] = { ssChance: 1, completed: 0, lastStat: "NA" };
    }
    for (let i = 0; i < trials.length; i++) {
        trials[i].length = 0;
        trials[i].highestFloor = 0;
        for (let j = 0; j < trialFloors[i]; j++) trials[i][j] = { completed: 0 };
    }
    // ---- probe dims (adapted from the unlock-extract prototype) ----
    const numericDims = [];   // {kind, town?, v, max}
    for (const t of towns) {
        for (const v of t.progressVars) {
            if (v.startsWith("SurveyZ")) numericDims.push({ kind: "surveyLevel", town: t.index, v, max: 100 });
            else numericDims.push({ kind: "townLevel", town: t.index, v, max: 100 });
        }
    }
    for (const s in skills) numericDims.push({ kind: "skillLevel", v: s, max: 2000 });
    // probe bound must come from the game's own caps (Imbue Soul unlocks at
    // Imbuement/Imbuement2 > 499 — a fixed 100 hides it)
    for (const b in buffs) numericDims.push({ kind: "buffLevel", v: b, max: buffHardCaps[b] ?? 1000 });
    numericDims.push({ kind: "storyMax", v: "storyMax", max: 20 });
    // derived dim: sets all 9 Survey vars evenly — getExploreProgress() is
    // floor(mean of survey levels), so no single survey dim can cross
    // aggregate thresholds like Open Portal's ep >= 75
    numericDims.push({ kind: "exploreProgress", v: "exploreProgress", max: 100 });
    const boolDims = [{ kind: "prestige", v: "completedAnyPrestige" }];
    boolDims.push({ kind: "globalFlag", v: "portalUsed" });
    for (const f in storyFlags) boolDims.push({ kind: "storyFlag", v: f });

    const expOf = (town, v, L) =>
        towns[town].progressScaling[v] === "linear" ? 5050 * L : 100 * L * (L + 1) / 2;
    const set = (d, L) => {
        if (d.kind === "townLevel") towns[d.town]["exp" + d.v] = expOf(d.town, d.v, L);
        else if (d.kind === "surveyLevel") towns[d.town]["exp" + d.v] = expOf(d.town, "Survey", L);
        else if (d.kind === "skillLevel") skills[d.v].levelExp.level = L;
        else if (d.kind === "buffLevel") buffs[d.v].amt = L;
        else if (d.kind === "storyMax") storyMax = L;
        else if (d.kind === "exploreProgress")
            for (const t of towns) t["expSurveyZ" + t.index] = expOf(t.index, "Survey", L);
    };
    const setBool = (d, on) => {
        if (d.kind === "prestige") prestigeValues.completedAnyPrestige = on;
        else if (d.kind === "globalFlag") { if (d.v === "portalUsed") portalUsed = on; }
        else storyFlags[d.v] = on;
    };
    const zeroAll = () => {
        for (const d of numericDims) set(d, 0);
        for (const d of boolDims) setBool(d, false);
    };
    const maxAll = () => {
        for (const d of numericDims) set(d, d.max);
        for (const d of boolDims) setBool(d, true);
    };

    // ---- extra state surface beyond the probe dims (reset per state) ----
    const bootResources = structuredClone(resources);
    const bootTowns = towns.map(t => {
        const o = {};
        for (const v of t.allVarNames)
            for (const p of ["exp", "checked", "good", "goodTemp", "total"]) {
                const k = p + v;
                if (typeof t[k] === "number") o[k] = t[k];
            }
        return o;
    });
    const bootStones = structuredClone(stonesUsed);
    const bootGoldInvested = goldInvested, bootTrainingLimits = trainingLimits;
    const bootTalents = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.talentLevelExp.level]));
    const bootSkillExp = Object.fromEntries(Object.entries(skills).map(([k, v]) => [k, v.levelExp.exp]));
    const bootStoryVars = structuredClone(storyVars);
    const resetExtras = () => {
        for (const k in resources) delete resources[k];
        Object.assign(resources, structuredClone(bootResources));
        towns.forEach((t, i) => Object.assign(t, bootTowns[i]));
        for (const t of towns) {
            delete t.suppliesCost;   // created by restart(), undefined at boot
            // adjustPockets()-family totals: created on load, undefined at boot
            for (const k of ["totalPockets", "totalWarehouses", "totalInsurance"]) delete t[k];
        }
        towns.forEach((t, i) => delete t["totalAssassinZ" + i]);   // set by AssassinAction finish
        stonesUsed = structuredClone(bootStones);
        goldInvested = bootGoldInvested;
        trainingLimits = bootTrainingLimits;
        for (const k in bootTalents) stats[k].talentLevelExp.level = bootTalents[k];
        for (const k in bootSkillExp) skills[k].levelExp.exp = bootSkillExp[k];
        townsUnlocked = [0];
        // loop-temp / persistent globals the exotic declarative reads consume
        guild = "";
        effectiveTime = 0;
        escapeStarted = false;   // Escape.canStart is a latch; keep states independent
        curCraftGuildSegment = 0;
        curWizCollegeSegment = 0;
        curAdvGuildSegment = 0;
        curThievesGuildSegment = 0;
        curFightFrostGiantsSegment = 0;
        curFightJungleMonstersSegment = 0;
        curGodsSegment = 0;
        Object.assign(storyVars, bootStoryVars);
        // multipart state
        for (const t of towns) for (const v of t.allVarNames) {
            if (typeof t[v + "LoopCounter"] === "number") t[v + "LoopCounter"] = 0;
        }
        for (const d of dungeons) for (const f of d) { f.ssChance = 1; f.completed = 0; f.lastStat = "NA"; }
        for (const t of trials) { t.highestFloor = 0; for (const f of t) f.completed = 0; }
        for (const s of Object.keys(stats)) stats[s].soulstone = 0;
    };

    // ---- predicates for threshold probing ----
    const preds = [];
    for (const t of towns) for (const a of t.totalActionList) {
        preds.push({ fn: () => a.visible() });
        preds.push({ fn: () => a.unlocked() });
    }
    const T = (p) => { try { return !!p.fn(); } catch (e) { return false; } };

    const bisect = (d, lo, hi, wantPassAt) => {
        while (lo + 1 < hi) {
            const mid = Math.floor((lo + hi) / 2);
            set(d, mid);
            if (wantPassAt()) hi = mid; else lo = mid;
        }
        return hi;
    };

    const collectThresholds = () => {
        let evals = 0;
        const TT = (p) => { evals++; return T(p); };
        const zero = new Map(), max = new Map(), zeroBools = new Set(), maxBools = new Set();
        for (const p of preds) {
            zeroAll();
            if (!TT(p)) {
                for (let i = 0; i < numericDims.length; i++) {
                    const d = numericDims[i];
                    set(d, d.max);
                    if (TT(p)) {
                        const h = bisect(d, 0, d.max, () => TT(p));
                        const s = zero.get(i); if (s) s.add(h); else zero.set(i, new Set([h]));
                    }
                    set(d, 0);
                }
                for (let i = 0; i < boolDims.length; i++) {
                    setBool(boolDims[i], true);
                    if (TT(p)) zeroBools.add(i);
                    setBool(boolDims[i], false);
                }
            }
            maxAll();
            if (TT(p)) {
                for (let i = 0; i < numericDims.length; i++) {
                    const d = numericDims[i];
                    set(d, 0);
                    if (!TT(p)) {
                        const h = bisect(d, 0, d.max, () => TT(p));
                        const s = max.get(i); if (s) s.add(h); else max.set(i, new Set([h]));
                    }
                    set(d, d.max);
                }
                for (let i = 0; i < boolDims.length; i++) {
                    setBool(boolDims[i], false);
                    if (!TT(p)) maxBools.add(i);
                    setBool(boolDims[i], true);
                }
            }
        }
        zeroAll();
        const flat = (m) => [...m.entries()].map(([d, s]) => [d, [...s].sort((a, b) => a - b)]);
        return { zero: flat(zero), max: flat(max), zeroBools: [...zeroBools], maxBools: [...maxBools], evals };
    };

    // ---- field evaluation ----
    const norm = (v) => {
        if (v === undefined) return null;
        if (typeof v === "number" && !isFinite(v)) return "num:" + String(v);
        if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
        return "val:" + String(v);
    };
    // works for a real Action and for an actionListXml-compiled field object
    // alike: both carry the same field closures (or lack them)
    const rowFor = (a) => {
        const call = (fn, args = []) => {
            if (typeof fn !== "function") return null;
            try { return norm(fn.apply(a, args)); } catch (e) { return "throws:" + e.message; }
        };
        const row = [a.name, call(a.manaCost), call(a.goldCost), call(a.visible),
            call(a.unlocked), call(a.canStart), call(a.allowed)];
        if (typeof a.storyReqs === "function") {
            const sr = [];
            // multiparts number stories up to 18 (Gods Trial); 8 covered the
            // non-multipart set only
            for (let n = 1; n <= 18; n++) {
                try { sr.push(norm(a.storyReqs(n))); } catch (e) { sr.push("throws:" + e.message); }
            }
            row.push(sr);
        } else row.push(null);
        // multipart argument sweep: loopCost(segment, loopCounter),
        // tickProgress(offset, loopCounter, totalCompletions) and
        // canStart(loopCounter) at explicit tuples (undefined exercises the
        // town-state default parameter). Pins arg plumbing, not just defaults.
        if (typeof a.loopCost === "function") {
            const segs = a.segments || 3;
            const lcs = [undefined, 0, 1, segs, 3 * segs + 1, 7 * segs + 2];
            const mp = { loopCost: [], tick: [], canStartAt: [] };
            for (const s of [0, 1, segs - 1]) {
                for (const lc of lcs) mp.loopCost.push(call(a.loopCost, [s, lc]));
            }
            for (const lc of lcs) {
                for (const tc of [undefined, 0, 99, 999]) mp.tick.push(call(a.tickProgress, [0, lc, tc]));
            }
            for (const lc of lcs) mp.canStartAt.push(call(a.canStart, [lc]));
            row.push(mp);
        } else row.push(null);
        return row;
    };
    const evalFields = () => {
        const out = [];
        for (const t of towns) for (const a of t.totalActionList) out.push(rowFor(a));
        return out;
    };

    // ---- state application ----
    // spec: { profile: "boot"|"zero"|"max", dims: [[i, L]...], bools: [[i, on]...], random: seed|null }
    let rs = 0;
    const rnd = () => { rs |= 0; rs = rs + 0x6D2B79F5 | 0; let t = Math.imul(rs ^ rs >>> 15, 1 | rs); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const applyState = (spec) => {
        resetExtras();
        if (spec.profile === "max") maxAll();
        else zeroAll();   // "boot"/"zero": dims zeroed, extras at boot defaults
        for (const [i, L] of spec.dims ?? []) set(numericDims[i], L);
        for (const [i, on] of spec.bools ?? []) setBool(boolDims[i], on);
        if (spec.allFlags) for (const d of boolDims) setBool(d, true);
        if (spec.talents != null) for (const k of Object.keys(stats)) stats[k].talentLevelExp.level = spec.talents;
        if (spec.random != null) {
            rs = spec.random >>> 0;
            for (const d of numericDims) {
                if (d.kind === "exploreProgress") continue;   // derived — surveys already randomized
                const r = rnd();
                const L = r < 0.35 ? 0 : r < 0.75 ? Math.floor(rnd() * 41) : Math.floor(rnd() * (d.max + 1));
                set(d, L);
            }
            for (const d of boolDims) setBool(d, rnd() < 0.12);
            for (const k of Object.keys(resources).sort()) {
                const v = resources[k];
                if (typeof v === "boolean") resources[k] = rnd() < 0.15;
                else if (k === "reputation") resources[k] = Math.floor(rnd() * 21) - 10;
                else if (k === "gold") resources[k] = rnd() < 0.3 ? 0 : Math.floor(rnd() * 100000);
                else if (typeof v === "number") resources[k] = rnd() < 0.3 ? 0 : Math.floor(rnd() * 1000);
            }
            for (const t of towns) for (const v of t.allVarNames) {
                if (typeof t["total" + v] !== "number" || rnd() >= 0.3) continue;
                const total = Math.floor(rnd() * 500);
                const checked = Math.floor(rnd() * (total + 1));
                const good = Math.floor(rnd() * (Math.floor(total / 10) + 1));
                t["total" + v] = total; t["checked" + v] = checked;
                t["good" + v] = good; t["goodTemp" + v] = Math.floor(rnd() * (good + 1));
            }
            // Haul-family thresholds: canStart < 250, storyReqs 1/100/250
            const su = [0, 1, 2, 100, 249, 250];
            for (const k of Object.keys(stonesUsed)) stonesUsed[k] = su[Math.floor(rnd() * su.length)];
            // skill EXP within the current level (Learn Alchemy story 1 tests exp >= 50)
            const se = [0, 49, 50, 77, 150];
            for (const k of Object.keys(skills)) {
                skills[k].levelExp.exp = rnd() < 0.5 ? 0 : se[Math.floor(rnd() * se.length)];
            }
            const gi = [0, 999999, 1000000, 999999999, 1000000000, 999999999999];
            goldInvested = gi[Math.floor(rnd() * gi.length)];
            trainingLimits = Math.floor(rnd() * 31);
            // talents: threshold-aware (Train-family storyReqs test 100/1k/10k/100k)
            const tal = [0, 1, 99, 100, 999, 1000, 9999, 10000, 99999, 100000, 500000];
            for (const k of Object.keys(stats)) {
                stats[k].talentLevelExp.level = rnd() < 0.4 ? 0 : tal[Math.floor(rnd() * tal.length)];
            }
            // suppliesCost: restart()-created; undefined at boot, 300 fresh, Haggle -20 steps
            for (const t of towns) {
                if (rnd() < 0.5) t.suppliesCost = Math.floor(rnd() * 16) * 20;
                else delete t.suppliesCost;
            }
            townsUnlocked = Array.from({ length: 1 + Math.floor(rnd() * 9) }, (_, i) => i);
            const gl = ["", "Adventure", "Crafting", "Explorer", "Thieves", "Assassin"];
            guild = gl[Math.floor(rnd() * gl.length)];
            // effectiveTime: threshold-aware (Escape's latch at 60; Mana Well dry at 500)
            const et = [0, 1, 59, 60, 61, 250, 499, 500, 501, 1000];
            effectiveTime = et[Math.floor(rnd() * et.length)];
            // storyVars: Raise Zombie tests 10/25; wizard ranks step by 6 up to 48
            const sv = [-1, 0, 5, 6, 9, 10, 11, 12, 24, 25, 42, 48];
            for (const k of Object.keys(storyVars)) storyVars[k] = sv[Math.floor(rnd() * sv.length)];
            // guild-rank segments (Craft goes Godlike at 42; WizCollege Chair at 57)
            const cseg = [0, 1, 2, 3, 7, 29, 30, 41, 42, 45];
            curCraftGuildSegment = cseg[Math.floor(rnd() * cseg.length)];
            const wseg = [0, 1, 13, 29, 56, 57, 60];
            curWizCollegeSegment = wseg[Math.floor(rnd() * wseg.length)];
            // adjustPockets()-family totals (Pick Pockets family allowed());
            // undefined-or-set, like suppliesCost
            for (const t of towns) for (const k of ["totalPockets", "totalWarehouses", "totalInsurance"]) {
                if (rnd() < 0.5) t[k] = Math.floor(rnd() * 300); else delete t[k];
            }
            // multipart state: loop counters (floor boundaries fall at
            // multiples of segments), dungeon/trial floor completions
            // (sqrt(1 + c/200) thresholds), soulstone pools, the remaining
            // cur*Segment rank counters
            const lcv = [0, 1, 2, 3, 5, 7, 9, 14, 21, 27, 45, 63];
            for (const t of towns) for (const v of t.allVarNames) {
                if (typeof t[v + "LoopCounter"] === "number" && rnd() < 0.5) {
                    t[v + "LoopCounter"] = lcv[Math.floor(rnd() * lcv.length)];
                }
            }
            const dcv = [0, 1, 50, 199, 200, 999];
            for (const d of dungeons) for (const f of d) {
                if (rnd() < 0.3) f.completed = dcv[Math.floor(rnd() * dcv.length)];
            }
            for (const t of trials) for (const f of t) {
                if (rnd() < 0.02) f.completed = dcv[Math.floor(rnd() * dcv.length)];
            }
            const ssv = [0, 100, 5000, 1000000, 1000000000];
            for (const s of Object.keys(stats)) {
                stats[s].soulstone = rnd() < 0.5 ? 0 : ssv[Math.floor(rnd() * ssv.length)];
            }
            const xseg = [0, 1, 2, 3, 9, 30, 42, 55, 57, 63];
            curAdvGuildSegment = xseg[Math.floor(rnd() * xseg.length)];
            curThievesGuildSegment = xseg[Math.floor(rnd() * xseg.length)];
            curFightFrostGiantsSegment = xseg[Math.floor(rnd() * xseg.length)];
            curFightJungleMonstersSegment = xseg[Math.floor(rnd() * xseg.length)];
            curGodsSegment = xseg[Math.floor(rnd() * xseg.length)];
        }
        if (spec.guild != null) guild = spec.guild;
        if (spec.effectiveTime != null) effectiveTime = spec.effectiveTime;
        if (spec.storyVars) for (const [k, v] of spec.storyVars) storyVars[k] = v;
        if (spec.guildSegments != null) {
            curCraftGuildSegment = spec.guildSegments;
            curWizCollegeSegment = spec.guildSegments;
            curAdvGuildSegment = spec.guildSegments;
            curThievesGuildSegment = spec.guildSegments;
            curFightFrostGiantsSegment = spec.guildSegments;
            curFightJungleMonstersSegment = spec.guildSegments;
            curGodsSegment = spec.guildSegments;
        }
        if (spec.loopCounters != null) {
            for (const t of towns) for (const v of t.allVarNames) {
                if (typeof t[v + "LoopCounter"] === "number") t[v + "LoopCounter"] = spec.loopCounters;
            }
        }
        if (spec.soulstones != null) for (const s of Object.keys(stats)) stats[s].soulstone = spec.soulstones;
        if (spec.dungeonCompleted != null) for (const d of dungeons) for (const f of d) f.completed = spec.dungeonCompleted;
        if (spec.trialCompleted != null) for (const t of trials) for (const f of t) f.completed = spec.trialCompleted;
        if (spec.fullSurveys != null) {
            for (const d of numericDims) {
                if (d.kind === "surveyLevel" && d.town < spec.fullSurveys) set(d, 100);
            }
        }
        if (spec.assassinations != null) {
            for (let i = 0; i < spec.assassinations; i++) towns[i]["totalAssassinZ" + i] = 1;
        }
        if (spec.pools != null) {
            // explicit limited-pool ledgers: total/checked/good/goodTemp drive
            // which finishRegular branch a reward callback reaches
            for (const t of towns) for (const v of t.allVarNames) {
                if (typeof t["total" + v] !== "number" && typeof t["good" + v] !== "number") continue;
                t["total" + v] = spec.pools.total;
                t["checked" + v] = spec.pools.checked;
                t["good" + v] = spec.pools.good;
                t["goodTemp" + v] = spec.pools.goodTemp;
                t["lootFrom" + v] = 0;
            }
        }
        if (spec.resources) Object.assign(resources, spec.resources);
    };
    const applyAndEval = (spec) => {
        applyState(spec);
        return JSON.stringify(evalFields());
    };

    const dimName = (i) => { const d = numericDims[i]; return d.kind + ":" + (d.town ?? "") + ":" + d.v; };
    const boolName = (i) => { const d = boolDims[i]; return d.kind + ":" + d.v; };
    return {
        nNumeric: numericDims.length, nBool: boolDims.length, nPreds: preds.length,
        maxOf: (i) => numericDims[i].max,
        collectThresholds, applyState, applyAndEval, evalFields, rowFor, norm,
        dimName, boolName,
    };
})();
`;

// JS-vs-XML comparison, run entirely inside the vm. Row columns (rowFor):
// [name, manaCost, goldCost, visible, unlocked, canStart, allowed, storyReqs[8]].
// Numeric columns compare ===; boolean columns compare by truthiness (the
// engine consumes them in boolean position), but a MISSING field (null) never
// equals a present one.
const DIFF_INSTALL = `
globalThis.__fmDiff = (() => {
    const doc = ActionListXml.parseDocument(__xmlText);
    if (typeof __xmlMutate === "function") __xmlMutate(doc);
    const compiled = {};
    for (const name in doc.actions) compiled[name] = ActionListXml.compileAction(doc.actions[name], doc);
    const jsByName = new Map();
    for (const t of towns) for (const a of t.totalActionList) jsByName.set(a.name, a);

    const COLS = ["manaCost", "goldCost", "visible", "unlocked", "canStart", "allowed", "storyReqs"];
    const BOOL = new Set(["visible", "unlocked", "canStart"]);
    const same = (col, j, x) => {
        if ((j === null) !== (x === null)) return false;
        if (j === null) return true;
        // throws must match verbatim, even in boolean position (throw-parity)
        if (typeof j === "string" || typeof x === "string") return j === x;
        if (BOOL.has(col)) return !!j === !!x;
        return j === x;
    };
    const compare = () => {
        const out = [];
        for (const name in compiled) {
            const a = jsByName.get(name);
            if (!a) { out.push({ name, col: "(exists)", js: null, xml: "defined" }); continue; }
            // native fields keep the JS closure on both sides — nothing to compare
            const nat = new Set(compiled[name].__nativeFields ?? []);
            const rj = __fm.rowFor(a), rx = __fm.rowFor(compiled[name]);
            for (let i = 0; i < 6; i++) {
                if (nat.has(COLS[i])) continue;
                if (!same(COLS[i], rj[i + 1], rx[i + 1])) out.push({ name, col: COLS[i], js: rj[i + 1], xml: rx[i + 1] });
            }
            if (!nat.has("storyReqs")) {
                const sj = rj[7], sx = rx[7];
                if ((sj === null) !== (sx === null)) out.push({ name, col: "storyReqs", js: sj, xml: sx });
                else if (sj !== null) {
                    for (let n = 0; n < 18; n++) {
                        if (!!sj[n] !== !!sx[n] || (typeof sj[n] === "string") !== (typeof sx[n] === "string")) {
                            out.push({ name, col: "storyReqs(" + (n + 1) + ")", js: sj[n], xml: sx[n] });
                        }
                    }
                }
            }
            // multipart argument sweep (loopCost/tickProgress numeric ===,
            // canStart-at-loopCounter by truthiness)
            const mj = rj[8], mx = rx[8];
            if ((mj === null) !== (mx === null)) {
                out.push({ name, col: "multipart", js: mj && "swept", xml: mx && "swept" });
            } else if (mj !== null) {
                const SWEEPS = [["loopCost", "loopCost", false], ["tick", "tickProgress", false], ["canStartAt", "canStart", true]];
                for (const [key, natName, bool] of SWEEPS) {
                    if (nat.has(natName)) continue;
                    for (let i = 0; i < mj[key].length; i++) {
                        const j = mj[key][i], x = mx[key][i];
                        const eq = (j === null) === (x === null) && (j === null
                            || (typeof j === "string" || typeof x === "string" ? j === x
                                : bool ? !!j === !!x : j === x));
                        if (!eq) out.push({ name, col: key + "[" + i + "]", js: j, xml: x });
                    }
                }
            }
        }
        return out;
    };
    const statics = () => {
        const out = [];
        const sortedJson = (o) => o === undefined ? "undefined"
            : JSON.stringify(o && typeof o === "object" && !Array.isArray(o)
                ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => a < b ? -1 : 1)) : o);
        for (const name in compiled) {
            const a = jsByName.get(name);
            if (!a) continue;
            for (const f of ["varName", "townNum", "type", "expMult", "segments"]) {
                if (a[f] !== compiled[name][f]) out.push({ name, col: f, js: a[f], xml: compiled[name][f] });
            }
            for (const f of ["stats", "affectedBy", "loopStats"]) {
                if (sortedJson(a[f]) !== sortedJson(compiled[name][f])) {
                    out.push({ name, col: f, js: sortedJson(a[f]), xml: sortedJson(compiled[name][f]) });
                }
            }
        }
        return out;
    };
    return { names: Object.keys(compiled), compare, statics };
})();
`;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

// The ui-parity fixture recipes (CC/scripts/omsi-parity/run-ui-parity.mjs) —
// kept textually identical so the two harnesses stay in sync.
export const FIXTURE_RECIPES = {
    mid: `
        cheatSkill("Magic", 20);
        cheatSkill("Combat", 20);
        towns[0].expWander = 505000;
        towns[0].expMet = 505000;
        towns[0].expSecrets = 505000;
    `,
    deep: `
        cheatSkill("Magic", 100);
        cheatSkill("Combat", 100);
        cheatSkill("Alchemy", 250);
        cheatSkill("Dark", 1200);
        cheatSkill("Mercantilism", 10);
        cheatSkill("Thievery", 5);
        cheatSkill("Pyromancy", 100);
        cheatSkill("Restoration", 1500);
        for (const action of totalActionList) {
            if (action.type === "progress") {
                towns[action.townNum]["exp" + action.varName] = 505000;
            }
        }
        townsUnlocked = [0, 1];
    `,
};

/** boot a context that has loaded a crafted save through the real load() */
function makeFixtureContext(recipe, extraFiles = []) {
    const crafter = makeContext(12345);
    crafter.ev(recipe);
    const blob = crafter.ev("JSON.stringify(doSave())");
    const fixCtx = makeContext(12345, extraFiles);
    fixCtx.ev(FM_INSTALL_SRC);
    // DOM touches on the load() path: closeTutorial(), buff<name>Cap /
    // pausePlay / etc. element writes. In a real browser every UI element
    // exists during load(); mirror that with a permissive element stub, then
    // restore the null stub (null is load-bearing for tick-path search-toggle
    // semantics — see harness.mjs).
    fixCtx.ev(`
        closeTutorial = () => {};
        globalThis.window = globalThis;      // doLoad reads window.localStorage
        globalThis.loadChallenge = () => {}; // challenges.js is not a sim file; mode 0 is a no-op anyway
        recalcInterval = () => {};           // would start a real setInterval in the vm
        const __el = () => Object.assign(new HTMLInputElement(), {
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            style: {}, textContent: "", value: "", checked: false,
        });
        document.getElementById = () => __el();
        const __blob = JSON.parse(${JSON.stringify(blob)});
        __blob.date = new Date().toISOString();  // zero offline gain, deterministic fields
        load(false, JSON.stringify(__blob));
        document.getElementById = () => null;
    `);
    return fixCtx;
}

/** assemble the deterministic state list from the probed thresholds */
function assembleStates(ctx, randomStates, probe = true) {
    const states = [];
    states.push({ id: "boot", spec: { profile: "boot" } });
    states.push({ id: "all-zero", spec: { profile: "zero" } });
    states.push({ id: "all-max", spec: { profile: "max" } });
    if (!probe) {
        for (let k = 0; k < randomStates; k++) {
            states.push({ id: `random:${k}`, spec: { profile: "zero", random: 0x51D0 + k * 7919 } });
        }
        return { states, probeEvals: 0 };
    }
    const th = JSON.parse(ctx.ev("JSON.stringify(__fm.collectThresholds())"));
    const dimName = (i) => ctx.ev(`__fm.dimName(${i})`);
    const boolName = (i) => ctx.ev(`__fm.boolName(${i})`);
    for (const [profile, list] of [["zero", th.zero], ["max", th.max]]) {
        for (const [i, levels] of list) {
            const name = dimName(i);
            for (const h of levels) {
                for (const L of h > 0 ? [h - 1, h] : [h]) {
                    states.push({ id: `${profile}:${name}@${L}`, spec: { profile, dims: [[i, L]] } });
                }
            }
        }
    }
    for (const i of th.zeroBools) states.push({ id: `zero:${boolName(i)}=on`, spec: { profile: "zero", bools: [[i, true]] } });
    for (const i of th.maxBools) states.push({ id: `max:${boolName(i)}=off`, spec: { profile: "max", bools: [[i, false]] } });
    // talent ladder: story flags are ANDed with talent thresholds in the
    // Train-family storyReqs — deterministic joint coverage, not probability
    for (const t of [0, 99, 100, 150, 999, 1000, 5000, 9999, 10000, 99999, 100000, 500000]) {
        states.push({ id: `talents:${t}`, spec: { profile: "zero", allFlags: true, talents: t } });
    }
    // guild membership: an enum global no numeric probe can find; both
    // profiles, because guild gates conjoin with level floors (Build Housing)
    for (const g of ["", "Adventure", "Crafting", "Explorer", "Thieves", "Assassin"]) {
        for (const profile of ["zero", "max"]) {
            states.push({ id: `${profile}:guild=${g || "none"}`, spec: { profile, guild: g } });
        }
    }
    // effectiveTime thresholds (Mana Well runs dry at 500; Escape latches below 60)
    for (const t of [0, 59, 60, 499, 500, 501]) {
        states.push({ id: `effectiveTime:${t}`, spec: { profile: "zero", effectiveTime: t } });
    }
    // storyVar thresholds (Raise Zombie stories 3/4)
    for (const L of [9, 10, 24, 25]) {
        states.push({ id: `storyVar:maxZombiesRaised@${L}`, spec: { profile: "zero", storyVars: [["maxZombiesRaised", L]] } });
    }
    // guild-rank segments drive getCraftGuildRank/getWizCollegeRank bonuses
    // (Restoration/Spatiomancy manaCost, Build Housing canStart)
    for (const k of [1, 3, 29, 30, 42, 57]) {
        states.push({ id: `guildSegments:${k}`, spec: { profile: "zero", guildSegments: k } });
    }
    // Build Housing gates houses < floor(craftBonus * spatiomancyMod): put
    // resources.houses between the values a wrong bonus function would give
    states.push({ id: "max:guild=Crafting@seg30+houses20", spec: { profile: "max", guild: "Crafting", guildSegments: 30, resources: { houses: 20 } } });
    // fullyExploredZones() counts towns with SurveyZ == 100 (Explorers Guild stories 3-5)
    for (const k of [1, 3, 4, 8, 9]) {
        states.push({ id: `fullSurveys:${k}`, spec: { profile: "zero", fullSurveys: k } });
    }
    // totalAssassinations() counts zones with totalAssassinZ > 0 (Guild Assassin stories 3/5)
    for (const k of [3, 4, 7, 8]) {
        states.push({ id: `assassinations:${k}`, spec: { profile: "zero", assassinations: k } });
    }
    // multipart state: loop counters (all multipart vars at once), dungeon/
    // trial floor completions, soulstone pools (checkSoulstoneSac gates)
    for (const k of [0, 1, 3, 9, 14, 27, 63]) {
        states.push({ id: `loopCounters:${k}`, spec: { profile: "zero", loopCounters: k } });
    }
    for (const v of [1, 199, 200]) {
        states.push({ id: `floorsCompleted:${v}`, spec: { profile: "zero", dungeonCompleted: v, trialCompleted: v } });
    }
    for (const v of [1000, 1000000]) {
        states.push({ id: `soulstones:${v}`, spec: { profile: "max", soulstones: v } });
    }
    // soulstone-sacrifice gates need sac() to actually PASS alongside their
    // reputation gates: zero profile keeps buff levels (and so goldCost) low.
    // Dark Ritual wants rep <= -5, Great Feast rep >= 100 — a canary proved
    // the rest of the corpus never reaches the sac/cap clauses.
    states.push({ id: "soulstoneSac:ritual", spec: { profile: "zero", soulstones: 1000000, resources: { reputation: -10 } } });
    states.push({ id: "soulstoneSac:feast", spec: { profile: "zero", soulstones: 1000000, resources: { reputation: 100 } } });
    for (let k = 0; k < randomStates; k++) {
        states.push({ id: `random:${k}`, spec: { profile: "zero", random: 0x51D0 + k * 7919 } });
    }
    return { states, probeEvals: th.evals };
}

export function buildFieldMatrix({ randomStates = 64, perturb = null, only = null } = {}) {
    const ctx = makeContext(12345);
    ctx.ev(FM_INSTALL_SRC);
    const info = JSON.parse(ctx.ev("JSON.stringify({ n: __fm.nNumeric, b: __fm.nBool, p: __fm.nPreds })"));

    const { states, probeEvals } = assembleStates(ctx, randomStates);

    // optional single-state perturbation (anti-vacuity self-check support)
    if (perturb) {
        const s = states.find(s => s.id === perturb.id);
        if (!s) throw new Error(`perturb target not found: ${perturb.id}`);
        s.spec = JSON.parse(JSON.stringify(s.spec));
        s.spec.dims = [...(s.spec.dims ?? []), [perturb.dim, perturb.level]];
    }

    const rngBefore = ctx.rngCount();
    const perState = [];
    let baseline = null;
    const selected = only ? states.filter(s => only.includes(s.id)) : states;
    for (const s of selected) {
        const json = ctx.ev(`__fm.applyAndEval(${JSON.stringify(s.spec)})`);
        perState.push({ id: s.id, hash: sha(json) });
        if (s.id === "boot") baseline = JSON.parse(json);
    }

    for (const [name, recipe] of Object.entries(FIXTURE_RECIPES)) {
        if (only && !only.includes(`fixture:${name}`)) continue;
        const fixCtx = makeFixtureContext(recipe);
        const json = fixCtx.ev("JSON.stringify(__fm.evalFields())");
        perState.push({ id: `fixture:${name}`, hash: sha(json) });
    }

    const rngConsumed = ctx.rngCount() - rngBefore;
    const matrixHash = sha(perState.map(s => `${s.id}=${s.hash}`).join("\n"));
    return {
        meta: {
            dims: { numeric: info.n, bool: info.b }, predicates: info.p,
            probeEvals, states: perState.length, randomStates,
            fieldColumns: FIELD_COLUMNS,
        },
        perState, matrixHash, baseline, rngConsumed,
    };
}

// Phase 4/5 wiring: what the game loads on top of the sim files when
// options.useActionListXml is on (interpreter + the generated XML carrier).
export const WIRED_FILES = [...XML_FILES, "data/actionListXml.data.js"];

// applied-count golden: the wired path must override every XML-defined
// action — a compile failure falls back to JS silently (by design for the
// game, vacuously green for the matrix test), so the count is asserted
export const WIRED_PREP = `
{
    const r = ActionListXml.applyOverrides();
    if (!r) throw new Error("applyOverrides failed (no carrier / parse error)");
    if (r.applied !== r.total) throw new Error("applyOverrides fell back to JS for " + (r.total - r.applied) + " of " + r.total + " actions");
    globalThis.__wiredCounts = r;
}
`;

// Wired-path row comparison, host-side. Mirrors DIFF_INSTALL's semantics
// EXACTLY (the Phase-4 blessed gate): numeric columns ===, boolean-position
// columns by truthiness (several JS visible()/unlocked() bodies return
// truthy non-booleans the engine consumes in boolean position; the XML
// answers true), throws verbatim in the main columns, storyReqs by
// truthiness + string-ness, multipart sweeps numeric ===. Unlike the
// differential there are no native-field skips: native fields keep the SAME
// JS closure on both sides, so they must agree — a disagreement there is a
// real state divergence between the two contexts.
const ROW_BOOL_COLS = new Set([3, 4, 5]);   // visible, unlocked, canStart
const ROW_COL_NAMES = [null, "manaCost", "goldCost", "visible", "unlocked", "canStart", "allowed"];
function compareRows(rowsJs, rowsWired, stateId, out) {
    if (rowsJs.length !== rowsWired.length) {
        out.push({ state: stateId, name: "(corpus)", col: "(rowCount)", js: rowsJs.length, wired: rowsWired.length });
        return;
    }
    const same = (boolCol, j, x) => {
        if ((j === null) !== (x === null)) return false;
        if (j === null) return true;
        if (typeof j === "string" || typeof x === "string") return j === x;
        if (boolCol) return !!j === !!x;
        return j === x;
    };
    for (let r = 0; r < rowsJs.length; r++) {
        const rj = rowsJs[r], rx = rowsWired[r];
        const name = rj[0];
        if (name !== rx[0]) { out.push({ state: stateId, name, col: "(name)", js: name, wired: rx[0] }); continue; }
        for (let i = 1; i <= 6; i++) {
            if (!same(ROW_BOOL_COLS.has(i), rj[i], rx[i])) {
                out.push({ state: stateId, name, col: ROW_COL_NAMES[i], js: rj[i], wired: rx[i] });
            }
        }
        const sj = rj[7], sx = rx[7];
        if ((sj === null) !== (sx === null)) out.push({ state: stateId, name, col: "storyReqs", js: sj, wired: sx });
        else if (sj !== null) {
            for (let n = 0; n < 18; n++) {
                if (!!sj[n] !== !!sx[n] || (typeof sj[n] === "string") !== (typeof sx[n] === "string")) {
                    out.push({ state: stateId, name, col: `storyReqs(${n + 1})`, js: sj[n], wired: sx[n] });
                }
            }
        }
        const mj = rj[8], mx = rx[8];
        if ((mj === null) !== (mx === null)) out.push({ state: stateId, name, col: "multipart", js: mj && "swept", wired: mx && "swept" });
        else if (mj !== null) {
            for (const [key, bool] of [["loopCost", false], ["tick", false], ["canStartAt", true]]) {
                for (let i = 0; i < mj[key].length; i++) {
                    if (!same(bool, mj[key][i], mx[key][i])) {
                        out.push({ state: stateId, name, col: `${key}[${i}]`, js: mj[key][i], wired: mx[key][i] });
                    }
                }
            }
        }
    }
}

/**
 * Phase 4/5 wiring gate: replay the full corpus in TWO contexts — plain JS
 * and one with ActionListXml.applyOverrides() applied to the LIVE Action
 * objects (the exact mechanism options.useActionListXml uses) — and compare
 * every row with the Phase-4 differential's semantics. The JS side is
 * separately pinned by the field-matrix golden, so this proves the live game
 * answers identically on the XML path.
 */
export function buildWiredDifferential({ randomStates = 64, maxMismatches = 200 } = {}) {
    const jsCtx = makeContext(12345);
    jsCtx.ev(FM_INSTALL_SRC);
    const wiredCtx = makeContext(12345, WIRED_FILES);
    wiredCtx.ev(WIRED_PREP);
    wiredCtx.ev(FM_INSTALL_SRC);
    const wiredCounts = JSON.parse(wiredCtx.ev("JSON.stringify(__wiredCounts)"));

    const { states } = assembleStates(jsCtx, randomStates);
    const rngBefore = jsCtx.rngCount() + wiredCtx.rngCount();
    const mismatches = [];
    let statesChecked = 0;
    for (const s of states) {
        if (mismatches.length >= maxMismatches) break;
        const rowsJs = JSON.parse(jsCtx.ev(`__fm.applyAndEval(${JSON.stringify(s.spec)})`));
        const rowsWired = JSON.parse(wiredCtx.ev(`__fm.applyAndEval(${JSON.stringify(s.spec)})`));
        compareRows(rowsJs, rowsWired, s.id, mismatches);
        statesChecked++;
    }
    const rngConsumed = jsCtx.rngCount() + wiredCtx.rngCount() - rngBefore;

    for (const [name, recipe] of Object.entries(FIXTURE_RECIPES)) {
        if (mismatches.length >= maxMismatches) break;
        const fixJs = makeFixtureContext(recipe);
        const fixWired = makeFixtureContext(recipe, WIRED_FILES);
        // the override applies after load() in the game too (the load-time
        // option handler runs at the end of load())
        fixWired.ev(WIRED_PREP);
        const rowsJs = JSON.parse(fixJs.ev("JSON.stringify(__fm.evalFields())"));
        const rowsWired = JSON.parse(fixWired.ev("JSON.stringify(__fm.evalFields())"));
        compareRows(rowsJs, rowsWired, `fixture:${name}`, mismatches);
        statesChecked++;
    }

    return { wiredCounts, mismatches, statesChecked, totalStates: states.length + Object.keys(FIXTURE_RECIPES).length, rngConsumed };
}

/**
 * Phase 4 differential: compare every XML-defined action against its JS
 * implementation across the full state corpus (and the load() fixtures).
 *
 * @param {object} [opts]
 * @param {number} [opts.randomStates]
 * @param {string} [opts.xmlText]  overrides data/actionList.xml
 * @param {(doc: any) => void} [opts.mutate]  mutates the parsed document
 *   before compilation (host-side function; the parsed tree is plain JSON) —
 *   the perturbation-canary hook
 * @param {number} [opts.maxMismatches]  stop collecting after this many
 * @param {boolean} [opts.probe]  false skips the threshold sweep (canary runs)
 * @param {boolean} [opts.fixtures]  false skips the load() fixture states
 */
export function buildXmlDifferential({ randomStates = 64, xmlText = null, mutate = null, maxMismatches = 200, probe = true, fixtures = true } = {}) {
    xmlText ??= fs.readFileSync(path.join(ROOT, "data", "actionList.xml"), "utf8");
    const install = (c) => {
        c.sandbox.__xmlText = xmlText;
        c.sandbox.__xmlMutate = mutate;
        c.ev(DIFF_INSTALL);
    };

    const ctx = makeContext(12345, XML_FILES);
    ctx.ev(FM_INSTALL_SRC);
    install(ctx);
    const names = JSON.parse(ctx.ev("JSON.stringify(__fmDiff.names)"));
    const statics = JSON.parse(ctx.ev("JSON.stringify(__fmDiff.statics())"));

    const { states } = assembleStates(ctx, randomStates, probe);
    const rngBefore = ctx.rngCount();
    const mismatches = [];
    let statesChecked = 0;
    for (const s of states) {
        if (mismatches.length >= maxMismatches) break;
        ctx.ev(`__fm.applyState(${JSON.stringify(s.spec)})`);
        const diffs = JSON.parse(ctx.ev("JSON.stringify(__fmDiff.compare())"));
        for (const d of diffs) mismatches.push({ state: s.id, ...d });
        statesChecked++;
    }
    const rngConsumed = ctx.rngCount() - rngBefore;

    for (const [name, recipe] of fixtures ? Object.entries(FIXTURE_RECIPES) : []) {
        if (mismatches.length >= maxMismatches) break;
        const fixCtx = makeFixtureContext(recipe, XML_FILES);
        install(fixCtx);
        const diffs = JSON.parse(fixCtx.ev("JSON.stringify(__fmDiff.compare())"));
        for (const d of diffs) mismatches.push({ state: `fixture:${name}`, ...d });
        statesChecked++;
    }

    return { names, statics, mismatches, statesChecked, rngConsumed };
}
