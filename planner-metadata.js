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

    // ---- dimEffects (Layer M; ACTION-CENSUS.md §2.2a/§2.2c) --------------------
    // The effect-EDGE table, keyed by DIMENSION (skill:X / buff:X) rather than by
    // action: many actions grant the same skill, and the efficiency effect belongs
    // to the LEVEL, not the granting action. Each edge declares WHERE a dim's level
    // changes another action's channel; empirical measurement stays authoritative
    // for RATES (this only tells the Layer-P prober where to POINT).
    //   edge = { target?: actionName, targetType?: "multipart", channel }
    //     target      → a concrete action W3 pair-probes (the highest-leverage case);
    //     targetType  → an action CLASS (all multiparts) — declared, probed per-member;
    //     absent      → a global/game-wide effect (declared for coverage, not probed).
    // Channels (census taxonomy): manaCost, goldCost, goldYield, manaYield,
    //   segmentRate, speed, poolSize, trainingLimits, startingStats, expMult, plus
    //   soulstoneCount / sacrificeCost (census-derived; no plan-10 channel fits the
    //   soulstone-grant magnitude or the buff-sacrifice discount).
    // AP randomization (v1) rewires rates/pool contents, not this edge STRUCTURE.
    dimEffects: {
        // ---- buffs (census 2.2a): each buff's downstream channel ----
        "buff:Ritual":      [{ channel: "speed" }],                               // Dark Ritual: per-zone/global game speed
        "buff:Imbuement":   [{ channel: "trainingLimits" }],                      // Imbue Mind: +1 training cap / lvl
        "buff:Imbuement2":  [{ channel: "startingStats" }],                       // Imbue Body: starting stat levels / loop
        "buff:Feast":       [{ targetType: "multipart", channel: "segmentRate" }],// Great Feast: ×(1+0.05lvl) combat
        "buff:Heroism":     [{ channel: "expMult" }],                             // Heroes Trial: Combat/Pyro/Restoration exp
        "buff:Aspirant":    [{ channel: "expMult" }],                             // The Spire: ×(1+0.01lvl) talent exp
        "buff:Imbuement3":  [{ channel: "speed" }],                               // Imbue Soul: +0.5/lvl global speed

        // ---- skill-level efficiency web (census 2.2c) — the #4 high-leverage class ----
        "skill:Practical":  [
            { target: "Wild Mana",   channel: "manaCost" },
            { target: "Smash Pots",  channel: "manaCost" },
            { target: "Pick Locks",  channel: "goldYield" },
            { target: "Short Quest", channel: "goldYield" },
            { target: "Long Quest",  channel: "goldYield" },
        ],
        "skill:Dark":       [
            { target: "Smash Pots",  channel: "manaYield" },
            { target: "Wild Mana",   channel: "manaYield" },
        ],
        "skill:Alchemy":    [{ target: "Sell Potions", channel: "goldYield" }],   // revenue = potions × Alchemy LEVEL
        "skill:Mercantilism": [
            { target: "Buy Mana Z1", channel: "manaYield" },
            { target: "Buy Mana Z3", channel: "manaYield" },
            { target: "Buy Mana Z5", channel: "manaYield" },
            { target: "Collect Interest", channel: "goldYield" },
        ],
        "skill:Thievery":   [
            { target: "Pick Locks",      channel: "goldYield" },
            { target: "Gamble",          channel: "goldYield" },
            { target: "Pick Pockets",    channel: "goldYield" },
            { target: "Rob Warehouse",   channel: "goldYield" },
            { target: "Insurance Fraud", channel: "goldYield" },
        ],
        "skill:Chronomancy": [{ channel: "speed" }],                             // global speed mult
        "skill:Divine":     [{ channel: "soulstoneCount" }],                     // scales dungeon/mine soulstone grant
        "skill:Restoration": [{ target: "Rescue Survivors", channel: "segmentRate" }], // + Open Portal skill-floor gate
        "skill:Spatiomancy": [{ channel: "poolSize" }],                          // adjustAll resizes pools game-wide
        "skill:Wunderkind": [{ channel: "expMult" }],                            // talent exp mult; doubles Imbuement2
        "skill:Commune":    [{ target: "Dark Ritual", channel: "sacrificeCost" }],
        "skill:Gluttony":   [{ target: "Great Feast", channel: "sacrificeCost" }],
        "skill:Combat":     [{ targetType: "multipart", channel: "segmentRate" }], // Fight Monsters/dungeons/trolls/giants/Spire
        "skill:Leadership": [{ targetType: "multipart", channel: "segmentRate" }], // team size → combat
        "skill:Crafting":   [
            { target: "Apprentice", channel: "segmentRate" },
            { target: "Mason",      channel: "segmentRate" },
            { target: "Architect",  channel: "segmentRate" },
        ],
    },

    // ---- context flags (Layer M; census 2.3/2.4) ------------------------------
    // Per-action shape warnings the prober's point-measurement can't see. Advisory
    // metadata: informed measurement may re-probe temporal/dynamic actions, and
    // rng-flagged measurement/candidates REQUIRE rngMode "cycle" (plan §6). All
    // hand-transcribed from census §2.3 + the §3 flag column.
    //   temporal  — probe-time yield/gate ≠ realized (effectiveTime-dependent)
    //   dynamic   — reward amount scales with a loop-varying rank/counter
    //   rng       — reward path draws Math.random (the four §2.3 sites)
    //   crossTown — writes progress/pools in OTHER towns (Layer E crossTown{})
    context: {
        "Mana Well":        { temporal: true },
        "Escape":           { temporal: true },
        "Seek Blessing":    { dynamic: true },
        "Prepare Buffet":   { dynamic: true },
        "Guild Assassin":   { dynamic: true },
        "Meander":          { dynamic: true },
        "Apprentice":       { dynamic: true },
        "Mason":            { dynamic: true },
        "Architect":        { dynamic: true },
        "Pick Pockets":     { dynamic: true },
        "Rob Warehouse":    { dynamic: true },
        "Insurance Fraud":  { dynamic: true },
        "Excursion":        { dynamic: true },
        "Collect Interest": { dynamic: true },
        "Collect Taxes":    { dynamic: true },
        "Explore Jungle":   { dynamic: true },
        "Face Judgement":   { dynamic: true },   // dynamic DESTINATION (excluded from v1 routes)
        "Small Dungeon":    { rng: true },
        "Large Dungeon":    { rng: true },
        "The Spire":        { rng: true },
        "Mine Soulstones":  { rng: true },
        "Explorers Guild":  { rng: true, crossTown: true },   // exchangeMap: RNG zone pick + cross-town survey exp
        "Build Tower":      { crossTown: true },
        "RuinsZ1":          { crossTown: true },
        "RuinsZ3":          { crossTown: true },
        "RuinsZ5":          { crossTown: true },
        "RuinsZ6":          { crossTown: true },
        "Spatiomancy":      { crossTown: true },
    },
};
