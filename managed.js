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
        // unlock-table state joins this readout once the §5 discretization
        // refactor exists; until then unlocks stay implicit in the formulas
        getFullState() {
            return {
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
