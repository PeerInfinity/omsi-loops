// managed-unlocks.test.mjs — U5: the AP unlock overlay seam, its worldConfig
// transport, and the IdleLoopsManaged host surface (plan §7.2–§7.4 and the
// [U5 PLANNING PASS — 2026-07-20] block).
//
// What is under test is the SURFACE, not the mechanics: U3 already proves
// enforcement and U4 already proves batch substitution, so the legs here ask
// whether the host's calls reach those machines intact, and whether the whole
// thing stays inert with nothing installed (leg 4's "neither" case is the
// byte-inert contract the V3 gate then confirms behaviourally).
//
// The prestige leg drives the REAL `prestigeWithNewValues` — prestige.js and
// saving.js are both in the harness SIM_FILES — because the contract it
// checks is precisely that no load()/restart()/wipe path touches the overlay.
// A hand-rolled fake wipe would verify nothing about the code that runs.
//
// Harness notes: `suppressed`/`granted`/`qManagedBatches` are module-level
// state, so every leg builds its own vm context (the
// quantity-substitution.test.mjs precedent); and `restart()` on an empty
// queue reaches pauseGame(), which touches a DOM node this harness stubs as
// null — so any leg that restarts queues an action first.
//
// Town-0 constants (as in quantity-substitution.test.mjs): Pots = 5/level over
// a batch of 10 => 50 rows, ratio 10; Locks = 1/level over a batch of 10 =>
// 10 rows, ratio 10. Predicate milestones: u:Locks / u:BuyGlasses /
// u:BuyManaZ1 at Wander 20, u:Met at 22.

import test from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "./harness.mjs";

const SEED = 12345;

/** a booted managed context with a queued action and adjustAll already run */
function boot() {
    const ctx = makeContext(SEED, ["managed.js"]);
    ctx.setQueue([["Wander", 3]]);
    ctx.ev("adjustAll()");
    return ctx;
}

const json = (ctx, expr) => JSON.parse(ctx.ev(`JSON.stringify(${expr} ?? null)`));
const overlay = (ctx) => json(ctx, "Unlocks.buildOverlay()");
const install = (ctx, o) =>
    ctx.ev(`IdleLoopsManaged.setUnlockOverlay(${JSON.stringify(o ?? null)})`);

/** set town-0 Wander to exactly `level` and recompute (the U4 recipe) */
function setWander(ctx, level) {
    ctx.ev(`towns[0].expWander = towns[0].expFromLevel(${level}); adjustAll(); Unlocks.check();`);
    assert.equal(ctx.ev("towns[0].getLevel('Wander')"), level, "level recipe missed");
}

const effective = (ctx, id) =>
    ctx.ev(`Unlocks.effective(Unlocks.rowById(${JSON.stringify(id)}))`);
const blocked = (ctx, varName) =>
    ctx.ev(`Unlocks.blocked({ varName: ${JSON.stringify(varName)} })`);

// ---------------------------------------------------------------------------

test("leg 1: overlay truth table — suppression gates, grant overrides dims", () => {
    const ctx = boot();

    // baseline: at Wander 25 the town-0 milestones are locally satisfied
    setWander(ctx, 25);
    assert.equal(effective(ctx, "u:Locks"), true, "locally unlocked before suppression");
    assert.equal(blocked(ctx, "Locks"), false);

    // suppressed: the row's EFFECT is AP-managed, so a satisfied local
    // condition no longer unlocks it
    install(ctx, { suppressed: ["u:Locks"], granted: [], qBatches: {} });
    assert.equal(blocked(ctx, "Locks"), true, "suppressed + ungranted = blocked");
    assert.equal(effective(ctx, "u:Locks"), false, "dims satisfied but suppressed");
    // the row beside it is untouched
    assert.equal(effective(ctx, "u:BuyGlasses"), true, "non-suppressed row perturbed");
    assert.equal(blocked(ctx, "BuyGlasses"), false);

    // granted overrides the dims entirely — true even with nothing achieved
    install(ctx, { suppressed: ["u:Locks"], granted: ["u:Locks"], qBatches: {} });
    setWander(ctx, 0);
    assert.equal(effective(ctx, "u:Locks"), true, "granted must survive a zero-dim world");
    assert.equal(blocked(ctx, "Locks"), false, "granted rows are not blocked");
    // ...while an unsuppressed row does re-lock when its dims fall
    assert.equal(effective(ctx, "u:BuyGlasses"), false);
});

test("leg 2: quantity surface — qBatches reaches the U4 substitution", () => {
    const ctx = boot();
    setWander(ctx, 0);
    install(ctx, { suppressed: [], granted: [], qBatches: { Pots: 3 } });
    assert.equal(ctx.ev("towns[0].totalPots"), 30, "3 batches x ratio 10");
    // capacity is item-driven now: levels no longer move it, and the
    // unmanaged var beside it still tracks vanilla
    for (const L of [7, 40, 100]) {
        setWander(ctx, L);
        assert.equal(ctx.ev("towns[0].totalPots"), 30, `managed Pots at Wander ${L}`);
        assert.equal(ctx.ev("towns[0].totalLocks"), L, `unmanaged Locks at Wander ${L}`);
    }
    // clearing the overlay hands capacity back to the levels
    install(ctx, null);
    assert.equal(ctx.ev("towns[0].totalPots"), 100 * 5, "cleared -> back to vanilla");
    assert.equal(overlay(ctx), null, "empty overlay serializes as null");
});

test("leg 3: grantUnlock is idempotent; grantQuantityStep increments", () => {
    const ctx = boot();
    setWander(ctx, 0);
    install(ctx, { suppressed: ["u:Locks"], granted: [], qBatches: {} });

    ctx.ev(`IdleLoopsManaged.grantUnlock("u:Locks")`);
    assert.equal(effective(ctx, "u:Locks"), true);
    ctx.ev(`IdleLoopsManaged.grantUnlock("u:Locks")`);   // must not throw
    assert.equal(ctx.ev("Unlocks.granted.size"), 1, "double grant = one entry");
    assert.equal(effective(ctx, "u:Locks"), true);

    // progressive quantity items: the i-th copy = step i
    for (let i = 1; i <= 3; i++) {
        assert.equal(ctx.ev(`IdleLoopsManaged.grantQuantityStep("Pots")`), i);
        assert.equal(ctx.ev("towns[0].totalPots"), i * 10, `after step ${i}`);
    }
    assert.deepEqual(overlay(ctx).qBatches, { Pots: 3 });
});

test("leg 4: worldConfig transport — round-trip and all four null contracts", () => {
    const SCHEDULE = {
        version: 1,
        awards: { BuyManaZ1: { mana: [{ name: "reputation", count: 7 }] } },
    };
    const OVERLAY = { suppressed: ["u:Locks", "u:BuyGlasses"], granted: ["u:Locks"], qBatches: { Pots: 4 } };
    const cfg = (ctx) => json(ctx, "ActionListXml.buildWorldConfig()");
    const put = (ctx, c) => ctx.ev(`ActionListXml.installWorldConfig(${JSON.stringify(c ?? null)})`);
    const xmlOn = (ctx) => ctx.ev("options.useActionListXml");

    // (a) neither — the byte-inert leg: a default world still sends null
    const none = boot();
    assert.equal(cfg(none), null, "clean context sends no worldConfig");
    assert.equal(put(none, null), true, "null against a clean context is a no-op");
    assert.equal(cfg(none), null);
    assert.equal(xmlOn(none), false);

    // (b) schedule only — the pre-U5 shape survives, unlocks half is null
    const sched = boot();
    assert.equal(put(sched, { awardSchedule: SCHEDULE, lootPrefs: {} }), true);
    const schedCfg = cfg(sched);
    assert.deepEqual(schedCfg.awardSchedule, SCHEDULE);
    assert.deepEqual(schedCfg.lootPrefs, {});
    assert.equal(schedCfg.unlocks, null, "no overlay -> null half");
    assert.equal(xmlOn(sched), true, "a schedule flips useActionListXml");

    // (c) overlay only — carried WITHOUT flipping the option (the unlock
    // table has been always-on since the U1 cutover)
    const src = boot();
    install(src, OVERLAY);
    const overlayCfg = cfg(src);
    assert.equal(overlayCfg.awardSchedule, null);
    assert.equal(overlayCfg.lootPrefs, null);
    assert.deepEqual(overlayCfg.unlocks, OVERLAY);
    assert.equal(xmlOn(src), false, "an overlay must NOT flip useActionListXml");

    // ...and it installs into a FRESH context through the worker path
    const dst = boot();
    assert.equal(put(dst, overlayCfg), true);
    assert.deepEqual(overlay(dst), OVERLAY, "overlay survives the transport");
    assert.deepEqual(cfg(dst), overlayCfg, "transport is a fixed point");
    // installOverlay deliberately does not refresh — a worker's sim reaches
    // the substitution through its own adjustAll, which is what this models
    dst.ev("adjustAll()");
    assert.equal(dst.ev("towns[0].totalPots"), 40, "and the sim runs the managed capacity");
    assert.equal(xmlOn(dst), false);

    // (d) both halves at once
    const both = boot();
    assert.equal(put(both, { awardSchedule: SCHEDULE, lootPrefs: {}, unlocks: OVERLAY }), true);
    const bothCfg = cfg(both);
    assert.deepEqual(bothCfg.awardSchedule, SCHEDULE);
    assert.deepEqual(bothCfg.unlocks, OVERLAY);
    // each half clears independently
    assert.equal(put(both, { awardSchedule: SCHEDULE, lootPrefs: {} }), true);
    assert.equal(cfg(both).unlocks, null, "absent unlocks half clears the overlay");
    assert.equal(both.ev("ActionListXml.getAwardSchedule() !== null"), true, "schedule half untouched");
});

test("leg 5: prestige — the overlay survives the wipe; totals re-pin; seeds hold", () => {
    const ctx = boot();
    setWander(ctx, 25);

    // one row already banked server-side, one not
    ctx.ev(`
        globalThis.__events = [];
        IdleLoopsManaged.onUnlockAchieved((id) => __events.push(id));
        IdleLoopsManaged.seedReportedLocations(["u:Met"]);
        globalThis.__restarts = 0;
        IdleLoopsManaged.onRestart(() => { globalThis.__restarts++; });
    `);
    install(ctx, { suppressed: ["u:Locks"], granted: ["u:Locks"], qBatches: { Pots: 3 } });
    assert.equal(ctx.ev("towns[0].totalPots"), 30);
    ctx.ev("__events.length = 0");

    // Browser surface the real load() path touches, shimmed exactly as
    // field-matrix.lib.mjs's makeFixtureContext does — these are the three
    // things a headless vm lacks, none of them sim state.
    ctx.ev(`
        closeTutorial = () => {};
        globalThis.window = globalThis;      // doLoad reads window.localStorage
        globalThis.loadChallenge = () => {}; // challenges.js is not a sim file; mode 0 is a no-op anyway
        recalcInterval = () => {};           // would start a real setInterval in the vm
    `);
    // ...and a permissive element stub for the duration, as a real browser has
    // during load(); restored to null after, because null IS load-bearing for
    // the tick path's search-toggle semantics (harness.mjs).
    ctx.ev(`
        const __el = () => Object.assign(new HTMLInputElement(), {
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            style: {}, textContent: "", value: "", checked: false,
        });
        document.getElementById = () => __el();
        prestigeWithNewValues(prestigeValues, { Imbuement3: 0 });
        document.getElementById = () => null;
    `);

    // the wipe took the dims...
    assert.equal(ctx.ev("towns[0].getLevel('Wander')"), 0, "prestige did not wipe progress");
    assert.equal(ctx.ev("__restarts"), 1, "_onRestart fired inside prestige's restart()");
    // ...but not the host-authoritative overlay
    assert.deepEqual(overlay(ctx), {
        suppressed: ["u:Locks"], granted: ["u:Locks"], qBatches: { Pots: 3 },
    }, "overlay must survive the wipe — losing foreign grants is the JtA defect");
    assert.equal(effective(ctx, "u:Locks"), true, "granted row still granted post-wipe");
    // substituted totals re-pin: load() restored saved totals, then adjustAll
    // recomputed over them
    assert.equal(ctx.ev("towns[0].totalPots"), 30, "managed capacity re-pinned after the wipe");

    // re-crossing re-announces (the server dedupes) — EXCEPT the seeded id
    ctx.ev("__events.length = 0");
    setWander(ctx, 25);
    const log = JSON.parse(ctx.ev("JSON.stringify(__events)"));
    assert.ok(log.includes("u:Locks"), "a re-crossed row must re-emit");
    assert.ok(log.includes("u:BuyGlasses"), "and so must its neighbours");
    assert.ok(!log.includes("u:Met"), "a seeded (server-banked) id must stay silent");
});

test("leg 6: validation throws at INSTALL, leaving the live overlay intact", () => {
    const ctx = boot();
    const GOOD = { suppressed: ["u:Locks"], granted: [], qBatches: { Pots: 2 } };
    install(ctx, GOOD);

    const rejects = (o, re) => {
        assert.throws(() => install(ctx, o), re);
        assert.deepEqual(overlay(ctx), GOOD, "a rejected overlay must not half-apply");
    };
    rejects({ suppressed: ["u:NoSuchAction"], granted: [], qBatches: {} }, /unknown row id/);
    rejects({ suppressed: [], granted: ["v:Nope"], qBatches: {} }, /unknown row id/);
    // quantity capacity rides qBatches ONLY
    rejects({ suppressed: ["q:0:Pots:1"], granted: [], qBatches: {} }, /quantity row/);
    rejects({ suppressed: [], granted: ["q:0:Pots:1"], qBatches: {} }, /quantity row/);
    // excluded vars can never be randomized; counts must be sane
    rejects({ suppressed: [], granted: [], qBatches: { StonesZ1: 1 } }, /excluded from randomization/);
    rejects({ suppressed: [], granted: [], qBatches: { NoSuchVar: 1 } }, /no quantity rows/);
    rejects({ suppressed: [], granted: [], qBatches: { Pots: -1 } }, /non-negative integer/);
    rejects({ suppressed: [], granted: [], qBatches: { Pots: 1.5 } }, /non-negative integer/);

    // the managed-surface grants validate too
    assert.throws(() => ctx.ev(`IdleLoopsManaged.grantUnlock("u:Nope")`), /unknown row id/);
    assert.throws(() => ctx.ev(`IdleLoopsManaged.grantUnlock("q:0:Pots:1")`), /quantity row/);
    assert.throws(() => ctx.ev(`IdleLoopsManaged.grantQuantityStep("StonesZ1")`), /excluded from randomization/);
});

test("leg 7: readout shapes — full in getUnlockState, counts in getFullState", () => {
    const ctx = boot();
    setWander(ctx, 25);
    install(ctx, { suppressed: ["u:Locks"], granted: ["u:Locks"], qBatches: { Pots: 3 } });

    const st = json(ctx, "IdleLoopsManaged.getUnlockState()");
    assert.deepEqual(st.rows["u:Locks"], { achieved: true, suppressed: true, granted: true });
    assert.deepEqual(st.rows["u:BuyGlasses"], { achieved: true, suppressed: false, granted: false });
    assert.deepEqual(st.rows["q:0:Pots:1"], { achieved: true, suppressed: false, granted: false });
    assert.equal(Object.keys(st.rows).length, ctx.ev("Unlocks.getRows().length + Unlocks.getQuantityRows().length"));
    // quantities: ratio/rowCount come from the minted rows, batches only when managed
    assert.deepEqual(st.quantities.Pots, { batches: 3, ratio: 10, rowCount: 50 });
    assert.deepEqual(st.quantities.Locks, { batches: null, ratio: 10, rowCount: 10 });

    // getFullState is polled per step, so it carries counts only
    const full = json(ctx, "IdleLoopsManaged.getFullState()");
    assert.deepEqual(full.unlocks, {
        achieved: ctx.ev("Unlocks.achieved.size"),
        suppressed: 1,
        granted: 1,
        qManaged: { Pots: 3 },
    });
    assert.ok(full.unlocks.achieved > 0, "a Wander-25 world has achieved rows");
    assert.equal(full.unlocks.rows, undefined, "the full readout must not ride the polled state");
});
