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

    static {
        Data.omitProperties(this.prototype, ["hiddenVars"]);
    }

    unlocked() {
        return townsUnlocked.includes(this.index);
    };

    expFromLevel(level) {
        return level * (level + 1) * 50;
    };

    getLevel(varName) {
        if (varName === "Survey") varName = varName + "Z" + this.index;
        if (this.progressScaling[varName] === "linear") return Math.floor(this[`exp${varName}`] / 5050);
        return Math.floor((Math.sqrt(8 * this[`exp${varName}`] / 100 + 1) - 1) / 2);
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
        // return if capped, for performance
        if (this[`exp${varName}`] === 505000) {
            if (options.pauseOnComplete) pauseGame(true, "Progress complete! (Game paused)");
            else return;
        }

        const prevLevel = this.getLevel(varName);
        if (this[`exp${varName}`] + expGain > 505000) {
            this[`exp${varName}`] = 505000;
        } else {
            this[`exp${varName}`] += expGain;
        }
        const level = this.getLevel(varName);
        if (level !== prevLevel) {
            view.requestUpdate("updateLockedHidden", null);
            adjustAll();
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
        const level = this.getLevel(varName);
        if (level >= 100) return 100;
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