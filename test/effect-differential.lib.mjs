// test/effect-differential.lib.mjs — Phase 6's oracle gate.
//
// Phase 3/4 compared FIELDS, which are pure: run both implementations, compare
// return values. Effect slots mutate, so the comparison is over STATE DELTAS:
// for every (action, slot) and every corpus state, put two contexts into the
// SAME state, run the hand-written JS body in one and the XML-compiled body in
// the other, and require the full-state hashes to match exactly. JS is always
// the oracle; a divergence is a bug in the XML or the interpreter, never a
// tolerance.
//
// Why two contexts instead of snapshot/restore: the wired context is the real
// mechanism (ActionListXml.applyOverrides on the live Action objects, exactly
// what options.useActionListXml does), and `__fm.applyState(spec)` already
// re-establishes a complete deterministic state between runs — so the "restore"
// step is the same code path the corpus already trusts, rather than a second,
// hand-maintained inventory of mutable globals that could silently drift.
//
// RNG: the two arms are pinned to the same seeded-mulberry32 state before every
// slot invocation and their consumption counts are compared alongside the hash,
// so RNG-bearing bodies (the effect primitives wrapping finishDungeon and
// friends) compare exactly rather than being excluded.
//
// Anti-vacuous, three ways:
//   - the per-slot manifest (test/goldens/slot-manifest.json) pins WHICH slots
//     are compiled, so a slot silently falling back to JS fails loudly;
//   - every compiled slot must MUTATE something in at least one corpus state
//     (a no-op compile cannot pass by agreeing about nothing);
//   - the vocabulary canaries (effect-differential.test.mjs) mutate the XML
//     per element type and require the differential to go red.

import crypto from "node:crypto";
import vm from "node:vm";
import { makeContext } from "./harness.mjs";
import { WIRED_FILES, WIRED_PREP, FM_INSTALL_SRC } from "./field-matrix.lib.mjs";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

// Full mutable-state hash: the tick-goldens surface (which already covers
// __snapshot's resources/town ledgers/story flags/skills/stats plus soulstones,
// buffs, dungeons, trials, prestige, loop counters, guild segments and the
// global scalars) plus the few effect-only globals nothing else reads.
const ED_INSTALL = `
// dungeons/trials are load()-initialized, not loadDefaults()-initialized
for (let i = 0; i < dungeons.length; i++) {
    dungeons[i].length = 0;
    for (let j = 0; j < dungeonFloors[i]; j++) dungeons[i][j] = { ssChance: 1, completed: 0, lastStat: "NA" };
}
for (let i = 0; i < trials.length; i++) {
    trials[i].length = 0;
    trials[i].highestFloor = 0;
    for (let j = 0; j < trialFloors[i]; j++) trials[i][j] = { completed: 0 };
}
function __effState() {
    const extras = {
        soulstones: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.soulstone ?? 0])),
        talents: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.talentLevelExp.exp])),
        buffAmts: Object.fromEntries(Object.entries(buffs).map(([k, v]) => [k, v.amt])),
        skillLevels: Object.fromEntries(Object.entries(skills).map(([k, v]) => [k, [v.levelExp.level, v.levelExp.exp]])),
        dungeons: dungeons.map(d => d.map(f => [f.ssChance, f.completed, f.lastStat])),
        trials: trials.map(t => [t.highestFloor ?? 0, ...t.map(f => f.completed)]),
        prestigeValues, goldInvested, trainingLimits, stonesUsed, stoneLoc,
        guild, effectiveTime, escapeStarted, portalUsed, totalMerchantMana, hearts,
        storyVars, storyMax, curTown, timer, timeNeeded, totals,
        suppliesCost: towns.map(t => t.suppliesCost ?? null),
        lootFrom: towns.map(t => {
            const o = {};
            for (const v of t.allVarNames) {
                for (const p of ["lootFrom", "checked", "good", "goodTemp", "total"]) {
                    const k = p + v;
                    // NaN survives the round trip only as a sentinel — several JS
                    // reward callbacks return nothing, which is exactly what the
                    // compiled bodies must reproduce
                    if (typeof t[k] === "number") o[k] = Number.isNaN(t[k]) ? "NaN" : t[k];
                }
            }
            return o;
        }),
        guildSegments: [curAdvGuildSegment, curCraftGuildSegment, curWizCollegeSegment,
            curFightFrostGiantsSegment, curFightJungleMonstersSegment, curThievesGuildSegment, curGodsSegment],
    };
    return __snapshot() + "|" + JSON.stringify(extras);
}
// the effect-only globals __fm.applyState does not own
function __effReset() {
    stoneLoc = 0;
    hearts.length = 0;
    totalMerchantMana = 7500;
}
// Run one (action, slot) and report what it did. Throws are captured verbatim
// (the Phase-4 rule) so a body that throws on both sides still compares.
// Which effect slots the LIVE JS actions carry. This is the denominator for
// the end-state claim: every slot a JS action has must be compiled from XML or
// explicitly native. Class-level methods count (AssassinAction defines finish
// and loopsFinished for eight actions; HaulAction's factory defines finish for
// four), which is why this reads the objects rather than grepping sources.
function __jsSlots() {
    const out = {};
    for (const a of totalActionList) {
        out[a.name] = ["finish", "loopsFinished", "segmentFinished", "floorReward", "cost", "story"]
            .filter(s => typeof a[s] === "function");
    }
    return JSON.stringify(out);
}
function __runSlot(name, slot) {
    const a = totalActionList.find(x => x.name === name);
    if (!a) return JSON.stringify({ missing: true });
    if (typeof a[slot] !== "function") return JSON.stringify({ absent: true });
    const before = __effState();
    let thrown = null;
    try {
        // story(completed) is the only slot taking an argument
        if (slot === "story") a.story(1); else a[slot]();
    } catch (e) {
        thrown = String(e && e.message || e);
    }
    const after = __effState();
    return JSON.stringify({ thrown, changed: before !== after, state: after });
}
`;

/** the (action, slot) worklist: everything the XML compiles, per the interpreter */
const SLOT_PLAN = `
globalThis.__slotPlan = (() => {
    const doc = ActionListXml.parseDocument(globalThis.actionListXmlText);
    const out = [];
    const nativeBySlot = {};
    // slots whose body is exactly <noEffect/> — declared no-ops. They are
    // inert on purpose, so the "must mutate something" assertion is inverted
    // for them: they must mutate NOTHING, anywhere.
    const declaredNoOp = [];
    const SLOT_ELEMENT = { finish: "reward", segmentFinished: "segmentReward",
        loopsFinished: "loopReward", floorReward: "floorReward", cost: "cost", story: "storyEffects" };
    for (const name in doc.actions) {
        const def = doc.actions[name];
        const f = ActionListXml.compileAction(def, doc);
        for (const s of f.__compiledSlots ?? []) {
            out.push([name, s]);
            const el = def.children.find(c => c.tag === SLOT_ELEMENT[s]);
            const kids = (el?.children ?? []).filter(c => c.tag !== "before" && c.tag !== "after");
            if (kids.length === 1 && kids[0].tag === "noEffect") declaredNoOp.push(name + "." + s);
        }
        for (const s of f.__nativeFields ?? []) {
            if (ActionListXml.SLOTS.includes(s)) (nativeBySlot[s] ??= []).push(name);
        }
    }
    return { pairs: out, nativeBySlot, declaredNoOp };
})();
`;

/**
 * Corpus states for effect execution. The Phase-3 field-matrix strata answer
 * "does this predicate agree"; effects additionally need states where the
 * reward paths actually FIRE — stocked resources for the cost() deductions,
 * populated limited pools for finishRegular's two branches, reputation gates.
 */
export function effectStates() {
    const states = [
        { id: "boot", spec: { profile: "boot" } },
        { id: "all-zero", spec: { profile: "zero" } },
        { id: "all-max", spec: { profile: "max" } },
    ];
    // stocked: every consumable held in quantity, so no cost() deduction is a
    // no-op and no canStart-shaped guard silently voids an effect
    const stocked = {
        gold: 1e7, reputation: 200, herbs: 5000, hide: 500, blood: 500, artifacts: 500,
        favors: 500, armor: 500, enchantments: 100, teamMembers: 5, houses: 60,
        potions: 500, map: 50, completedMap: 5, zombie: 30, pylons: 50, power: 5,
        supplies: true, glasses: true, pickaxe: true, loopingPotion: true, key: true,
        stone: false, pegasus: true, wizardCollege: true,
    };
    for (const profile of ["zero", "max"]) {
        states.push({ id: `${profile}:stocked`, spec: { profile, resources: stocked } });
    }
    // negative reputation opens the dark-path guards the stocked states close
    states.push({ id: "zero:stocked-dark", spec: { profile: "zero", resources: { ...stocked, reputation: -20 } } });
    // limited pools, both finishRegular branches: unchecked items remaining
    // (the "check a new item" branch) and banked goodTemp (the "spend a known
    // good" branch). ratio-aligned checked counts make the reward actually pay.
    states.push({ id: "pools:unchecked", spec: { profile: "zero", resources: stocked, pools: { total: 5000, checked: 0, good: 0, goodTemp: 0 } } });
    states.push({ id: "pools:banked", spec: { profile: "zero", resources: stocked, pools: { total: 5000, checked: 5000, good: 400, goodTemp: 400 } } });
    states.push({ id: "pools:ratio-edge", spec: { profile: "zero", resources: stocked, pools: { total: 5000, checked: 999, good: 99, goodTemp: 0 } } });
    // "how many did you spend THIS loop" is good minus goodTemp, and every
    // other pool stratum sets them equal (difference 0), so the story bodies
    // that gate on a spend of exactly N were indistinguishable — the
    // goodTempItems canary survived until these landed. Fourth corpus gap of
    // this shape: the differential only separates thresholds it straddles.
    for (const spent of [19, 20, 49, 50]) {
        states.push({ id: `pools:spent-${spent}`, spec: { profile: "zero", resources: stocked,
            pools: { total: 5000, checked: 5000, good: 100, goodTemp: 100 - spent } } });
    }
    states.push({ id: "pools:empty", spec: { profile: "zero", resources: stocked, pools: { total: 0, checked: 0, good: 0, goodTemp: 0 } } });
    // soulstone/talent stocks for the sacrifice and imbue families
    states.push({ id: "soulstones:rich", spec: { profile: "zero", soulstones: 1e6, resources: { ...stocked, reputation: -20 } } });
    states.push({ id: "soulstones:feast", spec: { profile: "zero", soulstones: 1e6, resources: { ...stocked, reputation: 200 } } });
    for (const g of ["", "Adventure", "Crafting", "Explorer", "Thieves", "Assassin"]) {
        states.push({ id: `guild:${g || "none"}`, spec: { profile: "max", guild: g, resources: stocked } });
    }
    // threshold ladder: the reward bodies gate story flags on resource counts
    // and limited-pool `good` counts at 5/10/15/20/25/50 — a corpus that only
    // ever holds "none" or "plenty" cannot tell those thresholds apart (two
    // canaries survived until these landed).
    for (const L of [1, 4, 5, 6, 9, 10, 11, 14, 15, 16, 19, 20, 21, 24, 25, 26, 49, 50, 51]) {
        states.push({
            id: `ladder:${L}`,
            spec: {
                // zero profile: "max" turns every story flag on, which hides
                // exactly the setStoryFlag thresholds this ladder exists to probe
                profile: "zero",
                resources: { ...stocked, gold: 1e7, reputation: 200, herbs: 5000, ...ladderResources(L) },
                pools: { total: 5000, checked: 5000, good: L, goodTemp: L },
            },
        });
    }
    // multipart loop counters: trial/dungeon floor = floor(loopCounter/segments),
    // so without these every currentFloor() reads 0 and no floor threshold can
    // be told from any other (it cost the currentFloor canary).
    // floor = loopCounter / segments, and segments differ per action (3..12),
    // so a threshold like "floor >= 10" is only distinguishable from ">= 11"
    // when SOME action sits at exactly floor 10 — hence the 10*s ladder.
    for (const k of [1, 3, 9, 27, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 300, 3000]) {
        states.push({ id: `loopCounters:${k}`, spec: { profile: "zero", loopCounters: k, resources: stocked } });
    }
    for (let k = 0; k < 24; k++) {
        states.push({ id: `random:${k}`, spec: { profile: "zero", random: 0x51D0 + k * 7919 } });
    }
    return states;
}

/** every count-gated resource held at exactly L */
function ladderResources(L) {
    const out = {};
    for (const k of ["armor", "enchantments", "houses", "teamMembers", "zombie", "favors",
        "artifacts", "potions", "pylons", "hide", "blood", "map", "completedMap", "power"]) {
        out[k] = L;
    }
    return out;
}

/**
 * Run the differential.
 * @param {object} [opts]
 * @param {string} [opts.xmlText]  overrides the carrier (canary hook)
 * @param {number} [opts.maxMismatches]
 * @param {string[]} [opts.onlyStates]
 * @param {string[]} [opts.onlyActions]  restrict the (action, slot) worklist.
 *   A vocabulary canary asserts "mutating element E changes behavior", and E
 *   lives in known actions — evaluating only those proves exactly the same
 *   thing at a fraction of the cost, which matters because the canary suite
 *   would otherwise sweep the whole corpus once PER canary.
 */
export function buildEffectDifferential({ xmlText = null, maxMismatches = 100, onlyStates = null, onlyActions = null } = {}) {
    const jsCtx = makeContext(777001);
    jsCtx.ev(FM_INSTALL_SRC);
    jsCtx.ev(ED_INSTALL);

    const wiredCtx = makeContext(777001, WIRED_FILES);
    if (xmlText) {
        wiredCtx.sandbox.__edXml = xmlText;
        wiredCtx.ev("globalThis.actionListXmlText = __edXml");
    }
    wiredCtx.ev(WIRED_PREP);
    wiredCtx.ev(FM_INSTALL_SRC);
    wiredCtx.ev(ED_INSTALL);
    wiredCtx.ev(SLOT_PLAN);
    const plan = JSON.parse(wiredCtx.ev("JSON.stringify(__slotPlan)"));
    plan.jsSlots = JSON.parse(jsCtx.sandbox.__jsSlots());

    const states = onlyStates ? effectStates().filter(s => onlyStates.includes(s.id)) : effectStates();
    const pairs = onlyActions ? plan.pairs.filter(([n]) => onlyActions.includes(n)) : plan.pairs;
    const mismatches = [];
    /** @type {Record<string, boolean>} */
    const mutated = {};
    /** (action, slot) pairs confirmed to hang at the high budget in BOTH arms */
    const knownHang = new Set();
    let comparisons = 0;

    for (const s of states) {
        if (mismatches.length >= maxMismatches) break;
        const apply = `__fm.applyState(${JSON.stringify(s.spec)}); __effReset();`;
        for (const [name, slot] of pairs) {
            const key = `${name}.${slot}`;
            mutated[key] ??= false;
            // identical starting state in both arms, identical RNG state
            jsCtx.ev(apply);
            wiredCtx.ev(apply);
            const rng = jsCtx.getRng();
            wiredCtx.setRng(rng);
            const j = runSlot(jsCtx, name, slot);
            const jRng = jsCtx.getRng().n - rng.n;
            const w = runSlot(wiredCtx, name, slot);
            const wRng = wiredCtx.getRng().n - rng.n;
            comparisons++;
            if (j.unreachable || w.unreachable) {
                // both arms agree on reachability (canStart is differential-proven);
                // a disagreement is itself a divergence worth reporting
                if (!!j.unreachable !== !!w.unreachable) {
                    mismatches.push({ state: s.id, name, slot, kind: "reachability", js: !!j.unreachable, xml: !!w.unreachable });
                }
                continue;
            }
            if (j.timedOut || w.timedOut) {
                // A wall-clock cap cannot tell "non-terminating" from "starved
                // by a byte-gate on the other 8 cores" — that produced a false
                // divergence on Totem.cost, whose body is a single addResource.
                // So a timeout is never a verdict on its own: confirm it at a
                // budget no scheduling blip can reach, and remember the pairs
                // that genuinely hang so the slow path runs once, not per state.
                if (knownHang.has(key)) continue;
                const j2 = runSlot(jsCtx, name, slot, CONFIRM_MS);
                const w2 = runSlot(wiredCtx, name, slot, CONFIRM_MS);
                if (j2.timedOut && w2.timedOut) { knownHang.add(key); continue; }
                if (!!j2.timedOut !== !!w2.timedOut) {
                    mismatches.push({ state: s.id, name, slot, kind: "timeout", js: !!j2.timedOut, xml: !!w2.timedOut });
                }
                continue;
            }
            if (j.missing || j.absent) {
                // the XML compiles a slot the JS action does not have: the
                // compiled body would ADD behavior, which is never correct here
                mismatches.push({ state: s.id, name, slot, kind: j.missing ? "no-such-action" : "js-slot-absent" });
                continue;
            }
            if (j.changed) mutated[key] = true;
            if (j.thrown !== w.thrown) {
                mismatches.push({ state: s.id, name, slot, kind: "throw", js: j.thrown, xml: w.thrown });
            } else if (sha(j.state) !== sha(w.state)) {
                mismatches.push({ state: s.id, name, slot, kind: "state", js: sha(j.state), xml: sha(w.state), diff: firstDiff(j.state, w.state) });
            } else if (jRng !== wRng) {
                mismatches.push({ state: s.id, name, slot, kind: "rng", js: jRng, xml: wRng });
            }
        }
    }

    const noOp = new Set(plan.declaredNoOp ?? []);
    const inert = Object.entries(mutated)
        .filter(([k, m]) => !m && !noOp.has(k)).map(([k]) => k).sort();
    // the inverse: a slot that DECLARES itself a no-op must never mutate
    const lyingNoOp = Object.entries(mutated)
        .filter(([k, m]) => m && noOp.has(k)).map(([k]) => k).sort();
    return { plan, states: states.length, comparisons, mismatches, inert, lyingNoOp };
}

/**
 * Invoke one slot with a wall-clock cap.
 *
 * sacrificeSoulstonesBySegments does not terminate when every stat has zero
 * soulstones: `count` is Math.min(ceil(amount/segments), 0) forever, so
 * `amount` never decreases. In play canStart's checkSoulstoneSac makes that
 * unreachable, but this harness invokes slots unconditionally — deliberately,
 * because gating on canStart collapses coverage (12 slots went inert when it
 * was tried; the anti-inert assertion caught it).
 *
 * The fast cap is 100ms — ~1000x headroom over a real body — but a wall clock
 * measures load as well as looping, so a cap alone produces FALSE divergences
 * under contention (it did: Totem.cost, whose body is one addResource, "timed
 * out" in one arm while a byte-gate saturated the machine). A timeout is
 * therefore only ever a hypothesis: it is confirmed at CONFIRM_MS, and pairs
 * that hang at that budget in both arms are remembered so the slow path runs
 * once per pair rather than once per state.
 * Both arms run the same shared helper, so agreeing timeouts are equivalence,
 * not divergence — a DISAGREEMENT is what gets reported.
 */
const CONFIRM_MS = 4000;

function runSlot(ctx, name, slot, ms = 100) {
    const expr = `__runSlot(${JSON.stringify(name)}, ${JSON.stringify(slot)})`;
    try {
        return JSON.parse(vm.runInContext(expr, ctx.sandbox, { timeout: ms }));
    } catch (e) {
        return { timedOut: true, message: String(e && e.message || e) };
    }
}

/** first differing key path between two state JSON blobs, for readable failures */
function firstDiff(a, b) {
    const [as, ae] = a.split("|"), [bs, be] = b.split("|");
    for (const [x, y, where] of [[as, bs, "snapshot"], [ae, be, "extras"]]) {
        if (x === y) continue;
        const ox = JSON.parse(x), oy = JSON.parse(y);
        for (const k of Object.keys(ox)) {
            const sx = JSON.stringify(ox[k]), sy = JSON.stringify(oy[k]);
            if (sx !== sy) return `${where}.${k}: ${trunc(sx)} != ${trunc(sy)}`;
        }
    }
    return "(unlocated)";
}
const trunc = (s) => s && s.length > 200 ? s.slice(0, 200) + "…" : s;

/**
 * The end-state claim, checkable rather than asserted: for every action, every
 * effect slot its JS carries is either compiled from XML or explicitly native.
 * Returns the shortfall — empty means Phase 6 covers the whole surface.
 */
export function uncoveredSlots(plan) {
    const compiled = new Set(plan.pairs.map(([n, s]) => `${n}.${s}`));
    const native = new Set();
    for (const [slot, names] of Object.entries(plan.nativeBySlot ?? {})) {
        for (const n of names) native.add(`${n}.${slot}`);
    }
    const out = [];
    for (const [name, slots] of Object.entries(plan.jsSlots ?? {})) {
        for (const s of slots) {
            const key = `${name}.${s}`;
            if (!compiled.has(key) && !native.has(key)) out.push(key);
        }
    }
    return out.sort();
}

/** the frozen per-slot manifest shape (golden) */
export function slotManifest(plan) {
    /** @type {Record<string, string[]>} */
    const compiled = {};
    for (const [name, slot] of plan.pairs) (compiled[slot] ??= []).push(name);
    for (const k in compiled) compiled[k].sort();
    const native = {};
    for (const [slot, names] of Object.entries(plan.nativeBySlot)) native[slot] = [...names].sort();
    return {
        compiled: Object.fromEntries(Object.entries(compiled).sort(([a], [b]) => a < b ? -1 : 1)),
        counts: Object.fromEntries(Object.entries(compiled).map(([k, v]) => [k, v.length]).sort(([a], [b]) => a < b ? -1 : 1)),
        native,
    };
}
