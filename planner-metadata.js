// planner-metadata.js — declarative per-action metadata for the Advanced
// Automation planner's INFORMED vocabulary mode (`plannerVocabulary`).
//
// Rationale (multitown plan §11.8 piece 2 + ACTION-CENSUS.md §2.4): the
// canStart-needs prober (plProbeCanStartNeeds) raises RESOURCES positively to
// discover a gate; it cannot express NON-resource gates — guild membership,
// mutual-exclusion joins, negative/upper-bound resource clauses, soulstone
// stocks, talent/buff/skill floors, or time gates. Such actions measure
// exec=0 from a same-town single-action probe even when unlocked and
// strategically pivotal, so no empirical profile ever forms. This table
// DECLARES those gates so informed mode can satisfy the reachable ones during
// measurement, and so the §11.10 targeted-mode chain builder can traverse the
// dependency edges the prober is blind to.
//
// STRUCTURE ONLY. Empirical measurement stays authoritative for RATES; AP
// randomization (v1) rewires rates and pool contents, not gate STRUCTURE, so
// this table stays valid under randomization. It lives HERE, not in
// actionList.js (game files stay vanilla-diffable); AP integration later
// swaps/patches this table and keeps pure-empirical as the fallback. It must
// load BEFORE planner.js (script order in index.html / planner-worker.js /
// the headless harness) — planner.js reads it defensively (`typeof`-guarded),
// so an unloaded table degrades to "no gates", never a crash.
//
// Every entry was transcribed from the action's canStart() in actionList.js
// (verified 2026-07-12), NOT copied from the census summary.
//
// Gate vocabulary (all fields optional per action):
//   guild:      string   — canStart requires `guild === <value>`. Informed
//                          mode sets the guild global for the probe, satisfying
//                          membership without simulating the multi-rank join.
//   guildEmpty: true     — a guild-JOIN action (canStart `guild === ""`);
//                          mutually exclusive with the other joins per loop.
//   repMax:     number    — canStart requires reputation <= repMax (0 or
//                          negative). Informed mode clamps reputation to repMax
//                          for the probe and never injects it.
//   resourceMax:{res:n}  — canStart requires the resource strictly below n.
//   resourceMin:{res:n}  — canStart requires the resource above 0 (paired max).
//   soulstoneSac:true    — canStart calls checkSoulstoneSac (needs a stock).
//   talentFloor:string   — needs a per-stat talent floor tied to a buff level.
//   buffFloor:{buff:n}   — needs getBuffLevel(buff) >= n.
//   skillFloor:{skill:n} — canStart needs getSkillLevel(skill) >= n.
//   timeMax:    number    — canStart gated on effectiveTime < value.
//
// v1 informed MEASUREMENT satisfies `guild` and `repMax` only (both are pure
// state the probe can set). The remaining gates (soulstoneSac, talentFloor,
// buffFloor, resourceMax/Min combat trials, timeMax) are declared for §11.10
// traversal and honesty — they still measure exec=0 until v2 adds setup
// chains for them.

const PLANNER_METADATA = {
    gates: {
        // ---- guild membership (canStart: guild === "<name>") ----
        "Apprentice": { guild: "Crafting" },
        "Mason": { guild: "Crafting" },
        "Architect": { guild: "Crafting" },
        // Build Housing also needs Citizen>=100 && houses<max (progress +
        // resource, both prober-visible) — only the guild clause is declared.
        "Build Housing": { guild: "Crafting" },
        // Gather Team also needs gold >= (teamMembers+1)*100 (prober-visible).
        "Gather Team": { guild: "Adventure" },
        "Pick Pockets": { guild: "Thieves" },
        "Rob Warehouse": { guild: "Thieves" },
        "Insurance Fraud": { guild: "Thieves" },

        // ---- guild JOIN actions (canStart: guild === "") ----
        "Adventure Guild": { guildEmpty: true },
        "Crafting Guild": { guildEmpty: true },
        "Explorers Guild": { guildEmpty: true },
        // Thieves Guild join ALSO requires reputation < 0.
        "Thieves Guild": { guildEmpty: true, repMax: -1 },
        "Guild Assassin": { guildEmpty: true },

        // ---- negative / upper-bound resource clauses ----
        "Dark Magic": { repMax: 0 },
        // Dark Ritual: reputation <= -5 && loopCounter===0 && soulstoneSac &&
        // Ritual buff below cap. repMax + soulstoneSac declared; v1 measures
        // exec=0 (needs a rep-sink + stones — v2 setup chains).
        "Dark Ritual": { repMax: -5, soulstoneSac: true },
        // Great Feast: reputation >= 100 (positive floor, prober-visible) +
        // soulstoneSac + Feast buff cap. Only the non-resource gate declared.
        "Great Feast": { soulstoneSac: true },
        // Combat trials: power upper (and lower) bounds — declared, not yet
        // satisfied (power is a within-loop combat resource).
        "Gods Trial": { resourceMax: { power: 7 } },
        "Challenge Gods": { resourceMin: { power: 1 }, resourceMax: { power: 8 } },

        // ---- stocks / floors (declared for §11.10; v1 measures exec=0) ----
        "Imbue Mind": { soulstoneSac: true },
        "Imbue Body": { talentFloor: "Imbuement2" },
        "Imbue Soul": { buffFloor: { Imbuement: 500, Imbuement2: 500 } },

        // ---- time ----
        "Escape": { timeMax: 60 },
    },
};
