// @ts-check
"use strict";

// managed.js — Archipelago substrate "managed mode" (fork addition).
//
// Active ONLY when the page is loaded with ?managed=1; on every other boot
// this file defines an inert object and changes nothing. In managed mode the
// page becomes a host-driven engine:
//
//   - the game clock NEVER starts (recalcInterval is gated in driver.js), so
//     time advances only through the step()/tick hooks below;
//   - saves live in a dedicated localStorage slot ("idleLoops_substrate"),
//     so a managed session can never touch the player's real save;
//   - cloud saves stay off (options.googleCloud defaults false and nothing
//     in managed mode enables it; with no tick loop there is no autosave);
//   - <html> gets a "managed-mode" class for host CSS.
//
// Boot still runs the game's real load() (against the substrate slot):
// load() owns init that plain loadDefaults() misses (stonesUsed,
// townsUnlocked, option normalization), and the clock gate keeps it from
// starting timers. "Skip auto-load" from the plan means "don't load the
// PLAYER's save", which the dedicated slot guarantees.
//
// Hook surface (substrate plan §4). singleTick()/addMana()/restart() are
// existing engine globals; this object is the stable host-facing wrapper.

const IdleLoopsManaged = (() => {
    const active = typeof window !== "undefined"
        && typeof window.location !== "undefined"
        && new URLSearchParams(window.location.search).get("managed") === "1";

    /** @type {(() => void)[]} */
    const restartCallbacks = [];

    // ---- region overlay (fork addition, arc C) -----------------------------
    // Region splitting is "region-overlay on ONE town": the town's structure
    // (which vars exist) is shared across its regions; only the numeric VALUE
    // props are per-region, swapped in/out on region entry. Per-region state
    // lives HOST-side (the bridge holds the snapshots keyed by region id); this
    // layer only knows how to read/write the active region's copy off the town
    // object. All of this is managed-mode-only and off the vanilla path — no
    // synthetic action is ever registered unless the host calls in.

    /** The last region metadata the host installed (drives the exit gate). */
    let activeRegionMeta = null;
    /** withoutSpaces keys of the synthetic exit actions we registered. */
    const syntheticActionKeys = new Set();

    /** Progress vars cap at level 100 == 505000 exp (both scalings). */
    const PROGRESS_EXP_CAP = 505000;

    /**
     * The swappable value-prop keys for a town, derived from its three var
     * lists (NOT a hardcoded key list — future-proofs a different split town).
     * Mirrors createVars/createProgressVars/createMultipartVars (town.js).
     */
    function regionStateKeys(town) {
        const keys = [];
        for (const v of town.varNames) {
            keys.push(`checked${v}`, `goodTemp${v}`, `good${v}`, `lootFrom${v}`, `total${v}`);
        }
        for (const v of town.progressVars) keys.push(`exp${v}`);
        for (const v of town.multipartVars) keys.push(`${v}`, `${v}LoopCounter`);
        return keys;
    }

    /** Queue a per-var repaint for a swapped-in region (browser only). */
    function refreshRegionViews(town) {
        if (typeof view === "undefined") return;
        view.requestUpdate("updateLockedHidden", null);
        view.updateNextActions();
        for (const v of town.varNames) view.requestUpdate("updateRegular", { name: v, index: town.index });
        for (const v of town.progressVars) view.requestUpdate("updateProgressAction", { name: v, town });
    }

    /**
     * Is the active region's exit runnable? True (no gate) when no region is
     * active or the region declares no explore var. Otherwise the active
     * region's Explore-var progress toward its cap must reach the configured
     * threshold (default 1.0 = 100% explored).
     */
    function regionExitAvailable() {
        if (!activeRegionMeta) return true;
        const { townIndex = 0, exploreVar, exploreThreshold = 1.0 } = activeRegionMeta;
        if (exploreVar == null) return true;
        const town = towns[townIndex];
        if (!town) return true;
        const exp = town[`exp${exploreVar}`] ?? 0;
        return Math.min(1, exp / PROGRESS_EXP_CAP) >= exploreThreshold;
    }

    // ---- unlock view fan-out (page-only) -----------------------------------
    // unlocks.js is view-free on purpose (workers load it), so knowing which
    // panels a changed row invalidates is this layer's job. Both helpers are
    // typeof-guarded like setAwardSchedule: the headless test harness and the
    // parity sims have no view.

    /** rows changed answer -> the action lists and the locked/hidden filter */
    function refreshUnlockViews() {
        if (typeof view === "undefined") return;
        view.updateNextActions();
        view.requestUpdate("updateLockedHidden", null);
    }

    /** managed capacity changed -> recompute totals, then repaint those rows */
    function refreshQuantityViews(varNames) {
        adjustAll();
        if (typeof view === "undefined" || typeof towns === "undefined") return;
        for (const varName of varNames) {
            const t = towns.find((tw) => tw.varNames?.includes(varName));
            if (t) view.requestUpdate("updateRegular", { name: varName, index: t.index });
        }
    }

    function boot() {
        // eslint-disable-next-line no-global-assign
        saveName = "idleLoops_substrate";
        document.documentElement.classList.add("managed-mode");
        load();
        setScreenSize();
    }

    return {
        active,
        boot,

        // ---- persistence -------------------------------------------------
        /** Replace the whole game state from a save JSON string. */
        loadSave(saveJson) { load(false, saveJson); },
        /** Serialize (and store in the substrate slot); returns the JSON. */
        exportSave() { return save(); },

        // ---- state readout (plan §4: getFullState) ------------------------
        // Unlock state appears here as COUNTS only: getFullState is polled
        // every step, and the full 934-row readout belongs in the on-demand
        // getUnlockState() below.
        getFullState() {
            return {
                unlocks: {
                    achieved: Unlocks.achieved.size,
                    suppressed: Unlocks.suppressed.size,
                    granted: Unlocks.granted.size,
                    qManaged: Object.fromEntries(Unlocks.qManagedBatches),
                },
                timer,
                timeNeeded,
                manaLeft: timeNeeded - timer,
                loops: totals.loops,
                totalTicks: totals.effectiveTime,
                curTown,
                townsUnlocked: [...townsUnlocked],
                resources: { ...resources },
                skills: Object.fromEntries(Object.entries(skills)
                    .map(([name, s]) => [name, { exp: s.exp ?? 0, level: getSkillLevel(name) }])),
                buffs: Object.fromEntries(Object.entries(buffs)
                    .map(([name, b]) => [name, b.amt ?? 0])),
                townLevels: towns.map(t => Object.fromEntries(
                    t.progressVars.map(v => [v, t.getLevel(v)]))),
                stoppedAt: gameIsStopped,
            };
        },

        // ---- stepping ----------------------------------------------------
        /** Advance the engine by n single ticks (host-driven time). */
        step(n = 1) {
            for (let i = 0; i < n; i++) singleTick();
        },

        // ---- state write / loop control -----------------------------------
        /** Host mana sync: extend the current loop's budget. */
        addMana(amount) { addMana(amount); },
        /** Host-driven loop reset (the game's own restart()). */
        restartLoop() { restart(); },

        // ---- P2 award carrier (world data; actionListXml.js §2d seam) -----
        /**
         * Install (or clear, with null) the world-data award schedule.
         * The carrier consults it inside the XML executor's grant
         * dispatcher, so installing a schedule turns the compiled reward
         * path on (apply/revert is idempotent; XML ≡ JS by the effect
         * differential, so the flip itself changes no behavior).
         * @returns {boolean} true when installed (or cleared)
         */
        setAwardSchedule(schedule) {
            if (typeof ActionListXml === "undefined") {
                if (schedule != null) console.error("managed setAwardSchedule: actionListXml.js not loaded; schedule ignored");
                return schedule == null;
            }
            const prevLootables = Object.keys(ActionListXml.getAwardSchedule()?.lootables ?? {});
            const ok = ActionListXml.setAwardSchedule(schedule ?? null);
            if (ok && schedule != null && !options.useActionListXml) {
                options.useActionListXml = true;
                ActionListXml.applyOverrides();
            }
            // Queue a row refresh for every lootable the OLD or NEW schedule
            // names, so the §9b-pre details row appears/disappears without
            // waiting for a harvest (the bridge drains the view queue after
            // install).
            if (ok && typeof view !== "undefined" && typeof towns !== "undefined") {
                const names = new Set([...prevLootables,
                    ...Object.keys(schedule?.lootables ?? {})]);
                for (const varName of names) {
                    const t = towns.find((tw) => tw.varNames?.includes(varName));
                    if (t) view.requestUpdate("updateRegular", { name: varName, index: t.index });
                }
            }
            return ok;
        },
        /** Register the outbound hook foreign schedule entries call. */
        setForeignAwardCallback(cb) {
            if (typeof ActionListXml === "undefined") return;
            ActionListXml.setForeignAwardHook(cb);
        },

        // ---- AP unlock surface (plan §7.2–§7.4 / §9 U5) --------------------
        /**
         * Install (or clear, with null) the whole randomized unlock overlay:
         * `{suppressed, granted, qBatches}`. The bulk push — boot,
         * reconnect, and the post-prestige re-push the bridge drives off
         * onRestart. Replace-whole, so the host never has to diff.
         * Throws on an unknown row id, a `q:` id outside qBatches, or an
         * excluded/ill-formed managed var (the seam validates before it
         * mutates, so a rejected overlay leaves the live one intact).
         */
        setUnlockOverlay(overlay) {
            const prevManaged = [...Unlocks.qManagedBatches.keys()];
            Unlocks.installOverlay(overlay ?? null);
            Unlocks.check();
            refreshUnlockViews();
            const touched = new Set([...prevManaged, ...Unlocks.qManagedBatches.keys()]);
            if (touched.size) refreshQuantityViews(touched);
        },
        /**
         * The AP item for one unlock row arrived. Idempotent (a Set add), so
         * a re-sent item or a reconnect replay costs one no-op check().
         */
        grantUnlock(id) {
            const row = Unlocks.rowById(id);
            if (!row) throw new Error(`managed grantUnlock: unknown row id ${id}`);
            if (Unlocks.isQuantityRow(row)) {
                throw new Error(`managed grantUnlock: ${id} is a quantity row — use grantQuantityStep(varName)`);
            }
            Unlocks.granted.add(id);
            Unlocks.check();
            refreshUnlockViews();
        },
        /**
         * The AP "<Var> Supply Step" item arrived: one more granted batch of
         * capacity for `varName`. Progressive, so the i-th copy = step i and
         * arrival order does not matter.
         * @returns {number} the new batch count
         */
        grantQuantityStep(varName) {
            const n = Unlocks.grantQuantityStep(varName);
            refreshQuantityViews([varName]);
            return n;
        },
        /**
         * Seed the ids the server already holds (checkedLocations on
         * connect), so the full pass at load() does not re-announce a
         * finished game. Survives prestige by design (unlocks.js §5.3).
         */
        seedReportedLocations(ids) { Unlocks.seedReported(ids); },
        /**
         * Full unlock readout, on demand (NOT per step — see getFullState).
         * @returns {{rows: Record<string, {achieved: boolean, suppressed: boolean, granted: boolean}>,
         *            quantities: Record<string, {batches: number, ratio: number, rowCount: number}>}}
         */
        getUnlockState() {
            const rows = {};
            for (const row of [...Unlocks.getRows(), ...Unlocks.getQuantityRows()]) {
                rows[row.id] = {
                    achieved: Unlocks.achieved.has(row.id),
                    suppressed: Unlocks.suppressed.has(row.id),
                    granted: Unlocks.granted.has(row.id),
                };
            }
            const quantities = {};
            for (const [varName, m] of Unlocks.quantityMeta()) {
                quantities[varName] = {
                    batches: Unlocks.qManagedBatches.get(varName) ?? null,
                    ratio: m.ratio,
                    rowCount: m.rowCount,
                };
            }
            return { rows, quantities };
        },
        /**
         * The location trigger. ONE multiplexed consumer for both families —
         * the bridge tells them apart by the `q:` id prefix, and every
         * location it maps is keyed by that same id anyway.
         */
        onUnlockAchieved(cb) {
            Unlocks.onUnlockAchieved = (id) => cb(id);
            Unlocks.onQuantityStep = (id) => cb(id);
        },
        /** Per-completed-action hook (the Phase-E leftover unlocks.js reserves). */
        onActionCompleted(cb) { Unlocks.onActionCompleted = cb; },

        // ---- region overlay (arc C) --------------------------------------
        /**
         * Read the active region's swappable value props off `towns[townIndex]`
         * into a plain snapshot the host can stash. ZERO new fork save keys —
         * the vanilla flat namespace only ever holds the ACTIVE region's copy.
         */
        dumpRegionState(townIndex) {
            const town = towns[townIndex];
            if (!town) throw new Error(`managed dumpRegionState: no town ${townIndex}`);
            const snapshot = {};
            for (const k of regionStateKeys(town)) snapshot[k] = town[k];
            return snapshot;
        },
        /**
         * Write a region's value props back onto `towns[townIndex]`. `null` =
         * a fresh region (every minted var at its createVars zero-state). Runs
         * `adjustAll()` on BOTH branches (re-derives levels/totals and re-pins
         * managed totals — the region-swap generalization of "anything touching
         * the overlay must nudge adjustAll") and a full `Unlocks.check()` so
         * event/view state is provably fresh (a restore can't mint new crossings
         * — levels don't move between dump and load — so this is belt-and-braces).
         */
        loadRegionState(townIndex, snapshot) {
            const town = towns[townIndex];
            if (!town) throw new Error(`managed loadRegionState: no town ${townIndex}`);
            const fresh = snapshot == null;
            for (const k of regionStateKeys(town)) town[k] = fresh ? 0 : (snapshot[k] ?? 0);
            adjustAll();
            Unlocks.check();
            refreshRegionViews(town);
        },
        /**
         * Install (or clear, with null) the active region's metadata: which
         * explore var + threshold the exit gate reads. Clears any synthetic
         * exit actions the previous region registered — the host re-injects the
         * new region's exits right after (mirrors the jta clear-then-inject
         * order on region change).
         */
        setActiveRegion(regionMeta) {
            this.clearSyntheticActions();
            activeRegionMeta = regionMeta ?? null;
        },
        /** Is the active region's exit gate open (Explore % >= threshold)? */
        regionExitAvailable,
        /**
         * Register one synthetic exit action (managed-mode-only) queueable by
         * NAME through the Action prototype, whose finish() invokes `cb`. It is
         * registered AFTER initializeActions(), so it never enters
         * `totalActionList`, the planner census, or the static/dynamic DOM — it
         * is resolvable only via getActionPrototype (the queue's name lookup).
         * The exit gate rides its canStart(): below threshold it reads as
         * unrunnable, exactly like a locked action. Vanilla enumeration and the
         * byte-exact replay gate never see it (they never enter managed mode).
         */
        injectSyntheticAction(def, cb) {
            const name = def?.name;
            if (typeof name !== "string" || !name) {
                return { ok: false, error: "injectSyntheticAction: def.name (string) required" };
            }
            const key = name.replace(/ /gu, "");
            if (key in Action) {
                return { ok: false, error: `injectSyntheticAction: '${name}' collides with an existing action` };
            }
            const townNum = def.townNum ?? 0;
            Action[key] = new Action(name, {
                type: "normal",
                expMult: 1,
                townNum,
                stats: {},                       // empty stats -> adjustedTicks 1 (completes fast)
                manaCost() { return 1; },
                visible() { return true; },
                unlocked() { return true; },
                canStart() { return regionExitAvailable(); },
                finish() { if (typeof cb === "function") cb(); },
            });
            syntheticActionKeys.add(key);
            return { ok: true, name };
        },
        /**
         * Remove every synthetic exit action registered by injectSyntheticAction
         * and purge any that are still sitting in the live queue (so a later
         * restart's translateClassNames can't throw on a now-unknown name).
         */
        clearSyntheticActions() {
            if (syntheticActionKeys.size === 0) return { removed: 0 };
            if (typeof actions !== "undefined") {
                actions.clearActions((a) => syntheticActionKeys.has(a.name.replace(/ /gu, "")));
                if (Array.isArray(actions.current)) {
                    actions.current = actions.current.filter(
                        (a) => !syntheticActionKeys.has(a.name.replace(/ /gu, "")));
                }
            }
            const removed = syntheticActionKeys.size;
            for (const key of syntheticActionKeys) delete Action[key];
            syntheticActionKeys.clear();
            return { removed };
        },

        // ---- callbacks ----------------------------------------------------
        /** Register a loop-reset callback (fired from driver restart()). */
        onRestart(cb) { restartCallbacks.push(cb); },
        _onRestart() {
            for (const cb of restartCallbacks) {
                try { cb(); } catch (e) { console.error("managed onRestart callback failed", e); }
            }
        },
    };
})();
