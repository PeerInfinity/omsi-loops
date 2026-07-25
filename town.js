"use strict";
/**
 * @template {string} [VN=never]
 * @template {string} [PVN=never]
 * @template {string} [MVN=never]
 * @typedef {{
 *  [K in 
 *  `checked${VN}`
 * |`goodTemp${VN}`
 * |`good${VN}`
 * |`lootFrom${VN}`
 * |`total${VN}`
 * |`exp${PVN}`
 * |`total${MVN}`
 * |`${MVN}`
 * |`${MVN}LoopCounter`
 *      ]?: number
 * }} TownVarDefs
 */
/**
 * @template {number} TN
 * @typedef {TownVarDefs<
 *          ActionVarOfTownAndType<TN,"limited">,
 *          ActionVarOfTownAndType<TN,"progress">,
 *          ActionVarOfTownAndType<TN,"multipart">
 *          >} TownVars
 */
/**
 * @template {number} TN
 * @typedef {keyof TownVars<TN>} TownVarNames
 */
/** @template {Town<number>} T @typedef {T extends Town<infer TN> ? TN : never} NumOfTown */
/**
 * @template {number} TN Town number
 */
class Town {
    /** @type {TN} */
    index;
    /** @type {string[]} */
    allVarNames = [];
    /** @type {string[]} */
    varNames = [];
    /** @type {string[]} */
    progressVars = [];
    /** @type {string[]} */
    multipartVars = [];
    /** @type {Record<string, ProgressScalingType>} */
    progressScaling = {};
    /** @type {AnyAction[]} */
    totalActionList = [];
    /** @type {Set<string>} */
    hiddenVars = new Set();

    /**
     * fork (arc D2 slice 2b): the per-region Explore RESCALE, as
     * `{ [townIndex]: { [varName]: maxLevel } }`, or null on the vanilla path.
     *
     * A "region" in the substrate's arc-C sense is an overlay on ONE town, and
     * a region is meant to behave like a mini-town compressed into N levels:
     * its exit timing, its discovery schedules and its UI % all reach their
     * end at raw level N instead of 100. That gives level TWO VIEWS:
     *
     *   - EFFECTIVE (`getLevel`) = `min(100, floor(raw · 100 / N))` — what every
     *     SCHEDULE consumer reads: unlock-row predicates, action
     *     visible/unlocked thresholds, the UI percentage, and the exit gate.
     *     Schedules therefore compress into the region's N levels.
     *   - RAW (`getRawLevel`) = the vanilla level, capped at N by the exp clamp
     *     — what the DISCOVERY-QUANTITY consumers read (the `<totalDiscovered>`
     *     evaluator and the unlock table's quantity-row dot product). Those
     *     curves are LINEAR in level, so capping the raw level at 100/count
     *     hands each region ≈1/count of the town's unlockables: the partition
     *     falls out of the cap, with no formula rewriting and no per-region
     *     inflation of quantities.
     *
     * Deliberately CLASS-static rather than a Town instance property: the
     * planner worker installs it via the worldConfig transport BEFORE
     * `plRestoreSave`, which rebuilds the towns array — an instance property
     * would not survive that, and would also need omitting from every save.
     * Null is the vanilla path and costs one static read + a nullish check in
     * `getLevel`, which is white-hot (the byte-gate proves the inertness).
     * @type {Record<number, Record<string, number>> | null}
     */
    static regionScale = null;

    /** Install (or clear, with null) the per-region Explore rescale. */
    static setRegionScale(scale) {
        Town.regionScale = scale ?? null;
    }

    static {
        Data.omitProperties(this.prototype, ["hiddenVars"]);
    }

    unlocked() {
        return townsUnlocked.includes(this.index);
    };

    expFromLevel(level) {
        return level * (level + 1) * 50;
    };

    /**
     * This town's rescaled max level for a var, or 0 when it is not rescaled.
     * Resolves the `Survey` alias itself, so every caller can pass whatever
     * name it holds — the four entry points below do not agree on which.
     */
    regionMaxLevel(varName) {
        if (varName === "Survey") varName = varName + "Z" + this.index;
        const cap = Town.regionScale?.[this.index]?.[varName];
        return cap > 0 ? cap : 0;
    };

    /** The exp a var holds at a given level, on whichever curve it scales on. */
    expForLevel(varName, level) {
        if (varName === "Survey") varName = varName + "Z" + this.index;
        return this.progressScaling[varName] === "linear" ? level * 5050 : this.expFromLevel(level);
    };

    /**
     * The exp ceiling for a var: `expForLevel(regionMax)` under a rescale,
     * else the vanilla level-100 cap (505000 on BOTH curves).
     */
    expCap(varName) {
        const max = this.regionMaxLevel(varName);
        return max ? this.expForLevel(varName, max) : 505000;
    };

    /** The vanilla (unscaled) level — the DISCOVERY-QUANTITY view. */
    getRawLevel(varName) {
        if (varName === "Survey") varName = varName + "Z" + this.index;
        if (this.progressScaling[varName] === "linear") return Math.floor(this[`exp${varName}`] / 5050);
        return Math.floor((Math.sqrt(8 * this[`exp${varName}`] / 100 + 1) - 1) / 2);
    };

    /**
     * The EFFECTIVE level — the SCHEDULE view. The rescale is applied at this
     * single return site, AFTER both scaling branches inside getRawLevel, so a
     * linear-scaled var rescales on the same 100/N ladder a quadratic one does.
     */
    getLevel(varName) {
        const level = this.getRawLevel(varName);
        const max = this.regionMaxLevel(varName);
        return max ? Math.min(100, Math.floor(level * 100 / max)) : level;
    };

    restart() {
        for (let i = 0; i < this.varNames.length; i++) {
            const varName = this.varNames[i];
            this[`goodTemp${varName}`] = this[`good${varName}`];
            this[`lootFrom${varName}`] = 0;
            view.requestUpdate("updateRegular",{name: varName, index: this.index});
        }
    };

    finishProgress(varName, expGain) {
        // fork: testing gain multiplier (Extras menu). All town progress exp
        // funnels through here; 1 leaves expGain untouched (byte-inert).
        if ((options.expGainMultiplier ?? 1) !== 1) expGain *= options.expGainMultiplier;
        // fork (arc D2 slice 2b): the ceiling is the var's own, which under a
        // per-region Explore rescale is expForLevel(regionMax) and 505000
        // otherwise. All THREE literal sites move together on purpose: taking
        // only the two clamp sites below would still clamp exp correctly and
        // would silently break this capped-already fast path for every
        // rescaled region — the perf early-return AND the pauseOnComplete
        // "Progress complete!" branch both hang off this equality.
        const expCap = this.expCap(varName);
        // return if capped, for performance
        if (this[`exp${varName}`] === expCap) {
            if (options.pauseOnComplete) pauseGame(true, "Progress complete! (Game paused)");
            else return;
        }

        const prevLevel = this.getLevel(varName);
        if (this[`exp${varName}`] + expGain > expCap) {
            this[`exp${varName}`] = expCap;
        } else {
            this[`exp${varName}`] += expGain;
        }
        const level = this.getLevel(varName);
        if (level !== prevLevel) {
            view.requestUpdate("updateLockedHidden", null);
            adjustAll();
            // fork: unlock diff pass. Every row reading this progress var —
            // action gates, the exploreProgress aggregate, and the loot-batch
            // quantity rows — can only have changed on a LEVEL change, which is
            // the same reason adjustAll() sits in this branch.
            Unlocks.check([Unlocks.dimKey.progress(this.index, varName)]);
            for (const action of totalActionList) {
                if (towns[action.townNum].varNames.indexOf(action.varName) !== -1) {
                    view.requestUpdate("updateRegular", {name: action.varName, index: action.townNum});
                }
            }
        }
        view.requestUpdate("updateProgressAction", {name: varName, town: towns[curTown]});
        stateChanged("progress", {townIndex: this.index, varName, oldLevel: prevLevel, newLevel: level});
    };

    getPrcToNext(varName) {
        // fork (arc D2 slice 2b): within-level progress is a RAW-level
        // quantity — the bar fills toward the next raw step while the level
        // the UI prints beside it jumps in 100/N increments. Reading the
        // effective level here would index expFromLevel() with a level the
        // stored exp has never been near. Vanilla: regionMaxLevel is 0, so
        // this is the level-100 guard against the unscaled level, unchanged.
        const level = this.getRawLevel(varName);
        if (level >= (this.regionMaxLevel(varName) || 100)) return 100;
        if (this.progressScaling[varName] === "linear") return this[`exp${varName}`] / 5050 % 1 * 100;
        const expOfCurLevel = this.expFromLevel(level);
        const curLevelProgress = this[`exp${varName}`] - expOfCurLevel;
        const nextLevelNeeds = this.expFromLevel(level + 1) - expOfCurLevel;
        return Math.floor(curLevelProgress / nextLevelNeeds * 100 * 10) / 10;
    };

    // finishes actions that have checkable aspects
    finishRegular(varName, rewardRatio, rewardFunc) {
        // fork: P2 lootable contents schedule (world data, managed mode) —
        // the scheduled walk lives beside the XML interpreter; with no
        // schedule this body runs unchanged (byte-inert).
        if (typeof ActionListXml !== "undefined" && ActionListXml.handlesLoot(varName)) {
            return ActionListXml.lootFinishRegular(this, varName, rewardRatio, rewardFunc);
        }
        // error state, negative numbers.
        if (this[`total${varName}`] - this[`checked${varName}`] < 0) {
            this[`checked${varName}`] = this[`total${varName}`];
            this[`good${varName}`] = Math.floor(this[`total${varName}`] / rewardRatio);
            this[`goodTemp${varName}`] = this[`good${varName}`];
            console.log("Error state fixed");
        }

        // only checks unchecked items 
        // IF there are unchecked items 
        // AND the user has not disabled checking unchecked items OR there are no checked items left
        const searchToggler = inputElement(`searchToggler${varName}`, false, false);
        if (this[`total${varName}`] - this[`checked${varName}`] > 0 && ((searchToggler && !searchToggler.checked) || this[`goodTemp${varName}`] <= 0)) {
            this[`checked${varName}`]++;
            if (this[`checked${varName}`] % rewardRatio === 0) {
                this[`lootFrom${varName}`] += rewardFunc();
                this[`good${varName}`]++;
            }
        } else if (this[`goodTemp${varName}`] > 0) {
            this[`goodTemp${varName}`]--;
            this[`lootFrom${varName}`] += rewardFunc();
        }
        view.requestUpdate("updateRegular", {name: varName, index: this.index});
    };

    createVars(varName) {
        if (this[`checked${varName}`] === undefined) {
            this[`checked${varName}`] = 0;
        }
        if (this[`goodTemp${varName}`] === undefined) {
            this[`goodTemp${varName}`] = 0;
        }
        if (this[`good${varName}`] === undefined) {
            this[`good${varName}`] = 0;
        }
        if (this[`lootFrom${varName}`] === undefined) {
            this[`lootFrom${varName}`] = 0;
        }
        if (this[`total${varName}`] === undefined) {
            this[`total${varName}`] = 0;
        }
        if (this.varNames.indexOf(varName) === -1) {
            this.varNames.push(varName);
            this.allVarNames.push(varName);
        }
    };

    /** @param {ProgressScalingType} [progressScaling] */
    createProgressVars(varName, progressScaling = "default") {
        if (this[`exp${varName}`] === undefined) {
            this[`exp${varName}`] = 0;
        }
        if (this.progressVars.indexOf(varName) === -1) {
            this.progressVars.push(varName);
            this.allVarNames.push(varName);
            this.progressScaling[varName] = progressScaling;
        }
    };

    createMultipartVars(varName) {
        this[varName] = 0;
        this[`${varName}LoopCounter`] = 0;
        if (!this.multipartVars.includes(varName)) {
            this.multipartVars.push(varName);
            this.allVarNames.push(varName);
        }
    }

    constructor(index) {
        this.index = index;
        let lateGameActionCount = 0;
        let inLateGameActions = true;
        for (const action of totalActionList) {
            if (this.index === action.townNum) {
                if (inLateGameActions) {
                    if (lateGameActions.includes(action.name)) {
                        lateGameActionCount++;
                    } else {
                        inLateGameActions = false;
                    }
                }
                if (!inLateGameActions && lateGameActionCount > 0 && isTravel(action.name)) {
                    // shift late-game actions to end of action button list
                    this.totalActionList.push(...this.totalActionList.splice(0, lateGameActionCount));
                    lateGameActionCount = 0;
                }
                // @ts-ignore
                this.totalActionList.push(action);
                if (action.type === "limited") this.createVars(action.varName);
                if (action.type === "progress") this.createProgressVars(action.varName, action.progressScaling);
                if (action.type === "multipart") this.createMultipartVars(action.varName);
            }
        }
    }
}