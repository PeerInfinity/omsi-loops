function startGame() {
    // load calls recalcInterval, which will start the callbacks
    load();
    setScreenSize();
}

function cheat() {
    if (gameSpeed === 1) gameSpeed = 20;
    else gameSpeed = 1;
}

function cheatBonus()
{
    totalOfflineMs = 1000000000000000;
}

function cheatSurvey()
{
    for(let i= 0; i<9; i++)
    {
        const varName = "SurveyZ" + i
        towns[i][`exp${varName}`] = 505000;
        view.updateProgressAction({name: varName, town: towns[i]});
    }
}

function cheatProgress()
{
    for (const action of totalActionList)
    {
        if (action.type == "progress")
        {
            towns[action.townNum][`exp${action.varName}`] = 505000;
            view.updateProgressAction({name: action.varName, town: towns[action.townNum]});
        }
    }
    stonesUsed = {1:250, 3:250, 5:250, 6:250};
}

function cheatTalent(stat, targetTalentLevel)
{
    if (stat === "all" || stat === "All")
        for (const stat of statList)
        stats[stat].talentLevelExp.setLevel(targetTalentLevel);
    else stats[stat].talentLevelExp.setLevel(targetTalentLevel);
    view.updateStats();
}

function cheatSoulstone(stat, targetSS)
{
    if (stat === "all" || stat === "All")
        for (const stat in stats)
            stats[stat].soulstone = targetSS;
    else stats[stat].soulstone = targetSS;
    view.updateSoulstones();
}

function cheatSkill(skill, targetSkillLevel)
{
    if (skill === "all" || skill === "All")
        for (const skill of skillList)
            skills[skill].levelExp.setLevel(targetSkillLevel);
    else skills[skill].levelExp.setLevel(targetSkillLevel);
    view.updateSkills();
}


let mainTickLoop;
const defaultSaveName = "idleLoops1";
const challengeSaveName = "idleLoopsChallenge";
let saveName = defaultSaveName;

const selfIsWorker = typeof window === "undefined";
const selfIsGame = typeof View !== "undefined";

const timeNeededInitial = 5 * 50;
// eslint-disable-next-line prefer-const
let timer = timeNeededInitial;
// eslint-disable-next-line prefer-const
let timeNeeded = timeNeededInitial;
// eslint-disable-next-line prefer-const
let gameIsStopped = false;
const view = selfIsGame ? new View() : null;
const actions = new Actions();
const actionLog = selfIsGame ? new ActionLog() : null;
/**
 * @template {number} Count Number of towns
 * @template {any[]} [Towns=[]] Tuple of towns
 * @typedef {Towns["length"] extends Count ? Towns : TownList<Count, [...Towns, Town<Towns["length"]> & Record<string, number>]>} TownList
 */

const towns = /** @type {TownList<9>} */(/** @type {Town[]} */([]));
// accessor for typed towns with vars. CANNOT be used in actionList.js, will cause circular references
/** @type {<const TN extends TownNum>(townNum: TN) => Town<TN> & TownVars<TN>} */
function _town(townNum) {
    // @ts-ignore
    return towns[townNum];
}

// Both of the following express the same thing, but the first introduces a dependency on the action list.
/* * @typedef {TownNumOf<AnyAction>} TownNum */
/** @typedef {NumOfTown<towns[number]>} TownNum */

/** @type {TownNum} */
let curTown = 0;

function initializeTowns() {
    for (let i = 0; i <= 8; i++) {
        // @ts-ignore
        towns[i] = new Town(i);
    }
}

const statList = /** @type {const} */(["Dex", "Str", "Con", "Spd", "Per", "Cha", "Int", "Luck", "Soul"]);
/** @typedef {typeof statList[number]} StatName */
const stats = /** @type {{[K in StatName]: Stat}} */({});
let totalTalent = 0;
// eslint-disable-next-line prefer-const
let shouldRestart = true;

// let prestigeValues = {};

// let prestigeCurrentPoints = 0;
// let prestigeTotalPoints = 0;
// let completedCurrentPrestige = false;
// let completedAnyPrestige = true; // Set to false once method is setup to complete Current game

// eslint-disable-next-line prefer-const
let resources = {
    gold: 0,
    reputation: 0,
    herbs: 0,
    hide: 0,
    potions: 0,
    teamMembers: 0,
    armor: 0,
    blood: 0,
    artifacts: 0,
    favors: 0,
    enchantments: 0,
    houses: 0,
    pylons: 0,
    zombie: 0,
    map: 0,
    completedMap: 0,
    heart: 0,
    power: 0,
    glasses: false,
    supplies: false,
    pickaxe: false,
    loopingPotion: false,
    citizenship: false,
    pegasus: false,
    key: false,
    stone: false,
    wizardCollege: false,
};
let hearts = [];
const resourcesTemplate = copyObject(resources);
//Temp variables
// eslint-disable-next-line prefer-const
let guild = "";
let escapeStarted = false;
let portalUsed = false;
let stoneLoc = 0;

let curLoadout = 0;
/** @type {NextActionEntry[][]} */
let loadouts;
/** @type {string[] & {"-1"?: string}} */
let loadoutnames;
//let loadoutnames = ["1", "2", "3", "4", "5"];
const skillList = /** @type {const} */(["Combat", "Magic", "Practical", "Alchemy", "Crafting", "Dark", "Chronomancy", "Pyromancy", "Restoration", "Spatiomancy", "Mercantilism", "Divine", "Commune", "Wunderkind", "Gluttony", "Thievery", "Leadership", "Assassin"]);
/** @typedef {typeof skillList[number]} SkillName */
const skills = /** @type {{[K in SkillName]: Skill}} */({});
const buffList = /** @type {const} */(["Ritual",
    "Imbuement",
    "Imbuement2",
    "Feast",
    "Aspirant",
    "Heroism",
    "Imbuement3",
    "PrestigePhysical",
    "PrestigeMental",
    "PrestigeCombat",
    "PrestigeSpatiomancy",
    "PrestigeChronomancy",
    "PrestigeBartering",
    "PrestigeExpOverflow"
]);
/** @typedef {typeof buffList[number]} BuffName */
/** @typedef {Extract<BuffName, `Prestige${string}`>} PrestigeBuffName */

/** @returns {name is StatName} */
function isStatName(name) { return statList.includes(name); }
/** @returns {name is SkillName} */
function isSkillName(name) { return skillList.includes(name); }
/** @returns {name is BuffName} */
function isBuffName(name) { return buffList.includes(name); }

const dungeonFloors = [6, 9, 20];
const trialFloors = [50, 100, 7, 1000, 25];
const buffHardCaps = {
    Ritual: 666,
    Imbuement: 500,
    Imbuement2: 500,
    Imbuement3: 7,
    Feast: 100,
    Aspirant: 20,
    Heroism: 50,
    PrestigePhysical: 100,
    PrestigeMental: 100,
    PrestigeCombat: 100,
    PrestigeSpatiomancy: 100,
    PrestigeChronomancy: 100,
    PrestigeBartering: 100,
    PrestigeExpOverflow: 100
};
const buffCaps = {
    Ritual: 666,
    Imbuement: 500,
    Imbuement2: 500,
    Imbuement3: 7,
    Feast: 100,
    Aspirant: 20,
    Heroism: 50,
    PrestigePhysical: 100,
    PrestigeMental: 100,
    PrestigeCombat: 100,
    PrestigeSpatiomancy: 100,
    PrestigeChronomancy: 100,
    PrestigeBartering: 100,
    PrestigeExpOverflow: 100
};
const buffs = /** @type {{[K in BuffName]: Buff}} */({});
const prestigeValues = {};
let goldInvested = 0;
let stonesUsed;
// eslint-disable-next-line prefer-const
let townShowing = 0;
// eslint-disable-next-line prefer-const
let actionStoriesShowing = false;
let townsUnlocked = [];
let completedActions = [];
let statShowing;
let skillShowing;
let buffShowing;
let curActionShowing;
let dungeonShowing;
let trainingLimits = 10;
let storyShowing = 0;
let storyMax = 0;
let unreadActionStories;

/** @typedef {keyof typeof storyFlags} StoryFlagName */
const storyFlags = {
    maxSQuestsInALoop: false,
    realMaxSQuestsInALoop: false,
    maxLQuestsInALoop: false,
    realMaxLQuestsInALoop: false,
    heal10PatientsInALoop: false,
    failedHeal: false,
    clearSDungeon: false,
    haggle: false,
    haggle15TimesInALoop: false,
    haggle16TimesInALoop: false,
    glassesBought: false,
    partyThrown: false,
    partyThrown2: false,
    strengthTrained: false,
    suppliesBought: false,
    suppliesBoughtWithoutHaggling: false,
    smallDungeonAttempted: false,
    satByWaterfall: false,
    dexterityTrained: false,
    speedTrained: false,
    birdsWatched: false,
    darkRitualThirdSegmentReached: false,
    brewed50PotionsInALoop: false,
    failedBrewPotions: false,
    failedBrewPotionsNegativeRep: false,
    potionBrewed: false,
    failedGamble: false,
    failedGambleLowMoney: false,
    potionSold: false,
    sell20PotionsInALoop: false,
    sellPotionFor100Gold: false,
    sellPotionFor1kGold: false,
    manaZ3Bought:false,
    advGuildTestsTaken: false,
    advGuildRankEReached: false,
    advGuildRankDReached: false,
    advGuildRankCReached: false,
    advGuildRankBReached: false,
    advGuildRankAReached: false,
    advGuildRankSReached: false,
    advGuildRankUReached: false,
    advGuildRankGodlikeReached: false,
    teammateGathered: false,
    fullParty: false,
    failedGatherTeam: false,
    largeDungeonAttempted: false,
    clearLDungeon: false,
    craftGuildTestsTaken: false,
    craftGuildRankEReached: false,
    craftGuildRankDReached: false,
    craftGuildRankCReached: false,
    craftGuildRankBReached: false,
    craftGuildRankAReached: false,
    craftGuildRankSReached: false,
    craftGuildRankUReached: false,
    craftGuildRankGodlikeReached: false,
    armorCrafted: false,
    craft10Armor: false,
    craft20Armor: false,
    failedCraftArmor: false,
    booksRead: false,
    pickaxeBought: false,
    heroTrial1Done: false,
    heroTrial10Done: false,
    heroTrial25Done: false,
    heroTrial50Done: false,
    charonPaid: false,
    loopingPotionMade: false,
    slay6TrollsInALoop: false,
    slay20TrollsInALoop: false,
    imbueMindThirdSegmentReached: false,
    imbueBodyThirdSegmentReached: false,
    failedImbueBody: false,
    judgementFaced: false,
    ignoredByGods: false,
    acceptedIntoValhalla: false,
    castIntoShadowRealm: false,
    spokeToGuru: false,
    fellFromGrace: false,
    donatedToCharity: false,
    receivedDonation: false,
    failedReceivedDonations: false,
    tidiedUp: false,
    manaZ5Bought: false,
    artifactSold: false,
    artifactDonated: false,
    donated20Artifacts: false,
    donated40Artifacts: false,
    charmSchoolVisited: false,
    oracleVisited: false,
    armorEnchanted: false,
    enchanted10Armor: false,
    enchanted20Armor: false,
    repeatedCitizenExam: false,
    houseBuilt: false,
    housesBuiltGodlike: false,
    built50Houses: false,
    collectedTaxes: false,
    collected50Taxes: false,
    acquiredPegasus: false,
    acquiredPegasusWithTeam: false,
    giantGuildTestTaken: false,
    giantGuildRankDReached: false,
    giantGuildRankCReached: false,
    giantGuildRankEReached: false,
    giantGuildRankBReached: false,
    giantGuildRankAReached: false,
    giantGuildRankSReached: false,
    giantGuildRankSSReached: false,
    giantGuildRankSSSReached: false,
    giantGuildRankUReached: false,
    giantGuildRankGodlikeReached: false,
    blessingSought: false,
    greatBlessingSought: false,
    feastAttempted: false,
    meanderIM100: false,
    wellDrawn: false,
    drew10Wells: false,
    drew15Wells: false,
    drewDryWell: false,
    attemptedRaiseZombie: false,
    failedRaiseZombie: false,
    spireAttempted: false,
    clearedSpire: false,
    spire10Pylons: false,
    spire20Pylons: false,
    suppliesPurchased: false,
    deadTrial1Done: false,
    deadTrial10Done: false,
    deadTrial25Done: false,
    monsterGuildTestTaken: false,
    monsterGuildRankDReached: false,
    monsterGuildRankCReached: false,
    monsterGuildRankBReached: false,
    monsterGuildRankAReached: false,
    monsterGuildRankSReached: false,
    monsterGuildRankSSReached: false,
    monsterGuildRankSSSReached: false,
    monsterGuildRankUReached: false,
    monsterGuildRankGodlikeReached: false,
    survivorRescued: false,
    rescued6Survivors: false,
    rescued20Survivors: false,
    buffetHeld: false,
    buffetFor1: false,
    buffetFor6: false,
    portalOpened: false,
    excursionAsGuildmember: false,
    explorerGuildTestTaken: false,
    mapTurnedIn: false,
    thiefGuildTestsTaken: false,
    thiefGuildRankEReached: false,
    thiefGuildRankDReached: false,
    thiefGuildRankCReached: false,
    thiefGuildRankBReached: false,
    thiefGuildRankAReached: false,
    thiefGuildRankSReached: false,
    thiefGuildRankUReached: false,
    thiefGuildRankGodlikeReached: false,
    assassinHeartDelivered: false,
    assassin4HeartsDelivered: false,
    assassin8HeartsDelivered: false,
    investedOne:false,
    investedTwo:false,
    interestCollected:false,
    collected1KInterest:false,
    collected1MInterest:false,
    collectedMaxInterest:false,
    seminarAttended:false,
    leadership10:false,
    leadership100:false,
    leadership1k:false,
    keyBought:false,
    trailSecretFaced:false,
    trailSecret1Done:false,
    trailSecret10Done:false,
    trailSecret100Done:false,
    trailSecret500Done:false,
    trailSecretAllDone:false,
    soulInfusionAttempted:false,
    trailGodsFaced:false,
    trailGods10Done:false,
    trailGods20Done:false,
    trailGods30Done:false,
    trailGods40Done:false,
    trailGods50Done:false,
    trailGods60Done:false,
    trailGods70Done:false,
    trailGods80Done:false,
    trailGods90Done:false,
    trailGodsAllDone:false,
    fightGods01:false,
    fightGods02:false,
    fightGods03:false,
    fightGods04:false,
    fightGods05:false,
    fightGods06:false,
    fightGods07:false,
    fightGods08:false,
    fightGods09:false,
    fightGods10:false,
    fightGods11:false,
    fightGods12:false,
    fightGods13:false,
    fightGods14:false,
    fightGods15:false,
    fightGods16:false,
    fightGods17:false,
    fightGods18:false,
};
const storyReqs = storyFlags; // compatibility alias, can be removed when we're sure it won't break anything

/** @typedef {keyof typeof storyVars} StoryVarName */
const storyVars = {
    maxWizardGuildSegmentCleared: -1,
    maxZombiesRaised: -1,
};

/**
 * @satisfies {{
 *  storyFlags: {[K in StoryFlagName]?: (loadingFlags: Record<string, boolean>, loadingVars: Record<string, number>) => boolean},
 *  storyVars: {[K in StoryVarName]?: (loadingFlags: Record<string, boolean>, loadingVars: Record<string, number>) => number},
 * }}
 */
const storyInitializers = {
    storyFlags: {
    },
    storyVars: {
        maxWizardGuildSegmentCleared(loadingFlags, loadingVars) {
            if (loadingFlags["wizardGuildRankSSSReached"]) return 48;
            if (loadingFlags["wizardGuildRankSSReached"]) return 42;
            if (loadingFlags["wizardGuildRankSReached"]) return 36;
            if (loadingFlags["wizardGuildRankAReached"]) return 30;
            if (loadingFlags["wizardGuildRankBReached"]) return 24;
            if (loadingFlags["wizardGuildRankCReached"]) return 18;
            if (loadingFlags["wizardGuildRankDReached"]) return 12;
            if (loadingFlags["wizardGuildRankEReached"]) return 6;
            if (loadingFlags["wizardGuildTestTaken"]) return 0;
        },
    },
}


const curDate = new Date();
let totalOfflineMs = 0;
// eslint-disable-next-line prefer-const
let bonusSpeed = 1;
let bonusActive = false;
let currentLoop = 0;
const offlineRatio = 1;
let windowFps = 50;
let totals = {
    time: 0,
    effectiveTime: 0,
    borrowedTime: 0,
    loops: 0,
    actions: 0
};

/** @type {{challengeMode?: number, inChallenge?: boolean}} */
let challengeSave = {
    challengeMode: 0,
    inChallenge: false
};

let totalMerchantMana = 7500;

// eslint-disable-next-line prefer-const
let curAdvGuildSegment = 0;
// eslint-disable-next-line prefer-const
let curCraftGuildSegment = 0;
// eslint-disable-next-line prefer-const
let curWizCollegeSegment = 0;
// eslint-disable-next-line prefer-const
let curFightFrostGiantsSegment = 0;
// eslint-disable-next-line prefer-const
let curFightJungleMonstersSegment = 0;
// eslint-disable-next-line prefer-const
let curThievesGuildSegment = 0;
// eslint-disable-next-line prefer-const
let curGodsSegment = 0;

/** @type {AnyAction[]} */
let totalActionList = [];

function initializeActions() {
    totalActionList.length = 0;
    for (const prop in Action) {
        const action = Action[prop];
        totalActionList.push(action);
    }
}

let dungeons = [[], [], []];
/** @type {(any[] & {highestFloor?:number})[]} */
let trials = [[], [], [], [], []];

// register all the object variables assigned in this file
Data.registerAll({
    actions,
    towns,
    stats,
    resources,
    hearts,
    skills,
    buffs,
    prestigeValues,
    townsUnlocked,
    completedActions,
    storyFlags,
    storyVars,
    totals,
});

// If we want to be able to iterate through the scalar global variables, they have to be assigned to an object. If we want to read or write them programmatically, we have to
// be able to access a syntactic variable via indirection, which can only be done by eval (or its cousin, new Function).
// the shorthand object initializer syntax here is just an easy way to get variable names into a call.
const globalVariables = virtualizeGlobalVariables({
    timer,
    timeNeeded,
    curTown,
    totalTalent,
    shouldRestart,
    guild,
    escapeStarted,
    portalUsed,
    stoneLoc,
    goldInvested,
    stonesUsed,
    trainingLimits,
    storyMax,
    unreadActionStories,
    totalMerchantMana,
    curAdvGuildSegment,
    curCraftGuildSegment,
    curWizCollegeSegment,
    curFightFrostGiantsSegment,
    curFightJungleMonstersSegment,
    curThievesGuildSegment,
    curGodsSegment,
    dungeons,
    trials,
});

function virtualizeGlobalVariables(variables) {
    const globals = Data.rootObjects.globals ?? {};
    for (const name in variables) {
        const get = /** @type {() => any} */(new Function(`return ${name};`));
        const set = /** @type {(any) => void} */(new Function("v__", `${name} = v__`));
        Object.defineProperty(globals, name, {
            get,
            set,
            enumerable: true,
            configurable: true,
        });
    }
    return Data.register("globals", globals);
}

/** @type {Notification} */
let pauseNotification = null;
const googleCloud = selfIsGame ? new GoogleCloud() : null;

const options = {
    theme: "normal",
    themeVariant: "",
    responsiveUI: true,
    actionLog: true,
    fractionalMana: false,
    keepCurrentList: false,
    repeatLastAction: false,
    addActionsToTop: false,
    pauseBeforeRestart: false,
    pauseOnFailedLoop: false,
    pauseOnComplete: false,
    speedIncrease10x: false,
    speedIncrease20x: false,
    speedIncreaseCustom: 5,
    speedIncreaseBackground: -1,
    bonusIsActive: false,
    highlightNew: true,
    statColors: true,
    statHints: false,
    pingOnPause: false,
    notifyOnPause: false,
    autoMaxTraining: false,
    hotkeys: true,
    predictor:  false,
    googleCloud: false,
    updateRate: 50,
    autosaveRate: 30,
    predictorTimePrecision: 1,
    predictorNextPrecision: 2,
    predictorActionWidth: 500,
    predictorRepeatPrediction: true,
    predictorSlowMode: false,
    predictorSlowTimer: 1,
    predictorTrackedStat: "Rsoul",
    predictorBackgroundThread: true,
    // ---- fork: Basic automation (assist tools) ----
    // Two flags, parallel to advancedAutomation/advancedAutomationEnabled:
    //   basicAutomation        — SHOWN: the Extras "Show basic automation" box.
    //     Reveals the Basic section in the Automation view and (with either tier
    //     shown) the Automation-view radio. Default off (byte-inert).
    //   basicAutomationEnabled — ENABLED: the in-section "Enable basic automation"
    //     box. Whether the basic features actually run. Default ON, but a feature
    //     runs only when the tier is BOTH shown AND enabled (so it never runs while
    //     hidden) — so a default install stays inert (basicAutomation off). Enabled
    //     defaults true so showing a tier turns it on in one step, and pre-split
    //     saves (basicAutomation=true) keep working.
    // Each individual feature also needs its own toggle.
    basicAutomation: false,
    basicAutomationEnabled: true,
    // Rep-gap report: annotate the action list when an action's total queued
    // reps are fewer than what the current state could actually execute next
    // loop (banked + uncheckable items for limited actions, allowed() caps
    // for training-style actions). Info only; never edits the queue.
    predictorRepGap: false,
    // Buy Mana / zone-1 economy optimiser (assist tool; §11.6 ladder). Suggests
    // a rebalanced queue that batches gold before each Buy Mana, drops redundant
    // conversions, splits a harvest to insert an intermediate conversion when the
    // budget would starve, and reserves gold for downstream purchases. Suggest-
    // first: this toggle shows the "Optimise Buy Mana" action in the Automation
    // view; economyOptimizerAuto applies the proposal at the loop boundary.
    // Both default off — an opt-in assist over the live queue, never in the
    // reference path (byte-inert).
    economyOptimizer: false,
    economyOptimizerAuto: false,
    // Auto-add reps (assist tool; §11.6 ladder rung 2): tops up the queue when
    // an action has fewer reps queued than the current state can execute next
    // loop (exactly the under-queued "+N" case the rep-gap badges show), by
    // bumping the entry's reps in place. When the Buy Mana optimiser is ALSO
    // enabled the top-up chains it to rebalance the result (reuses its logic,
    // no duplicate placement). autoAddRepsAuto tops up at the loop boundary.
    // Both default off — opt-in assist over the live queue, never the reference
    // path (byte-inert). Over-queued/multipart/one-shot actions are left alone.
    autoAddReps: false,
    autoAddRepsAuto: false,
    // ---- fork: testing aids ----
    // Multiplies experience/progress gains ONLY (town progress exp, skill
    // exp, stat exp + talent) at the three engine funnels (finishProgress /
    // addSkillExp / addExp). Resources — gold, mana, reputation, items,
    // multipart/dungeon progress, buffs, soulstones — are deliberately NOT
    // multiplied: the game's economy stays real. 1 = byte-exact vanilla.
    expGainMultiplier: 1,
    // ---- fork: Advanced Automation (queue planner) — everything off by default ----
    // advancedAutomation = SHOWN (Extras "Show advanced automation"): reveals the
    // Advanced settings + internals sections and (with either tier shown) the
    // Automation-view radio. advancedAutomationEnabled = ENABLED (in-section
    // "Enable advanced automation"): whether the planner acts. The planner runs
    // only when the tier is BOTH shown AND enabled AND a planner mode is set.
    // Enabled defaults true (one-step show, pre-split save compat); shown defaults
    // off so a default install is inert.
    advancedAutomation: false,
    advancedAutomationEnabled: true,
    plannerMode: "off",
    plannerPauseWhilePlanning: true,
    plannerSeedFromPredictor: true,
    plannerScreenK: 8,
    plannerProbeEvery: 1,
    // multi-town planning (travel-prefixed measurement, expedition/multi-hop
    // push candidates). Stored default ON is save-compat-safe: the planner
    // master gate above is default-off, so this does nothing until the
    // planner runs; OFF forces the v0 town-0-only filters (A/B sweeps).
    // deterministic RNG cycling (actionList.js §rngMode). "random" (default) =
    // Math.random verbatim, byte-inert. "cycle" replaces the four reward-path
    // RNG sites with an expectation-preserving deterministic sequence so
    // informed-mode dungeon probing and plan-vs-play parity need no RNG
    // rollback (ACTION-CENSUS.md §2.3; vocabulary plan §6).
    rngMode: "random",
    plannerMultiTown: true,
    // ON: the planner OWNS the per-resource "Lootable first" checkboxes,
    // setting them to its own model (loot-first) whenever it plans. OFF: the
    // live checkbox states are forwarded to the planning worker and plans are
    // computed under them. Either way the worker's sim and live play agree —
    // without this the worker (no DOM) always simulated loot-first while the
    // browser default is check-first.
    plannerControlLootFirst: true,
    // measurement vocabulary. "empirical" (default) = byte-exact today: the
    // knowledge table forms only from resource-injection probes. "informed"
    // adds gate-metadata setup (planner-metadata.js) so guild-gated and
    // negative-reputation actions become measurable (ACTION-CENSUS.md §2.4).
    // Only affects planning when the master gate is on; empirical keeps the
    // frozen reference untouched.
    plannerVocabulary: "empirical",
    // §11.10 targeted mode: candidate GENERATOR, orthogonal to plannerMode's
    // display-vs-install axis (§7 Option X). "heuristic" (default, byte-exact) =
    // the scorer; "targeted" = goal-directed regression over the priority list.
    plannerStrategy: "heuristic",
    // targeted-mode priority list: a JSON array of goal specs
    // [{kind:"a",action}|{kind:"b",target:{type,name?,town?},value,budget?}].
    // Stored as a string (like every option); automation.js parses it.
    plannerTargets: "[]",
    // ignore the list and auto-enumerate+rank the travel frontier (ruling 2).
    plannerAutoRankTargets: false,
    // §6 stagnation trigger: auto-enter ONE targeted escalation round from the
    // heuristic when the committed queue fixates (streak/drought). Default off.
    plannerAntiFixation: false,
    plannerWeightTown: 1e12,
    plannerWeightUnlockAction: 1000,
    plannerWeightVisibleAction: 300,
    plannerWeightFrontier: 4000,
    plannerWeightMana: 800,
    plannerWeightBank: 30,
    plannerWeightBankPot: 15,
    plannerWeightTalent: 0.01,
    // §11.5 scoring-horizon terms (only computed once >1 town is unlocked;
    // byte-inert at townsUnlocked=[0] regardless of value)
    plannerWeightTravelRelief: 3,
    plannerWeightHeadroom: 1,
};

/** @satisfies {readonly {[K in OptionName]: OptionType<K> extends number ? K : never}[OptionName][]} */
/** @typedef {keyof typeof options} OptionName */
/** @template {OptionName} N @typedef {typeof options[N]} OptionType */
/** @typedef {{[K in OptionName]: OptionType<K> extends number ? K : never}[OptionName]} NumericOptionName */
/** @typedef {{[K in OptionName]: OptionType<K> extends string ? K : never}[OptionName]} StringOptionName */
/** @typedef {{[K in OptionName]: OptionType<K> extends boolean ? K : never}[OptionName]} BooleanOptionName */

/** @satisfies {NumericOptionName[]} */
const numericOptions = [
    "speedIncreaseCustom",
    "speedIncreaseBackground",
    "updateRate",
    "autosaveRate",
    "predictorTimePrecision",
    "predictorNextPrecision",
    "predictorActionWidth",
    "predictorSlowTimer",
    "expGainMultiplier",
    "plannerScreenK",
    "plannerProbeEvery",
    "plannerWeightTown",
    "plannerWeightUnlockAction",
    "plannerWeightVisibleAction",
    "plannerWeightFrontier",
    "plannerWeightMana",
    "plannerWeightBank",
    "plannerWeightBankPot",
    "plannerWeightTalent",
    "plannerWeightTravelRelief",
    "plannerWeightHeadroom",
];
/** @satisfies {readonly StringOptionName[]} */
const stringOptions = [
    "theme",
    "themeVariant",
    "predictorTrackedStat",
    "plannerMode",
    "plannerVocabulary",
    "plannerStrategy",
    "plannerTargets",
    "rngMode",
];

/** @param {string} option @returns {option is NumericOptionName} */
function isNumericOption(option) {
    return numericOptions.includes(/** @type {NumericOptionName} */(option));
}

/** @param {string} option @returns {option is StringOptionName} */
function isStringOption(option) {
    return stringOptions.includes(/** @type {StringOptionName} */(option));
}

/** @param {string} option @returns {option is BooleanOptionName} */
function isBooleanOption(option) {
    // I'm explicitly deciding to leave this open-ended, so unknown options are treated as booleans
    return !numericOptions.includes(/** @type {NumericOptionName} */(option))
        && !stringOptions.includes(/** @type {StringOptionName} */(option));
}

// legacy predictor settings are in localStorage, use them as defaults if they exist
function importPredictorSettings() {
    /** @type {Record<string, OptionName>} */
    const settingsMap = {
        __proto__: null,
        timePrecision: "predictorTimePrecision",
        nextPrecision: "predictorNextPrecision",
        actionWidth: "predictorActionWidth",
        repeatPrediction: "predictorRepeatPrediction",
        slowMode: "predictorSlowMode",
        slowTimer: "predictorSlowTimer",
    };
    /** @type {Partial<typeof options>} */
    const newOptions = {};
    for (const [originalSetting, newOption] of Object.entries(settingsMap)) {
        const value = localStorage.getItem(originalSetting);
        if (value != null) {
            // has a setting
            if (isNumericOption(newOption)) {
                const numericValue = parseInt(value);
                if (isFinite(numericValue)) {
                    newOptions[newOption] = numericValue;
                }
            } else if (isStringOption(newOption)) {
                newOptions[newOption] = value;
            } else {
                newOptions[newOption] = value === "true";
            }
        }
    }
    return newOptions;
}
if (selfIsGame) {
    Object.assign(options, importPredictorSettings()); // override hardcoded defaults if not in worker
}

// The original forks will throw exceptions if there are unexpected properties in the options element. This list lets us
// check to see if a given option should go into "options" in the save, otherwise it belongs in "extraOptions".
/** @satisfies {Record<OptionName, boolean>} */
const isStandardOption = {
    theme: true,
    themeVariant: false,
    responsiveUI: false,
    actionLog: false,
    fractionalMana: false,
    keepCurrentList: true,
    repeatLastAction: true,
    addActionsToTop: true,
    pauseBeforeRestart: true,
    pauseOnFailedLoop: true,
    pauseOnComplete: true,
    speedIncrease10x: true,
    speedIncrease20x: true,
    speedIncreaseCustom: true,
    speedIncreaseBackground: false,
    bonusIsActive: false,
    highlightNew: true,
    statColors: true,
    statHints: false,
    pingOnPause: true,
    notifyOnPause: false,
    autoMaxTraining: true,
    hotkeys: true,
    predictor: false,
    googleCloud: false,
    updateRate: true,
    autosaveRate: true,
    predictorTimePrecision: false,
    predictorNextPrecision: false,
    predictorActionWidth: false,
    predictorRepeatPrediction: false,
    predictorSlowMode: false,
    predictorSlowTimer: false,
    predictorTrackedStat: false,
    predictorBackgroundThread: false,
    predictorRepGap: false,
    basicAutomation: false,
    basicAutomationEnabled: false,
    economyOptimizer: false,
    economyOptimizerAuto: false,
    autoAddReps: false,
    autoAddRepsAuto: false,
    expGainMultiplier: false,
    advancedAutomation: false,
    advancedAutomationEnabled: false,
    plannerMode: false,
    plannerPauseWhilePlanning: false,
    plannerSeedFromPredictor: false,
    plannerScreenK: false,
    plannerProbeEvery: false,
    rngMode: false,
    plannerMultiTown: false,
    plannerControlLootFirst: false,
    plannerVocabulary: false,
    plannerStrategy: false,
    plannerTargets: false,
    plannerAutoRankTargets: false,
    plannerAntiFixation: false,
    plannerWeightTown: false,
    plannerWeightUnlockAction: false,
    plannerWeightVisibleAction: false,
    plannerWeightFrontier: false,
    plannerWeightMana: false,
    plannerWeightBank: false,
    plannerWeightBankPot: false,
    plannerWeightTalent: false,
    plannerWeightTravelRelief: false,
    plannerWeightHeadroom: false,
};

// Some options set or clear an indicator class on the root element so CSS can respond. Record these here.
/** @type {Partial<Record<OptionName, string>>} */
const optionIndicatorClasses = {
    responsiveUI: "responsive",
    statColors: "use-stat-colors",
    statHints: "show-stat-hints",
    predictor: "usePredictor",
};

 /** @type {{[K in OptionName]?: (value: OptionType<K>, init: boolean, getInput: () => HTMLValueElement) => void}} */
const optionValueHandlers = {
    notifyOnPause(value, init, getInput) {
        const input = /** @type {HTMLInputElement} */(getInput());
        if (value && !init) {
            if (Notification && Notification.permission === "default") {
                input.checked = false;
                input.indeterminate = true;
                Notification.requestPermission(_ => {
                    input.indeterminate = false;
                    input.checked = value;
                    setOption("notifyOnPause", value);
                });
            } else if (Notification && Notification.permission === "denied") {
                input.checked = false;
                input.indeterminate = false;
                alert("Notification permission denied. You may need to allow this site to send you notifications manually.");
            } else if (!Notification || Notification.permission !== "granted") {
                input.checked = false;
                input.indeterminate = false;
            }
        } else if (!value) {
            options.notifyOnPause = false;
            input.checked = false;
            input.indeterminate = false;
        }
    },
    updateRate(value, init) {
        if (!init) recalcInterval(value);
    },
    actionLog(value, init) {
        document.getElementById("actionLogContainer").style.display = value ? "" : "none";
        document.getElementById("navbar_action_log").style.display = value ? "" : "none";
    },
    predictor(value, init) {
        localStorage["loadPredictor"] = value || "";
    },
    googleCloud(value, init, getInput) {
        if (value) {
            googleCloud.init();
            document.getElementById("cloud_save").style.display="";
        } else {
            document.getElementById("cloud_save").style.display="none";
        }
        if (!init && !value) googleCloud.revoke();
    },
    speedIncrease10x: checkExtraSpeed,
    speedIncrease20x: checkExtraSpeed,
    speedIncreaseCustom: checkExtraSpeed,
    speedIncreaseBackground(value, init) {
        checkExtraSpeed();
        if (typeof value === "number" && !isNaN(value) && value < 1 && value >= 0) {
            document.getElementById("speedIncreaseBackgroundWarning").style.display = "";
        } else {
            document.getElementById("speedIncreaseBackgroundWarning").style.display = "none";
        }
    },
    bonusIsActive(value, init) {
        if (!value !== !isBonusActive()) {
            toggleOffline();
        }
    },
    repeatLastAction() {
        if (options.predictor) {
            view.requestUpdate("updateNextActions");
        }
    },
    predictorActionWidth(value) {
        document.documentElement.style.setProperty("--predictor-actions-width", `${value}px`);
    },
    predictorTimePrecision(value) {
        if (value > 10) {
            setOption("predictorTimePrecision", 10);
        }
        if (value < 1) {
            setOption("predictorTimePrecision", 1);
        }
    },
    predictorNextPrecision(value) {
        if (value > 10) {
            setOption("predictorNextPrecision", 10);
        }
        if (value < 1) {
            setOption("predictorNextPrecision", 1);
        }
    },
    predictorTrackedStat(value, init) {
        if (!init) {
            view.requestUpdate("updateNextActions");
        }
    },
    predictorBackgroundThread(value, init) {
        if (!value && !init) {
            Koviko.instance.terminateWorker();
        }
    },
    predictorRepGap(value, init) {
        if (!init && options.predictor) {
            view.requestUpdate("updateNextActions");
        }
    }
};

/** @type {<K extends OptionName>(option: K, value: OptionType<K>, init: boolean, getInput: () => HTMLValueElement) => void} */
function handleOption(option, value, init, getInput) {
    optionValueHandlers[option]?.(value, init, getInput);
    // The handler can change the value of the option. Recheck when setting or clearing the indicator class.
    if (option in optionIndicatorClasses) {
        document.documentElement.classList.toggle(optionIndicatorClasses[option], !!options[option]);
    }
}

/** @template {OptionName} K @param {K} option @param {OptionType<K>} value */
function setOption(option, value, updateUI = false) {
    const oldValue = options[option];
    options[option] = value;
    handleOption(option, value, false, () => valueElement(`${option}Input`));
    if (options[option] !== oldValue) {
        save();
    }
    if (updateUI && (options[option] !== oldValue || options[option] !== value)) {
        loadOption(option, options[option], false);
    }
}

/** @template {OptionName} K @param {K} option @param {OptionType<K>} value */
function loadOption(option, value, callHandler = true) {
    const input = valueElement(`${option}Input`, false); // this is allowed to have errors
    if (!input) return;
    if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = !!value;
    else if (option === "speedIncreaseBackground" && (typeof value !== "number" || isNaN(value) || value < 0)) input.value = "";
    else input.value = String(value);
    handleOption(option, value, true, () => input);
}

function showPauseNotification(message) {
    pauseNotification = new Notification("Idle Loops", { icon: "favicon-32x32.png", body: message, tag: "paused", renotify: true });
}

function clearPauseNotification() {
    if (pauseNotification) {
        pauseNotification.close();
        pauseNotification = null;
    }
}

function closeTutorial() {
    document.getElementById("tutorial").style.display = "none";
}

function clearSave() {
    window.localStorage[defaultSaveName] = "";
    window.localStorage[challengeSaveName] = "";
    location.reload();
}

let defaultsRecorded = false;
function loadDefaults() {
    if (defaultsRecorded) {
        Data.resetToDefaults();
    }
    initializeStats();
    initializeSkills();
    initializeBuffs();
    initializeActions();
    initializeTowns();
    prestigeValues["prestigeCurrentPoints"] = 0;
    prestigeValues["prestigeTotalPoints"] = 0;
    prestigeValues["prestigeTotalCompletions"] = 0;
    prestigeValues["completedCurrentPrestige"] = false;
    prestigeValues["completedAnyPrestige"] = false;
    resetRngCycle();
    Data.recordDefaults();
    defaultsRecorded = true;
}

function loadUISettings() {
    const height = localStorage.getItem("actionListHeight");
    if (height !== "") document.documentElement.style.setProperty("--action-list-height", height);
}

function saveUISettings() {
    const height = document.documentElement.style.getPropertyValue("--action-list-height");
    if (height !== "") localStorage.setItem("actionListHeight", height);
}

function needsDataSnapshots() {
    return options.predictor && options.predictorBackgroundThread;
}

function load(inChallenge, saveJson = window.localStorage[saveName]) {
    loadDefaults();
    loadUISettings();

    loadouts = [[], [], [], [], [], [], [], [], [], [], [], [], [], [], [], []];
    loadoutnames = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", ""];
    // loadoutnames[-1] is what displays in the loadout renaming box when no loadout is selected
    // It isn't technically part of the array, just a property on it, so it doesn't count towards loadoutnames.length
    loadoutnames[-1] = "";

    let toLoad = {};
    // has a save file
    if (saveJson && saveJson !== "null") {
        closeTutorial();
        toLoad = JSON.parse(saveJson);
    }

    console.log("Loading game from: " + saveName + " inChallenge: " + inChallenge);

    if(toLoad.challengeSave !== undefined)
    for (let challengeProgress in toLoad.challengeSave)
        challengeSave[challengeProgress] = toLoad.challengeSave[challengeProgress];
    if (inChallenge !== undefined) challengeSave.inChallenge = inChallenge;

    console.log("Challenge Mode: " + challengeSave.challengeMode + " In Challenge: " + challengeSave.inChallenge);


    if (saveName === defaultSaveName && challengeSave.inChallenge === true) {
        console.log("Switching to challenge save");
        saveName = challengeSaveName;
        load(true);
        return;
    }

    if (challengeSave.challengeMode !== 0)
        saveName = challengeSaveName;

    doLoad(toLoad);
}

function doLoad(toLoad) {
    for (const property of Object.getOwnPropertyNames(toLoad.stats ?? {})) {
        if (property in stats) {
            stats[property].load(toLoad.stats[property]);
        }
    }


    for (const property of Object.getOwnPropertyNames(toLoad.skills ?? {})) {
        if (property in skills) {
            skills[property].load(toLoad.skills[property]);
        }
    }

    for (const property in toLoad.buffs) {
        if (toLoad.buffs.hasOwnProperty(property)) {
            // need the min for people with broken buff amts from pre 0.93
            buffs[property].amt = Math.min(toLoad.buffs[property].amt, buffHardCaps[property]);
        }
    }

    if (toLoad.buffCaps !== undefined) {
        for (const property in buffCaps) {
            if (toLoad.buffCaps.hasOwnProperty(property)) {
                buffCaps[property] = toLoad.buffCaps[property];
                inputElement(`buff${property}Cap`).value = buffCaps[property];
            }
        }
    }

    if (toLoad.prestigeValues !== undefined) {
        prestigeValues["prestigeCurrentPoints"]     = toLoad.prestigeValues["prestigeCurrentPoints"]     === undefined ? 0     : toLoad.prestigeValues["prestigeCurrentPoints"];
        prestigeValues["prestigeTotalPoints"]       = toLoad.prestigeValues["prestigeTotalPoints"]       === undefined ? 0     : toLoad.prestigeValues["prestigeTotalPoints"];
        prestigeValues["prestigeTotalCompletions"]  = toLoad.prestigeValues["prestigeTotalCompletions"]  === undefined ? 0     : toLoad.prestigeValues["prestigeTotalCompletions"];
        prestigeValues["completedCurrentPrestige"]  = toLoad.prestigeValues["completedCurrentPrestige"]  === undefined ? 0     : toLoad.prestigeValues["completedCurrentPrestige"];
        prestigeValues["completedAnyPrestige"]      = toLoad.prestigeValues["completedAnyPrestige"]      === undefined ? false : toLoad.prestigeValues["completedAnyPrestige"];
    }


    for (const property in storyFlags) {
        if (toLoad.storyReqs?.hasOwnProperty(property)) {
            storyFlags[property] = toLoad.storyReqs[property];
        } else {
            storyFlags[property] = storyInitializers.storyFlags[property]?.(toLoad.storyReqs ?? {}, toLoad.storyVars ?? {}) ?? false;
        }
    }

    for (const property in storyVars) {
        if (toLoad.storyVars?.hasOwnProperty(property)) {
            storyVars[property] = toLoad.storyVars[property];
        } else {
            storyVars[property] = storyInitializers.storyVars[property]?.(toLoad.storyReqs ?? {}, toLoad.storyVars ?? {}) ?? -1;
        }
    }

    if (toLoad.actionLog !== undefined) {
        actionLog.load(toLoad.actionLog);
        actionLog.loadRecent();
    } else {
        actionLog.initialize();
    }
    if (actionLog.entries.length === 0) {
        actionLog.addGlobalStory(0);
    }

    if (toLoad.totalTalent === undefined) {
        let temptotalTalent = 0;
        for (const property in toLoad.stats) {
            if (toLoad.stats.hasOwnProperty(property)) {
                temptotalTalent += toLoad.stats[property].talent * 100;
            }
        }
        totalTalent = temptotalTalent;
    } else {
        totalTalent = toLoad.totalTalent;
    }

    if (toLoad.maxTown) {
        townsUnlocked = [0];
        for (let i = 1; i <= toLoad.maxTown; i++) {
            townsUnlocked.push(i);
        }
    } else {
        townsUnlocked = toLoad.townsUnlocked === undefined ? [0] : toLoad.townsUnlocked;
    }
    completedActions = [];
    if (toLoad.completedActions && toLoad.completedActions.length > 0)
        toLoad.completedActions.forEach(action => {
            completedActions.push(action);
        });
    completedActions.push("FoundGlasses");
    trainingLimits = 10 + getBuffLevel("Imbuement");
    goldInvested = toLoad.goldInvested === undefined ? 0 : toLoad.goldInvested;
    stonesUsed = toLoad.stonesUsed === undefined ? {1:0, 3:0, 5:0, 6:0} : toLoad.stonesUsed;
    if (toLoad.rngCycle) rngCycleState = toLoad.rngCycle; else resetRngCycle();

    actions.clearActions();
    if (toLoad.nextList) {
        for (const action of toLoad.nextList) {
            if (action.name === "Sell Gold") {
                action.name = "Buy Mana";
            }
            if (action.name === "Buy Mana Challenge")
                action.name = "Buy Mana Z1";
            if (action.name === "Tournament") {
                action.name = "Buy Pickaxe";
            }
            if (action.name === "Train Dex") {
                action.name = "Train Dexterity";
            }
            if (action.name === "Buy Mana") {
                action.name = "Buy Mana Z1";
            }
            if (action.name === "Purchase Mana") {
                action.name = "Buy Mana Z3";
            }
            if(totalActionList.some(x => x.name === action.name))
                actions.addActionRecord(action, -1, false);
        }
    }

    if (toLoad.loadouts) {
        for (let i = 0; i < loadouts.length; i++) {
            if (!toLoad.loadouts[i]) {
                continue;
            }
            //Translates old actions that no longer exist
            for (const action of toLoad.loadouts[i]) {
                if (action.name === "Sell Gold") {
                    action.name = "Buy Mana";
                }
                if (action.name === "Tournament") {
                    action.name = "Buy Pickaxe";
                }
                if (action.name === "Train Dex") {
                    action.name = "Train Dexterity";
                }
                if (action.name === "Buy Mana") {
                    action.name = "Buy Mana Z1";
                }
                if (action.name === "Purchase Mana") {
                    action.name = "Buy Mana Z3";
                }
                if(totalActionList.some(x => x.name === action.name))
                    loadouts[i].push(action);
            }
        }
    }
    for (let i = 0; i < loadoutnames.length; i++) {
        loadoutnames[i] = "Loadout " + (i + 1);
    }
    if (toLoad.loadoutnames) {
        for (let i = 0; i < loadoutnames.length; i++) {
            if(toLoad.loadoutnames[i] != undefined && toLoad.loadoutnames != "")
                loadoutnames[i] = toLoad.loadoutnames[i];
            else
                loadoutnames[i] = "Loadout " + (i + 1);
        }
    }
    curLoadout = toLoad.curLoadout;
    const elem = typeof document === "undefined" ? undefined : document.getElementById(`load${curLoadout}`);
    if (elem) {
        removeClassFromDiv(document.getElementById(`load${curLoadout}`), "unused");
    }

    /*if (toLoad.dungeons) {
        if (toLoad.dungeons.length < dungeons.length) {
            toLoad.dungeons.push([]);
        }
    }*/
    dungeons = [[], [], []];
    const level = { ssChance: 1, completed: 0 };
    let floors = 0;
    if(toLoad.dungeons === undefined) toLoad.dungeons = copyArray(dungeons);
    for (let i = 0; i < dungeons.length; i++) {
        floors = dungeonFloors[i];
        for (let j = 0; j < floors; j++) {
            if (toLoad.dungeons[i] != undefined && toLoad.dungeons && toLoad.dungeons[i][j]) {
                dungeons[i][j] = toLoad.dungeons[i][j];
            } else {
                dungeons[i][j] = copyArray(level);
            }
            dungeons[i][j].lastStat = "NA";
        }
    }

    trials = [[], [], [], [], []];
    const trialLevel = {completed: 0};
    if(toLoad.trials === undefined) toLoad.trials = copyArray(trials);
    for (let i = 0; i < trials.length; i++) {
        floors = trialFloors[i];
        trials[i].highestFloor = 0;
        for (let j = 0; j < floors; j++) {
            if (toLoad.trials[i] != undefined && toLoad.trials && toLoad.trials[i][j]) {
                trials[i][j] = toLoad.trials[i][j];
                if (trials[i][j].completed > 0) trials[i].highestFloor = j;
            } else {
                trials[i][j] = copyArray(trialLevel);
            }
        }
    }

    if (toLoad.options === undefined) {
        options.theme = toLoad.currentTheme === undefined ? options.theme : toLoad.currentTheme;
        options.repeatLastAction = toLoad.repeatLast;
        options.pingOnPause = toLoad.pingOnPause === undefined ? options.pingOnPause : toLoad.pingOnPause;
        options.notifyOnPause = toLoad.notifyOnPause === undefined ? options.notifyOnPause : toLoad.notifyOnPause;
        options.autoMaxTraining = toLoad.autoMaxTraining === undefined ? options.autoMaxTraining : toLoad.autoMaxTraining;
        options.highlightNew = toLoad.highlightNew === undefined ? options.highlightNew : toLoad.highlightNew;
        options.hotkeys = toLoad.hotkeys === undefined ? options.hotkeys : toLoad.hotkeys;
        options.updateRate = toLoad.updateRate === undefined ? options.updateRate : window.localStorage["updateRate"] ?? toLoad.updateRate;
    } else {
        const optionsToLoad = {...toLoad.options, ...toLoad.extraOptions};
        for (const option in optionsToLoad) {
            if (option in options) {
            options[option] = optionsToLoad[option];
            }
        }
        if ("updateRate" in optionsToLoad && window.localStorage["updateRate"]) {
            options.updateRate = window.localStorage["updateRate"];
        }
    }

    /** @type {string[]} */
    const hiddenVarNames = toLoad.hiddenVars?.slice() ?? [];

    for (const town of towns) {
        const hiddenVars = hiddenVarNames.shift() ?? [];
        town.hiddenVars.clear()
        for (const action of town.totalActionList) {
            if ((action.visible?.() ?? true) && (action.unlocked?.() ?? true)) {
                if (hiddenVars.includes(action.varName)) {
                    town.hiddenVars.add(action.varName);
                }
                if (action.name.startsWith("Survey") && hiddenVars.includes(`${action.varName}Global`)) {
                    town.hiddenVars.add(`${action.varName}Global`);
                }
            }
            if (action.type === "progress")
                town[`exp${action.varName}`] = toLoad[`exp${action.varName}`] === undefined ? 0 : toLoad[`exp${action.varName}`];
            else if (action.type === "multipart")
                town[`total${action.varName}`] = toLoad[`total${action.varName}`] === undefined ? 0 : toLoad[`total${action.varName}`];
            else if (action.type === "limited") {
                const varName = action.varName;
                if (toLoad[`total${varName}`] !== undefined)
                    town[`total${varName}`] = toLoad[`total${varName}`];
                if (toLoad[`checked${varName}`] !== undefined)
                    town[`checked${varName}`] = toLoad[`checked${varName}`];
                if (toLoad[`good${varName}`] !== undefined)
                    town[`good${varName}`] = toLoad[`good${varName}`];
                if (toLoad[`good${varName}`] !== undefined)
                    town[`goodTemp${varName}`] = toLoad[`good${varName}`];
            }
        }
    }

    loadChallenge();
    view.initalize();

    for (const town of towns) {
        for (const action of town.totalActionList) {
            if (action.type === "limited") {
                const varName = action.varName;
                if (toLoad[`searchToggler${varName}`] !== undefined) {
                    inputElement(`searchToggler${varName}`).checked = toLoad[`searchToggler${varName}`];
                }
                view.updateRegular({name: action.varName, index: town.index});
            }
        }
    }

    totalOfflineMs = toLoad.totalOfflineMs === undefined ? 0 : toLoad.totalOfflineMs; // must load before options

    for (const option of typedKeys(options)) {
        loadOption(option, options[option]);
    }
    storyShowing = toLoad.storyShowing === undefined ? 0 : toLoad.storyShowing;
    storyMax = toLoad.storyMax === undefined ? 0 : toLoad.storyMax;
    if (toLoad.unreadActionStories === undefined
        || toLoad.unreadActionStories.find(s => !s.includes('storyContainer'))) {
        unreadActionStories = [];
    } else {
        unreadActionStories = toLoad.unreadActionStories;
        for (const name of unreadActionStories) {
            showNotification(name);
        }
    }

    if (toLoad.totals != undefined) {
        totals.time = toLoad.totals.time === undefined ? 0 : toLoad.totals.time;
        totals.effectiveTime = toLoad.totals.effectiveTime === undefined ? 0 : toLoad.totals.effectiveTime;
        totals.borrowedTime = toLoad.totals.borrowedTime ?? 0;
        totals.loops = toLoad.totals.loops === undefined ? 0 : toLoad.totals.loops;
        totals.actions = toLoad.totals.actions === undefined ? 0 : toLoad.totals.actions;
    }
    else totals = {time: 0, effectiveTime: 0, borrowedTime: 0, loops: 0, actions: 0};
    currentLoop = totals.loops;
    view.updateTotals();
    console.log("Updating prestige values from load")
    view.updatePrestigeValues();

    // capped at 1 month of gain
    addOffline(Math.min(Math.floor((Date.now() - Date.parse(toLoad.date)) * offlineRatio), 2678400000));

    if (toLoad.version75 === undefined) {
        const total = towns[0].totalSDungeon;
        dungeons[0][0].completed = Math.floor(total / 2);
        dungeons[0][1].completed = Math.floor(total / 4);
        dungeons[0][2].completed = Math.floor(total / 8);
        dungeons[0][3].completed = Math.floor(total / 16);
        dungeons[0][4].completed = Math.floor(total / 32);
        dungeons[0][5].completed = Math.floor(total / 64);
        towns[0].totalSDungeon = dungeons[0][0].completed + dungeons[0][1].completed + dungeons[0][2].completed + dungeons[0][3].completed + dungeons[0][4].completed + dungeons[0][5].completed;
    }

    //Handle players on previous challenge system
    if(toLoad.challenge !== undefined && toLoad.challenge !== 0) {
        challengeSave.challengeMode = 0;
        challengeSave.inChallenge = true;
        save();

        challengeSave.challengeMode = toLoad.challenge;
        saveName = challengeSaveName;
        save();
        location.reload();
    }

    if(getExploreProgress() >= 100) addResource("glasses", true);

    adjustAll();

    Data.recordBase();

    view.updateLoadoutNames();
    view.changeStatView();
    view.updateNextActions();
    view.updateMultiPartActions();
    view.updateStories(true);
    view.update();
    recalcInterval(options.updateRate);
    pauseGame();
}

function doSave() {
    const toSave = {};
    toSave.curLoadout = curLoadout;
    toSave.dungeons = dungeons;
    toSave.trials = trials;
    toSave.townsUnlocked = townsUnlocked;
    toSave.completedActions = completedActions;

    toSave.stats = stats;
    toSave.totalTalent = totalTalent;
    toSave.skills = skills;
    toSave.buffs = buffs;
    toSave.prestigeValues = prestigeValues;
    toSave.goldInvested = goldInvested;
    toSave.stonesUsed = stonesUsed;
    toSave.rngCycle = rngCycleState;   // deterministic-RNG cursors (actionList.js §rngMode)
    toSave.version75 = true;

    /** @type {string[][]} */
    const hiddenVars = [];

    for (const town of towns) {
        hiddenVars.push(Array.from(town.hiddenVars));
        for (const action of town.totalActionList) {
            if (action.type === "progress") {
                toSave[`exp${action.varName}`] = town[`exp${action.varName}`];
            } else if (action.type === "multipart") {
                toSave[`total${action.varName}`] = town[`total${action.varName}`];
            } else if (action.type === "limited") {
                const varName = action.varName;
                toSave[`total${varName}`] = town[`total${varName}`];
                toSave[`checked${varName}`] = town[`checked${varName}`];
                toSave[`good${varName}`] = town[`good${varName}`];
                toSave[`goodTemp${varName}`] = town[`good${varName}`];
                if (document.getElementById(`searchToggler${varName}`)) {
                    toSave[`searchToggler${varName}`] = inputElement(`searchToggler${varName}`).checked;
                }
            }
        }
    }
    toSave.hiddenVars = hiddenVars;
    toSave.nextList = actions.next;
    toSave.loadouts = loadouts;
    toSave.loadoutnames = loadoutnames;
    toSave.options = {};
    toSave.extraOptions = {}; // to avoid crashing when exporting to lloyd, etc
    for (const option in options) {
        if (isStandardOption[option]) {
            toSave.options[option] = options[option];
        } else {
            toSave.extraOptions[option] = options[option];
        }
    }
    toSave.storyShowing = storyShowing;
    toSave.storyMax = storyMax;
    toSave.storyReqs = storyFlags; // save uses the legacy name "storyReqs" for compatibility
    toSave.storyVars = storyVars;
    toSave.unreadActionStories = unreadActionStories;
    toSave.actionLog = actionLog;
    toSave.buffCaps = buffCaps;

    toSave.date = new Date();
    toSave.totalOfflineMs = totalOfflineMs;
    toSave.totals = totals;

    toSave.challengeSave = challengeSave;
    for (const challengeProgress in challengeSave)
        toSave.challengeSave[challengeProgress] = challengeSave[challengeProgress];

    return toSave;
}

function save() {
    const toSave = doSave();
    const saveJson = JSON.stringify(toSave);
    storeSaveJson(saveJson);
    window.localStorage["updateRate"] = options.updateRate;
    return saveJson;
}

function currentSaveData() {
    return `ILSV01${LZString.compressToBase64(window.localStorage[saveName])}`;
}

function exportSave() {
    const saveJson = save();
    // idle loops save version 01. patch v0.94, moved from old save system to lzstring base 64
    inputElement("exportImport").value = `ILSV01${LZString.compressToBase64(saveJson)}`;
    inputElement("exportImport").select();
    if (!document.execCommand("copy")) {
        alert("Copying the save to the clipboard failed! You will need to copy the highlighted value yourself.");
    }
}

function importSave() {
    const saveData = inputElement("exportImport").value;
    processSave(saveData);
}

function processSave(saveData) {
    if (saveData === "") {
        if (confirm("Importing nothing will delete your save. Are you sure you want to delete your save?")) {
            challengeSave = {};
            clearSave();
        } else {
            return;
        }
    }
    let saveJson = "";
    // idle loops save version 01. patch v0.94, moved from old save system to lzstring base 64
    if (saveData.substr(0, 6) === "ILSV01") {
        saveJson = LZString.decompressFromBase64(saveData.substr(6));
    } else {
        // handling for old saves from stopsign or patches prior to v0.94
        saveJson = decode(saveData);
    }
    if (saveJson) {
        storeSaveJson(saveJson);
    }
    actions.clearActions();
    actions.current = [];
    load(null, saveJson);
    pauseGame();
    restart();
}

let overquotaWarned = false;
function storeSaveJson(saveJson) {
    try {
        window.localStorage[saveName] = saveJson;
    } catch (e) {
        if (e instanceof DOMException && e.name === "QuotaExceededError") {
            if (!overquotaWarned) {
                alert("The game's save file has exceeded this browser's storage quota.\nThis is EXTREMELY unusual and means something has gone very wrong.\n\nYOU ARE AT RISK OF LOSING GAME PROGRESS.\n\nAttempting to proceed anyway. You should export your save and keep it somewhere safe, and if possible, please report this bug in the Discord (link under Options)!");
                overquotaWarned = true;
            }
        } else {
            throw e;
        }
    }
}

function saveFileName() {
    const gameName = document.title.replace('*PAUSED* ','')
    const version = document.querySelector('#changelog > li[data-verNum]').firstChild.textContent.trim()
    return `${gameName} ${version} - Loop ${totals.loops}.txt`
}

function exportSaveFile() {
    const saveJson = save();
    const saveData = `ILSV01${LZString.compressToBase64(saveJson)}`;
    const a = document.createElement('a');
    a.setAttribute('href', 'data:text/plain;charset=utf-8,' + saveData);
    a.setAttribute('download', saveFileName());
    a.setAttribute('id', 'downloadSave');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function openSaveFile() {
    document.getElementById('SaveFileInput').click();
}

function importSaveFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        const saveData = e.target.result;
        processSave(saveData);
    }
    reader.readAsText(file)
}

function exportCurrentList() {
    let toReturn = "";
    for (const action of actions.next) {
        toReturn += `${action.loops}x ${action.name}`;
        toReturn += "\n";
    }
    textAreaElement("exportImportList").value = toReturn.slice(0, -1);
    textAreaElement("exportImportList").select();
    document.execCommand("copy");
}

function importCurrentList() {
    const toImport = textAreaElement("exportImportList").value.split("\n");
    actions.clearActions();
    for (let i = 0; i < toImport.length; i++) {
        if (!toImport[i]) {
            continue;
        }
        const name = /** @type {ActionName} */(toImport[i].substr(toImport[i].indexOf("x") + 1).trim());
        const loops = toImport[i].substr(0, toImport[i].indexOf("x"));
        try {
            const action = getActionPrototype(name);
            if (action.unlocked()) {
                actions.addActionRecord({ name, loops: Number(loops), disabled: false }, -1, false);
            }
        } catch (e) {
            if (e instanceof ClassNameNotFoundError) {
                console.log(e.message);
            } else {
                throw e;
            }
        }
    }
    view.updateNextActions();
}

function beginChallenge(challengeNum) {
    console.log("Beginning Challenge");
    if (window.localStorage[challengeSaveName] && window.localStorage[challengeSaveName] !== "") {
        if (confirm("Beginning a new challenge will delete your current challenge save. Are you sure you want to begin?"))
            window.localStorage[challengeSaveName] = "";
        else
            return false;
    }
    if (challengeSave.challengeMode === 0) {
        challengeSave.inChallenge = true;
        save();
        console.log ("Saving to: " + saveName);
    }
    challengeSave.challengeMode = challengeNum;
    saveName = challengeSaveName;
    load(true);
    totalOfflineMs = 1000000;
    save();
    pauseGame();
    restart();
}

function exitChallenge() {
    if (challengeSave.challengeMode !== 0) {
        saveName = defaultSaveName;
        load(false);
        save();
        location.reload();
    }
}

function resumeChallenge() {
    if (challengeSave.challengeMode === 0 && window.localStorage[challengeSaveName] && window.localStorage[challengeSaveName] !== "") {
        challengeSave.inChallenge = true;
        save();
        saveName = challengeSaveName;
        load(true);
        save();
        pauseGame();
        restart();
    }
}
