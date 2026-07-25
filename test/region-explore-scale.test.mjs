// Per-region Explore rescale (fork addition, arc D2 slice 2b).
//
// A region (arc C: an overlay on ONE town) is meant to behave like a mini-town
// compressed into N Explore levels. That gives `Town` TWO VIEWS of level:
//
//   - EFFECTIVE (getLevel) = min(100, floor(raw * 100 / N)) — the SCHEDULE
//     view: unlock rows, action visible/unlocked thresholds, the UI %, and the
//     exit gate. Schedules compress into the region's N levels.
//   - RAW (getRawLevel), hard-capped at N by the exp clamp — the
//     DISCOVERY-QUANTITY view. The <totalDiscovered> curves are linear in
//     level, so the raw cap PARTITIONS the town's discoverables across its
//     regions instead of handing each one the full complement.
//
// Like the rest of the region overlay this is managed-mode-only and off the
// vanilla path; the byte-gate is what proves the inertness, and these checks
// pin the behaviour on both sides of the falsy check.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

const PROGRESS = "Wander";   // town 0's explore progress var (default scaling)
const QUANTITY = "Pots";     // Smash Pots — a <totalDiscovered> driven by Wander
const EXP_CAP = 505000;      // level 100, both scalings

/** expFromLevel on the default (quadratic) curve. */
const expAt = (level) => level * (level + 1) * 50;

function withRegion(ev, { max, threshold = 1.0, exploreVar = PROGRESS } = {}) {
    ev(`IdleLoopsManaged.setActiveRegion(${JSON.stringify({
        townIndex: 0, exploreVar, exploreThreshold: threshold,
        ...(max === undefined ? {} : { exploreMaxLevel: max }),
    })})`);
}

test("no rescale installed: both views agree and the cap is vanilla", () => {
    const { ev } = makeContext(12345, ["managed.js"]);

    assert.equal(ev("Town.regionScale"), null, "vanilla path installs no scale");
    for (const raw of [0, 1, 17, 100]) {
        ev(`towns[0].exp${PROGRESS} = ${expAt(raw)}`);
        assert.equal(ev(`towns[0].getRawLevel(${JSON.stringify(PROGRESS)})`), raw);
        assert.equal(ev(`towns[0].getLevel(${JSON.stringify(PROGRESS)})`), raw,
            "effective == raw with no rescale");
    }
    assert.equal(ev(`towns[0].expCap(${JSON.stringify(PROGRESS)})`), EXP_CAP);

    // An arc-C region that declares no exploreMaxLevel (every pre-2b preset)
    // installs nothing either — the knob is opt-in.
    withRegion(ev, { max: undefined });
    assert.equal(ev("Town.regionScale"), null, "a region without the knob stays vanilla");
});

test("the effective view compresses the ladder; the raw view keeps its pace", () => {
    const { ev } = makeContext(12345, ["managed.js"]);
    withRegion(ev, { max: 10 });

    assert.deepEqual(JSON.parse(ev("JSON.stringify(Town.regionScale)")), { 0: { [PROGRESS]: 10 } });
    for (const [raw, effective] of [[0, 0], [1, 10], [5, 50], [9, 90], [10, 100]]) {
        ev(`towns[0].exp${PROGRESS} = ${expAt(raw)}`);
        assert.equal(ev(`towns[0].getRawLevel(${JSON.stringify(PROGRESS)})`), raw);
        assert.equal(ev(`towns[0].getLevel(${JSON.stringify(PROGRESS)})`), effective,
            `raw ${raw} of 10 reads as ${effective}%`);
    }

    // Only the region's OWN explore var rescales; the town's other progress
    // vars keep vanilla pace (the knob is a region-length dial, not a
    // difficulty multiplier).
    ev("towns[0].expSecrets = " + expAt(4));
    assert.equal(ev("towns[0].getLevel('Secrets')"), 4, "a non-explore var is untouched");
});

test("exp is hard-capped at the region's own maximum", () => {
    const { ev } = makeContext(12345, ["managed.js"]);
    withRegion(ev, { max: 10 });

    assert.equal(ev(`towns[0].expCap(${JSON.stringify(PROGRESS)})`), expAt(10));
    ev(`towns[0].exp${PROGRESS} = 0`);
    ev(`towns[0].finishProgress(${JSON.stringify(PROGRESS)}, 999999)`);
    assert.equal(ev(`towns[0].exp${PROGRESS}`), expAt(10), "a huge gain clamps to the region cap");
    assert.equal(ev(`towns[0].getLevel(${JSON.stringify(PROGRESS)})`), 100, "capped == 100% explored");

    // The capped-already fast path is the THIRD literal site, and it is the one
    // that silently rots if only the two clamp sites move: at a region cap the
    // `=== 505000` equality would never match, so this early return (and the
    // pauseOnComplete branch hanging off it) would stop working. Witness it by
    // the observable half — pauseOnComplete must fire AT the region cap.
    ev("options.pauseOnComplete = true; globalThis.__paused = null;"
        + " globalThis.pauseGame = (_, msg) => { globalThis.__paused = msg; };");
    ev(`towns[0].finishProgress(${JSON.stringify(PROGRESS)}, 1)`);
    assert.match(ev("String(globalThis.__paused)"), /Progress complete/,
        "the capped-already branch fires at the REGION cap, not only at 505000");
});

test("discovery quantities PARTITION across regions (the raw view)", () => {
    const { ev } = makeContext(12345, ["managed.js"]);

    // The whole town, fully explored: the full complement.
    ev(`towns[0].exp${PROGRESS} = ${EXP_CAP}; adjustAll()`);
    const fullTown = ev(`towns[0].total${QUANTITY}`);
    assert.ok(fullTown > 0, "sanity: the quantity var has a level-driven total");

    // A tenth-of-a-town region, fully explored to ITS maximum: a tenth of the
    // complement. The curve is linear in level, so the partition falls out of
    // the raw cap — no formula rewriting anywhere.
    const { ev: ev2 } = makeContext(12345, ["managed.js"]);
    withRegion(ev2, { max: 10 });
    ev2(`towns[0].exp${PROGRESS} = ${expAt(10)}; adjustAll()`);
    assert.equal(ev2(`towns[0].getLevel(${JSON.stringify(PROGRESS)})`), 100,
        "region reads as fully explored");
    assert.equal(ev2(`towns[0].total${QUANTITY}`), Math.round(fullTown / 10),
        "a 1/10 region discovers 1/10 of the town's items, not all of them");

    // The refutation this test exists for: had the quantity curves read the
    // EFFECTIVE level, a fully-explored region would hold the whole town.
    assert.notEqual(ev2(`towns[0].total${QUANTITY}`), fullTown);

    // The unlock table's quantity-row dot product is the OTHER raw consumer,
    // and it is the one that decides how many AP quantity steps a region can
    // ever fire. Same partition, measured on the row side.
    const firstRow = `Unlocks.getQuantityRows().find(r => r.dims.includes(${JSON.stringify(PROGRESS)}))`;
    const baseAtFullTown = ev(`Unlocks.quantityBaseTotal(${firstRow})`);
    const baseAtRegionCap = ev2(`Unlocks.quantityBaseTotal(${firstRow})`);
    assert.equal(baseAtFullTown, fullTown, "sanity: the base rate IS the town's complement");
    assert.equal(baseAtRegionCap, Math.round(fullTown / 10),
        "quantity rows evaluate on raw levels, so a 1/10 region stays inside its share");

    // Which is the same statement counted in rows: a tenth of the region's
    // steps are reachable, not all of them.
    const reachable = (e) => e(`Unlocks.getQuantityRows().filter(r => r.dims.includes(${JSON.stringify(PROGRESS)})`
        + ` && r.trigger.baseTotalAtLeast <= Unlocks.quantityBaseTotal(r)).length`);
    assert.equal(reachable(ev2), Math.round(reachable(ev) / 10),
        "a 1/10 region fires a tenth of the town's quantity steps");
});

test("action schedules compress: thresholds fire at effective levels", () => {
    const { ev } = makeContext(12345, ["managed.js"]);
    withRegion(ev, { max: 10 });

    // Buy Glasses opens at Wander 20 in vanilla. Under a 10-level region that
    // is raw level 2 — the region reaches the same content in a tenth of the
    // grind, which is the point of the compression.
    ev(`towns[0].exp${PROGRESS} = ${expAt(1)}; adjustAll(); Unlocks.check();`);
    const atRaw1 = ev("Action.BuyGlasses.unlocked()");
    ev(`towns[0].exp${PROGRESS} = ${expAt(2)}; adjustAll(); Unlocks.check();`);
    const atRaw2 = ev("Action.BuyGlasses.unlocked()");
    assert.equal(atRaw1, false, "raw 1 (= 10%) is below the 20% threshold");
    assert.equal(atRaw2, true, "raw 2 (= 20%) opens a vanilla level-20 gate");

    // Control: the same raw levels leave it locked without the rescale.
    const { ev: plain } = makeContext(12345, ["managed.js"]);
    plain(`towns[0].exp${PROGRESS} = ${expAt(2)}; adjustAll(); Unlocks.check();`);
    assert.equal(plain("Action.BuyGlasses.unlocked()"), false,
        "control: raw level 2 unlocks nothing on the vanilla ladder");
});

test("the exit gate is a fraction of the REGION's cap", () => {
    const { ev } = makeContext(12345, ["managed.js"]);
    withRegion(ev, { max: 10, threshold: 1.0 });

    ev(`towns[0].exp${PROGRESS} = ${expAt(10) - 1}`);
    assert.equal(ev("IdleLoopsManaged.regionExitAvailable()"), false, "one exp short -> closed");
    ev(`towns[0].exp${PROGRESS} = ${expAt(10)}`);
    assert.equal(ev("IdleLoopsManaged.regionExitAvailable()"), true, "at the region cap -> open");

    // Control, so "open" above is the REGION's ceiling doing the work and not
    // the gate being trivially satisfiable: the same exp against a region that
    // declares no maximum is still 1% of the town and stays shut.
    withRegion(ev, { max: undefined, threshold: 1.0 });
    assert.equal(ev("IdleLoopsManaged.regionExitAvailable()"), false,
        "control: without the knob that exp is nowhere near the town's cap");

    // A half-explored threshold is half of the REGION's ceiling, not half the
    // town's — the fraction keeps its meaning, the exp it stands for shrinks.
    const { ev: half } = makeContext(12345, ["managed.js"]);
    withRegion(half, { max: 10, threshold: 0.5 });
    half(`towns[0].exp${PROGRESS} = ${Math.ceil(expAt(10) * 0.5)}`);
    assert.equal(half("IdleLoopsManaged.regionExitAvailable()"), true,
        "50% of a 10-level region opens a 0.5 threshold");
    assert.ok(Math.ceil(expAt(10) * 0.5) < EXP_CAP * 0.5,
        "and that is far less exp than 50% of the town would be");
});

test("installing a lower maximum clamps exp that is already above it", () => {
    const { ev } = makeContext(12345, ["managed.js"]);
    withRegion(ev, { max: 40 });
    ev(`towns[0].exp${PROGRESS} = ${expAt(30)}`);

    // Re-entering the same region with a smaller ceiling must not strand exp
    // above it: finishProgress's capped-already equality would never match,
    // so the var would never read as complete again.
    withRegion(ev, { max: 10 });
    assert.equal(ev(`towns[0].exp${PROGRESS}`), expAt(10), "stored exp clamps to the new cap");
    assert.equal(ev(`towns[0].getLevel(${JSON.stringify(PROGRESS)})`), 100);
});

test("a region swap recomputes the schedule under the INCOMING ladder", () => {
    const { ev } = makeContext(12345, ["managed.js"]);

    // The host swaps region VALUE state first (loadRegionState, whose adjustAll
    // + Unlocks.check run under the OUTGOING region's ladder) and installs the
    // region's metadata second — so setActiveRegion owes the recompute, and
    // nothing else is going to do it. Witness it on a SCHEDULE consumer: the
    // quantity totals are raw-driven and would not move, but an unlock row
    // reading the effective level flips the moment the ladder changes.
    withRegion(ev, { max: 100 });
    ev(`towns[0].exp${PROGRESS} = ${expAt(2)}; adjustAll(); Unlocks.check();`);
    assert.equal(ev("Action.BuyGlasses.unlocked()"), false,
        "raw 2 of 100 is 2% explored — the level-20 gate is shut");

    // Swap to a 10-level region carrying the same exp, and touch NOTHING else:
    // no adjustAll, no Unlocks.check from the test.
    withRegion(ev, { max: 10 });
    assert.equal(ev("Action.BuyGlasses.unlocked()"), true,
        "setActiveRegion re-evaluated the rows under the incoming ladder");
});

test("the rescale rides the worldConfig transport to sim contexts", () => {
    const { ev } = makeContext(12345, ["managed.js"]);
    withRegion(ev, { max: 10 });

    // The planner's engine copy is NOT managed and would otherwise sim vanilla
    // levels — plan and play must agree near a threshold (the P2-A principle).
    const cfg = JSON.parse(ev("JSON.stringify(ActionListXml.buildWorldConfig())"));
    assert.deepEqual(cfg.regionScale, { 0: { [PROGRESS]: 10 } });

    const { ev: worker } = makeContext(12345, []);
    assert.equal(worker("Town.regionScale"), null);
    worker(`ActionListXml.installWorldConfig(${JSON.stringify(cfg)})`);
    assert.deepEqual(JSON.parse(worker("JSON.stringify(Town.regionScale)")), { 0: { [PROGRESS]: 10 } });
    worker(`towns[0].exp${PROGRESS} = ${expAt(5)}`);
    assert.equal(worker(`towns[0].getLevel(${JSON.stringify(PROGRESS)})`), 50,
        "the sim context reads the same effective ladder the live game runs");

    // Stateless per call: a null config clears it, same contract as the other
    // two halves.
    worker("ActionListXml.installWorldConfig(null)");
    assert.equal(worker("Town.regionScale"), null);

    // And a world with no schedule, no overlay and no rescale still builds the
    // identical null payload — that is what keeps the transport byte-inert.
    const { ev: plain } = makeContext(12345, []);
    assert.equal(plain("ActionListXml.buildWorldConfig()"), null);
});
