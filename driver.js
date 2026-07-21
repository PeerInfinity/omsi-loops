"use strict";

// The number of towns. Centralizes the literal 9 / 8 the town loops used to
// spell out (initializeTowns in saving.js, the two count loops in
// main.view.js). It lives here rather than beside `const towns` in saving.js
// because both saving.js and views/main.view.js load AFTER driver.js in every
// boot context (index.html, the workers, and test/harness.mjs SIM_FILES), and
// main.view.js's count loops run at top-level load time — a const in saving.js
// would still be in its temporal dead zone when they execute. Byte-inert: 9
// stays 9; varying it is arc E (multi-town), which also needs the dynamic DOM
// and getTravelNum work this constant deliberately does not touch.
const TOWN_COUNT = 9;

// eslint-disable-next-line prefer-const
let gameSpeed = 1;
const baseManaPerSecond = 50;

let curTime = Date.now();
let gameTicksLeft = 0; // actually milliseconds, not ticks
let refund = false;
let radarUpdateTime = 0;
let timeCounter = 0;
let effectiveTime = 0;
let lastSave = Date.now();
let lagSpeed = 0;

function getSpeedMult(zone = curTown) {
    let speedMult = 1;

    // Dark Ritual
    if (zone === 0) speedMult *= getRitualBonus(0, 20, 10);
    else if (zone === 1) speedMult *= getRitualBonus(20, 40, 5);
    else if (zone === 2) speedMult *= getRitualBonus(40, 60, 2.5);
    else if (zone === 3) speedMult *= getRitualBonus(60, 80, 1.5);
    else if (zone === 4) speedMult *= getRitualBonus(80, 100, 1);
    else if (zone === 5) speedMult *= getRitualBonus(100, 150, .5);
    else if (zone === 6) speedMult *= getRitualBonus(150, 200, .5);
    else if (zone === 7) speedMult *= getRitualBonus(200, 250, .5);
    else if (zone === 8) speedMult *= getRitualBonus(250, 300, .5);
    speedMult *= getRitualBonus(300, 666, .1);
    
    // Chronomancy
    speedMult *= getSkillBonus("Chronomancy");
    
    // Imbue Soul
    speedMult *= 1 + 0.5 * getBuffLevel("Imbuement3");

    // Prestige Chronomancy
    speedMult *= prestigeBonus("PrestigeChronomancy");

    return speedMult;
}

function getActualGameSpeed() {
    return gameSpeed * getSpeedMult() * bonusSpeed;
}

function refreshDungeons(manaSpent) {
    for (const dungeon of dungeons) {
        for (const level of dungeon) {
            const chance = level.ssChance;
            if (chance < 1) level.ssChance = Math.min(chance + 0.0000001 * manaSpent, 1);
        }
    }
}

function singleTick() {
    timer++;
    timeCounter += 1 / baseManaPerSecond;
    effectiveTime += 1 / baseManaPerSecond;

    actions.tick();

    refreshDungeons(1);

    if (shouldRestart || timer >= timeNeeded) {
        loopEnd();
        prepareRestart();
    }
    gameTicksLeft -= ((1000 / baseManaPerSecond));
}

let lastAnimationTime = 0;
let animationFrameRequest = 0;
let animationTicksEnabled = true;

function animationTick(animationTime) {
    if (animationTime == lastAnimationTime || !animationTicksEnabled) {
        // double tick in the same frame, drop this one
        return;
    }
    try {
        tick();
    } finally {
        animationFrameRequest = requestAnimationFrame(animationTick);
    }
}

function tick() {
    const newTime = Date.now();
    gameTicksLeft += newTime - curTime;
    if (inputElement("radarStats").checked) radarUpdateTime += newTime - curTime;
    const delta = newTime - curTime;
    curTime = newTime;

    // save even when paused
    if (curTime - lastSave > options.autosaveRate * 1000) {
        lastSave = curTime;
        save();
    }

    // don't do any updates until we've got enough time built up to match the refresh rate setting
    if (gameTicksLeft < 1000 / windowFps) {
        return;
    }

    // if (document.getElementById("rewindButton")?.matches(":active")) {
    //     addOffline(gameTicksLeft * offlineRatio);
    //     gameTicksLeft = 0;
    //     if (Data.snapshotStack.length > 2) {
    //         Data.revertToSnapshot(-1);
    //         view.requestUpdate("updateTime", null);
    //         view.requestUpdate("updateCurrentActionLoops", actions.currentPos);
    //         view.requestUpdate("updateCurrentActionBar", actions.currentPos);
    //         view.updateStats();
    //         view.updateSkills();
    //         view.updateBuffs();
    //     }
    //     view.update();
    //     return;
    // }

    if (gameIsStopped) {
        addOffline(gameTicksLeft * offlineRatio);
        updateLag(0);
        view.update();
        gameTicksLeft = 0;
        return;
    }

    const deadline = performance.now() + 1000 / windowFps; // don't go past the current frame update time
    // Data.recordSnapshot("tick");

    executeGameTicks(deadline);
}

function executeGameTicks(deadline) {
    // convert "gameTicksLeft" (actually milliseconds) into equivalent base-mana count, aka actual game ticks
    // including the gameSpeed multiplier here because it is effectively constant over the course of a single
    // update, and it affects how many actual game ticks pass in a given span of realtime.
    let baseManaToBurn = Mana.floor(gameTicksLeft * baseManaPerSecond * gameSpeed / 1000);
    const originalManaToBurn = baseManaToBurn;
    let cleanExit = false;

    while (baseManaToBurn * bonusSpeed >= (options.fractionalMana ? 0.01 : 1) && performance.now() < deadline) {
        if (gameIsStopped) {
            cleanExit = true;
            break;
        }
        // first, figure out how much *actual* mana is available to get spent. bonusSpeed gets rolled in first,
        // since it can change over the course of an update (if offline time runs out)
        let manaAvailable = baseManaToBurn;
        // totalMultiplier lets us back-convert from manaAvailable (in units of "effective game ticks") to
        // baseManaToBurn (in units of "realtime ticks modulated by gameSpeed") once we figure out how much
        // of our mana we're using in this cycle
        let totalMultiplier = 1;

        manaAvailable *= bonusSpeed;
        totalMultiplier *= bonusSpeed;

        if (bonusSpeed > 1) {
            // can't spend more mana than offline time available
            manaAvailable = Math.min(manaAvailable, Mana.ceil(totalOfflineMs * baseManaPerSecond * gameSpeed * bonusSpeed / 1000));
        }

        // next, roll in the multiplier from skills/etc
        let speedMult = getSpeedMult();
        manaAvailable *= speedMult;
        totalMultiplier *= speedMult;

        // limit to only how much time we have available
        manaAvailable = Math.min(manaAvailable, timeNeeded - timer);

        // don't run more than 1 tick
        if (shouldRestart) {
            manaAvailable = Math.min(manaAvailable, 1);
        }

        // a single action may not use a partial tick, so ceil() to be sure unless fractionalMana.
        // Even with fractionalMana, we need to set a minimum so that mana usages aren't lost to floating-point precision.
        const manaSpent = Mana.ceil(actions.tick(manaAvailable), timer / 1e15);

        // okay, so the current action has used manaSpent effective ticks. figure out how much of our realtime
        // that accounts for, in base ticks and in seconds.
        const baseManaSpent = manaSpent / totalMultiplier;
        const timeSpent = baseManaSpent / gameSpeed / baseManaPerSecond;

        // update timers
        timer += manaSpent; // number of effective mana ticks
        timeCounter += timeSpent; // realtime seconds
        effectiveTime += timeSpent * gameSpeed * bonusSpeed; // "seconds" modified only by gameSpeed and offline bonus
        baseManaToBurn -= baseManaSpent; // burn spent mana
        gameTicksLeft -= timeSpent * 1000;

        // spend bonus time for this segment
        if (bonusSpeed !== 1) {
            addOffline(-timeSpent * (bonusSpeed - 1) * 1000);
        }

        refreshDungeons(manaSpent);

        if (shouldRestart || timer >= timeNeeded) {
            cleanExit = true;
            loopEnd();
            prepareRestart();
            break; // don't span loops within tick()
        }
    }

    if (radarUpdateTime > 100) {
        view.updateStatGraphNeeded = true;
        radarUpdateTime %= 100;
    }

    if (!gameIsStopped && baseManaToBurn * bonusSpeed >= 10) {
        if (!cleanExit || lagSpeed > 0) {
            // lagging. refund all backlog as bonus time to clear the queue
            addOffline(gameTicksLeft * offlineRatio);
            gameTicksLeft = 0;
        }
        updateLag((originalManaToBurn - baseManaToBurn) * bonusSpeed);
    } else if (baseManaToBurn * bonusSpeed < 1) {
        // lag cleared
        updateLag(0);
    }

    view.update();

}

function recalcInterval(fps) {
    windowFps = fps;
    // fork: in managed mode the host owns time — the clock never starts.
    // Undefined in workers and headless harnesses (managed.js is page-only).
    if (typeof IdleLoopsManaged !== "undefined" && IdleLoopsManaged.active) return;
    if (mainTickLoop !== undefined) {
        clearInterval(mainTickLoop);
    }
    if (window.requestAnimationFrame) {
        animationFrameRequest = requestAnimationFrame(animationTick);
        mainTickLoop = setInterval(tick, 1000);
    } else {
        mainTickLoop = setInterval(tick, 1000 / fps);
    }
}

function stopGame() {
    gameIsStopped = true;
    view.requestUpdate("updateTime", null);
    view.requestUpdate("updateCurrentActionBar", actions.currentPos);
    view.update();
    document.title = "*PAUSED* Idle Loops";
    document.getElementById("pausePlay").textContent = _txt("time_controls>play_button");
    if (needsDataSnapshots()) {
        Data.updateSnapshot("stop", "base");
    }
    if (options.predictor) {
        view.requestUpdate("updateNextActions");
    }
}

function pauseGame(ping, message) {
    gameIsStopped = !gameIsStopped;
    if (needsDataSnapshots()) {
        Data.discardToSnapshot("base", 1);
        Data.recordSnapshot("pause");
    }
    view.requestUpdate("updateTime", null);
    view.requestUpdate("updateCurrentActionBar", actions.currentPos);
    view.update();
    if (!gameIsStopped && options.notifyOnPause) {
        clearPauseNotification();
    }
    document.title = gameIsStopped ? "*PAUSED* Idle Loops" : "Idle Loops";
    document.getElementById("pausePlay").textContent = _txt(`time_controls>${gameIsStopped ? "play_button" : "pause_button"}`);
    if (!gameIsStopped && (shouldRestart || timer >= timeNeeded)) {
        restart();
    } else if (ping) {
        if (options.pingOnPause) {
            beep(250);
            setTimeout(() => beep(250), 500);
        }
        if (options.notifyOnPause) {
            showPauseNotification(message || "Game paused!");
        }
    }
}

function loopEnd() {
    if (effectiveTime > 0) {
        totals.time += timeCounter;
        totals.effectiveTime += effectiveTime;
        totals.loops++;
        view.requestUpdate("updateTotals", null);
        const loopCompletedActions = actions.current.slice(0, actions.currentPos);
        if (actions.current[actions.currentPos] !== undefined && actions.current[actions.currentPos].loopsLeft < actions.current[actions.currentPos].loops)
            loopCompletedActions.push(actions.current[actions.currentPos]);
        markActionsComplete(loopCompletedActions);
        actionStory(loopCompletedActions);
        if (options.highlightNew) {
            view.requestUpdate("removeAllHighlights", null);
            view.requestUpdate("highlightIncompleteActions", null);
        }
    }
}

function prepareRestart() {
    const curAction = actions.getNextValidAction();
    // fork: Advanced Automation may take over the restart (pause until the
    // planner's queue for the next loop arrives). Undefined in workers and
    // headless harnesses, where the original flow must be untouched.
    if (typeof AdvancedAutomation !== "undefined" && AdvancedAutomation?.interceptPrepareRestart?.(curAction)) return;
    if (options.pauseBeforeRestart ||
        (options.pauseOnFailedLoop &&
         (actions.current.filter(action => action.loopsLeft - action.extraLoops > 0).length > 0))) {
        if (options.pingOnPause) {
            beep(250);
            setTimeout(() => beep(250), 500);
        }
        if (options.notifyOnPause) {
            showPauseNotification("Game paused!");
        }
        if (curAction) {
            actions.completedTicks += actions.getNextValidAction().ticks;
            view.requestUpdate("updateTotalTicks", null);
        }
        for (let i = 0; i < actions.current.length; i++) {
            view.requestUpdate("updateCurrentActionBar", i);
        }
        stopGame();
    } else {
        restart();
    }
}

function restart() {
    shouldRestart = false;
    timer = 0;
    timeCounter = 0;
    effectiveTime = 0;
    timeNeeded = timeNeededInitial;
    document.title = "Idle Loops";
    currentLoop = totals.loops + 1; // don't let currentLoop get out of sync with totals.loops, that'd cause problems
    resetResources();
    restartStats();
    for (let i = 0; i < towns.length; i++) {
        towns[i].restart();
    }
    view.requestUpdate("updateSkills");
    // fork: unlock diff pass — a full pass, because a restart resets every
    // town's per-loop progress at once (towns[i].restart() above)
    Unlocks.check();
    actions.restart();
    view.requestUpdate("updateCurrentActionsDivs");
    view.requestUpdate("updateTrials", null);
    if (needsDataSnapshots()) {
        Data.updateSnapshot("restart", "base");
    }
    // fork: P2 award carrier — per-loop grant counters restart with the loop
    // (same reset moment as resetResources above; inert with no schedule)
    if (typeof ActionListXml !== "undefined") ActionListXml.onLoopRestart();
    // fork: loop-reset callback for the substrate host (page-only; see above)
    if (typeof IdleLoopsManaged !== "undefined") IdleLoopsManaged._onRestart();
}

function manualRestart() {
    loopEnd();
    restart();
    view.update();
}


function addActionToList(name, townNum, isTravelAction, insertAtIndex) {
    for (const action of towns[townNum].totalActionList) {
        if (action.name === name) {
            if (action.visible() && action.unlocked() && (!action.allowed || getNumOnList(action.name) < action.allowed())) {
                let addAmount = actions.addAmount;
                if (action.allowed) {
                    const numMax = action.allowed();
                    const numHave = getNumOnList(action.name);
                    if (numMax - numHave < addAmount) {
                        addAmount = numMax - numHave;
                    }
                }
                if (isTravelAction) {
                    const index = actions.addAction(name, 1, insertAtIndex);
                    view.requestUpdate("highlightAction", index);
                } else {
                    const index = actions.addAction(name, addAmount, insertAtIndex);
                    view.requestUpdate("highlightAction", index);
                    if (shiftDown && hasLimit(name)) {
                        capAmount(index, townNum);
                    } else if (shiftDown && isTraining(name)) {
                        capTraining(index);
                    }
                }
            }
        }
    }
    view.updateNextActions();
    view.updateLockedHidden();
}

// mana and resources

function addMana(amount) {
    timeNeeded += amount;
}

function addResource(resource, amount) {
    if (Number.isFinite(amount)) resources[resource] += amount;
    else resources[resource] = amount;
    view.requestUpdate("updateResource", resource);

    if (resource === "teamMembers" || resource === "armor" || resource === "zombie") view.requestUpdate("updateTeamCombat",null);
}

function resetResource(resource) {
    resources[resource] = resourcesTemplate[resource];
    view.requestUpdate("updateResource", resource);
}

function resetResources() {
    resources = copyObject(resourcesTemplate);
    if(getExploreProgress() >= 100 || prestigeValues['completedAnyPrestige']) addResource("glasses", true);
    view.requestUpdate("updateResources", null);
}

function changeActionAmount(amount) {
    amount = Math.max(amount, 1);
    amount = Math.min(amount, 1e12);
    actions.addAmount = amount;
    const customInput = inputElement("amountCustom");
    if (document.activeElement !== customInput) {
        customInput.value = amount;
    }
    view.updateAddAmount(amount);
}

function setCustomActionAmount() {
    const value = parseInt(inputElement("amountCustom").value) || 1;
    changeActionAmount(value);
}

function selectLoadout(num) {
    if (curLoadout === num) {
        curLoadout = 0;
    } else {
        curLoadout = num;
    }
    inputElement("renameLoadout").value = loadoutnames[curLoadout - 1];
    view.updateLoadout(curLoadout);
}

function loadLoadout(num) {
    curLoadout = num;
    view.updateLoadout(curLoadout);
    loadList();
}

let globalCustomInput = "";
function saveList() {
    if (curLoadout === 0) {
        save();
        return;
    }
    nameList(false);
    loadouts[curLoadout] = copyArray(actions.next);
    save();
    if ((inputElement("renameLoadout").value !== "Saved!")) globalCustomInput = inputElement("renameLoadout").value;
    inputElement("renameLoadout").value = "Saved!";
    setTimeout(() => {
        inputElement("renameLoadout").value = globalCustomInput;
    }, 1000);
}

function nameList(saveGame) {
    // if the loadout has already been saved under a non-numeric name
    // and the user tries to save under a numeric name, the loadout will
    // be saved under an old name
    // if both the old AND the new names are numeric, then we insist on a non-numeric name
    if (isNaN(parseFloat(inputElement("renameLoadout").value))) {
        if (inputElement("renameLoadout").value.length > 30) {
            inputElement("renameLoadout").value = "30 Letter Max";
        } else if (inputElement("renameLoadout").value !== "Saved!") {
            loadoutnames[curLoadout - 1] = inputElement("renameLoadout").value;
        }
    } else if (!isNaN(parseFloat(loadoutnames[curLoadout - 1]))) {
        inputElement("renameLoadout").value = "Enter a name!";
    }
    document.getElementById(`load${curLoadout}`).textContent = loadoutnames[curLoadout -1];
    if (saveGame) save();
}

function loadList() {
    if (curLoadout === 0) {
        return;
    }
    inputElement("amountCustom").value = actions.addAmount.toString();
    actions.clearActions();
    if (loadouts[curLoadout]) {
        actions.appendActionRecords(loadouts[curLoadout]);
    }
    view.updateNextActions();
    view.adjustDarkRitualText();
}

function clearList() {
    actions.clearActions(shiftDown ? (a => (a.disabled || a.loops === 0)) : null);
    view.updateNextActions();
}

function unlockTown(townNum) {
    if (!towns[townNum].unlocked()) {
        townsUnlocked.push(townNum);
        townsUnlocked.sort();
        // refresh current
        view.showTown(townNum);
        view.requestUpdate("updateTravelMenu",null);
    }
    let cNum = challengeSave.challengeMode;
    if (cNum !== 0) {
        if(challengeSave["c"+cNum]<townNum) challengeSave["c"+cNum] = townNum;
        else if(challengeSave["c"+cNum] === undefined) challengeSave["c"+cNum] = townNum;
    }
    curTown = townNum;
}

function adjustAll() {
    // The 14 XML-declared quantity totals, recomputed from their
    // <totalDiscovered> blocks (arc B). Byte-identical to the deleted
    // adjustPots()..adjustWells() functions; town resolution stays inside the
    // evaluator (townFor / ctx.action.townNum).
    ActionListXml.applyQuantityTotals();
    adjustPockets();          // retained — town-7 Excursion, no <totalDiscovered>
    adjustWarehouses();       // retained
    adjustInsurance();        // retained
    adjustAllRocks();         // retained — hauls + good/goodTemp/usedStones
    adjustTrainingExpMult();  // retained — sets expMult, not a town total
    // fork: AP-managed capacity substitution (unlock-discretization plan §9
    // U4). The ONE choke point — every total{Var} write in the game passes
    // through the adjust*() calls above, and load() re-runs adjustAll after
    // restoring saved totals. With no managed vars this is a Map.size check.
    Unlocks.applyManagedTotals();
    view.requestUpdate("adjustManaCost", "Continue On");
}

function capAction(actionId) {
    const action = actions.findActionWithId(actionId);
    if (!action) return;
    if (hasLimit(action.name)) {
        return capAmount(action.index, getActionPrototype(action.name).townNum);
    } else if (isTraining(action.name)) {
        return capTraining(action.index);
    }
}

function capAmount(index, townNum) {
    const action = actions.next[index];
    const varName = `good${getActionPrototype(action.name)?.varName}`;
    let alreadyExisting;
    //if (action.name.startsWith("Survey")) alreadyExisting = getOtherSurveysOnList("") + (action.disabled ? action.loops : 0);
    //else
    alreadyExisting = getNumOnList(action.name) + (action.disabled ? action.loops : 0);
    let newLoops;
    if (action.name.startsWith("Survey")) newLoops = 500 - alreadyExisting;
    if (action.name === "Gather Team") newLoops = 5 + Math.floor(getSkillLevel("Leadership") / 100) - alreadyExisting;
    else newLoops = towns[townNum][varName] - alreadyExisting;
    actions.updateAction(index, {loops: clamp(action.loops + newLoops, 0, null)});
    view.updateNextActions();
    view.updateLockedHidden();
}

function capTraining(index) {
    const action = actions.next[index];
    const alreadyExisting = getNumOnList(action.name) + (action.disabled ? action.loops : 0);
    const newLoops = trainingLimits - alreadyExisting;
    actions.updateAction(index, {loops: clamp(action.loops + newLoops, 0, null)});
    view.updateNextActions();
    view.updateLockedHidden();
}

function capAllTraining() {
    for (const [index,action] of actions.next.entries())
    {
        // @ts-ignore
        if (trainingActions.includes(action.name)) {
            //console.log("Training Action on list: " + action.name);
            capTraining(index);
        }
    }

}

function addLoop(actionId) {
    const action = actions.findActionWithId(actionId);
    const theClass = getActionPrototype(action.name);
    let addAmount = actions.addAmount;
    if (theClass.allowed) {
        const numMax = theClass.allowed();
        const numHave = getNumOnList(theClass.name) + (action.disabled ? action.loops : 0);
        if ((numMax - numHave) < addAmount) {
            addAmount = numMax - numHave;
        }
    }
    actions.updateAction(action.index, {loops: clamp(action.loops + addAmount, 0, 1e12)});
    view.updateNextActions();
    view.updateLockedHidden();
}
function removeLoop(actionId) {
    const action = actions.findActionWithId(actionId);
    actions.updateAction(action.index, {loops: clamp(action.loops - actions.addAmount, 0, 1e12)});
    view.updateNextActions();
    view.updateLockedHidden();
}
function split(actionId) {
    const action = actions.findActionWithId(actionId);
    actions.splitAction(action.index);
    view.updateNextActions();
}

function collapse(actionId) {
    const action = actions.findActionWithId(actionId);
    actions.updateAction(action.index, {collapsed: !action.collapsed});
    view.updateNextActions();
}

function showNotification(name) {
    document.getElementById(`${name}Notification`).style.display = "block";
}

function hideNotification(name) {
    unreadActionStories = unreadActionStories.filter(toRead => toRead !== name);
    document.getElementById(`${name}Notification`).style.display = "none";
}

function hideActionIcons() {
    document.getElementById("nextActionsList").className = "disabled";
}

function showActionIcons() {
    document.getElementById("nextActionsList").className = "";
}

function handleDragStart(event) {
    const index = event.target.getAttribute("data-action-id");
    draggedDecorate(index);
    event.dataTransfer.setData("text/html", index);
    hideActionIcons();
}

function handleDirectActionDragStart(event, actionName, townNum, actionVarName, isTravelAction) {
    // @ts-ignore
    document.getElementById(`container${actionVarName}`).children[2].style.display = "none";
    const actionData = { _actionName: actionName, _townNum: townNum, _isTravelAction: isTravelAction };
    const serialData = JSON.stringify(actionData);
    event.dataTransfer.setData("actionData", serialData);
    hideActionIcons();
}


function handleDirectActionDragEnd(actionVarName) {
    // @ts-ignore
    document.getElementById(`container${actionVarName}`).children[2].style.display = "";
    showActionIcons();
}


function handleDragOver(event) {
    event.preventDefault();
}

function handleDragDrop(event) {
    const idOfDroppedOverElement = event.target.getAttribute("data-action-id");
    const indexOfDroppedOverElement = actions.findIndexOfActionWithId(idOfDroppedOverElement);
    dragExitUndecorate(idOfDroppedOverElement);
    const initialId = event.dataTransfer.getData("text/html");
    if (initialId === "") {
        const actionData = JSON.parse(event.dataTransfer.getData("actionData"));
        addActionToList(actionData._actionName, actionData._townNum, actionData._isTravelAction, indexOfDroppedOverElement);
    } else {
        moveQueuedAction(actions.findIndexOfActionWithId(initialId), indexOfDroppedOverElement);
    }
    showActionIcons();
}

function moveQueuedAction(initialIndex, resultingIndex) {
    if (initialIndex < 0 || initialIndex > actions.next.length || resultingIndex < 0 || resultingIndex > actions.next.length - 1) {
        return;
    }

    actions.moveAction(initialIndex, resultingIndex, true);
    
    view.updateNextActions();
}

function moveUp(actionId) {
    const index = actions.findIndexOfActionWithId(actionId);
    if (index <= 0) {
        return;
    }
    actions.moveAction(index, index - 1);
    view.updateNextActions();
}
function moveDown(actionId) {
    const index = actions.findIndexOfActionWithId(actionId);
    if (index >= actions.next.length - 1) {
        return;
    }
    actions.moveAction(index, index + 1);
    view.updateNextActions();
}
function disableAction(actionId) {
    const index = actions.findIndexOfActionWithId(actionId);
    const action = actions.next[index];
    const translated = getActionPrototype(action.name);
    if (action.disabled) {
        if (!translated.allowed || getNumOnList(action.name) + action.loops <= translated.allowed()) actions.updateAction(index, {disabled: false});
    } else {
        actions.updateAction(index, {disabled: true});
    }
    view.updateNextActions();
    view.requestUpdate("updateLockedHidden", null);
}
function removeAction(actionId) {
    const index = actions.findIndexOfActionWithId(actionId);
    actions.removeAction(index);
    view.updateNextActions();
    view.requestUpdate("updateLockedHidden", null);
}

function borrowTime() {
    addOffline(86400_000);
    totals.borrowedTime += 86400;
    view.requestUpdate("updateOffline", null);
    view.requestUpdate("updateTotals", null);
}

function returnTime() {
    if (totalOfflineMs >= 86400_000) {
        addOffline(-86400_000);
        totals.borrowedTime -= 86400;
        view.requestUpdate("updateOffline", null);
        view.requestUpdate("updateTotals", null);
    }
}

let lagStart = 0;
let lagSpent = 0;
function updateLag(manaSpent) {
    if (manaSpent === 0) { // cancel lag display
        if (lagSpeed !== 0) {
            lagSpeed = 0;
            view.requestUpdate("updateBonusText", null);
        }
        return;
    }
    if (lagSpeed === 0) {
        // initial lag. 
        lagStart = performance.now();
        lagSpent = 0;
        lagSpeed = 1;
        return;
    }
    // update lag
    lagSpent += manaSpent;
    const now = performance.now();
    const measuredSpeed = lagSpent / (now - lagStart) * 1000 / baseManaPerSecond;
    lagSpeed = measuredSpeed;
    view.requestUpdate("updateBonusText", null);
}

function addOffline(num) {
    if (num) {
        if (totalOfflineMs + num < 0 && bonusSpeed > 1) {
            toggleOffline();
        }
        totalOfflineMs += num;
        if (totalOfflineMs < 0) {
            totalOfflineMs = 0;
        }
        view.requestUpdate("updateOffline", null);
    }
}

function toggleOffline() {
    if (totalOfflineMs === 0) return;
    if (!isBonusActive()) {
        bonusSpeed = 5;
        bonusActive = true;
        checkExtraSpeed();
        document.getElementById("isBonusOn").textContent = _txt("time_controls>bonus_seconds>state>on");
    } else {
        bonusSpeed = 1;
        bonusActive = false;
        document.getElementById("isBonusOn").textContent = _txt("time_controls>bonus_seconds>state>off");
    }
    setOption("bonusIsActive", bonusActive, true);
    view.requestUpdate("updateTime", null);
}

function isBonusActive() {
    return bonusActive && bonusSpeed !== 1;
}

function checkExtraSpeed() {
    view.requestUpdate("updateBonusText", null);
    if (typeof options.speedIncreaseBackground === "number" && !isNaN(options.speedIncreaseBackground) && options.speedIncreaseBackground >= 0 && !document.hasFocus() && (options.speedIncreaseBackground < 1 || isBonusActive())) {
        if (options.speedIncreaseBackground === 1) {
            bonusSpeed = 1.00001;
        } else if (options.speedIncreaseBackground === 0) {
            bonusSpeed = 0.0000001; // let's avoid any divide by zero errors shall we
        } else {
            bonusSpeed = options.speedIncreaseBackground;
        }
        return;
    }
    if (!isBonusActive()) {
        bonusSpeed = 1;
        return;
    }
    if (options.speedIncrease10x === true) { bonusSpeed = 10};
    if (options.speedIncrease20x === true) { bonusSpeed = 20};
    if (bonusSpeed < options.speedIncreaseCustom) { bonusSpeed = options.speedIncreaseCustom };
}
