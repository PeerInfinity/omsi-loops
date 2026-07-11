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
