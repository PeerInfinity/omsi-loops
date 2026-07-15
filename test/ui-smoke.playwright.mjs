// Playwright smoke for the Stats-panel Automation view. MANUAL-RUN (not in
// the npm-test glob): needs a browser, the outer repo's playwright dep, and a
// dev server serving the outer repo root on :8000.
//   node test/ui-smoke.playwright.mjs
// Env overrides: PLAYWRIGHT_PKG (path to playwright's index.mjs), SMOKE_URL.
const pwPath = process.env.PLAYWRIGHT_PKG
    ?? new globalThis.URL("../../../../node_modules/playwright/index.mjs", import.meta.url).href;
const { chromium } = await import(pwPath);

const PAGE_URL = process.env.SMOKE_URL ?? "http://localhost:8000/frontend/modules/omsi-loops/index.html";
const fails = [];
const check = (cond, name) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fails.push(name); };

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => fails.push("pageerror: " + e.message));
await page.goto(PAGE_URL, { waitUntil: "load" });
await page.waitForFunction(() => typeof options !== "undefined" && typeof view !== "undefined", null, { timeout: 20000 });
await page.waitForTimeout(1500);

// 1. both masters off: radio hidden
check(await page.$eval("#automationStatsWrap", el => getComputedStyle(el).display === "none"),
    "automation radio hidden while both masters off");

// 2. radio appears when EITHER master is on: basic alone first, then add advanced
await page.evaluate(() => setOption("basicAutomation", true));
check(await page.$eval("#automationStatsWrap", el => getComputedStyle(el).display !== "none"),
    "automation radio visible with basic automation on (advanced off)");
await page.evaluate(() => setOption("advancedAutomation", true));
check(await page.$eval("#automationStatsWrap", el => getComputedStyle(el).display !== "none"),
    "automation radio still visible with advanced also on");

// 3. switch to the automation view
await page.click("#automationStats");
check(await page.$eval("#statsWindow", el => el.dataset.view === "automation"), "data-view flips to automation");
check(await page.$eval("#automationView", el => getComputedStyle(el).display !== "none"), "automation view shown");
check(await page.$eval("#statsContainer", el => getComputedStyle(el).display === "none"), "regular stat rows hidden");

// 4. compact stats table populated
await page.waitForTimeout(200);
const statRows = await page.$$eval("#autoStatsBody tr", rr => rr.length);
check(statRows >= 9, `compact stats rows (${statRows})`);

// 4b. "Show" masters reveal each section; each holds its own in-section "Enable"
//     checkbox + the feature toggles.
check(await page.$eval("#autoViewBasicSettings", el => getComputedStyle(el).display !== "none"),
    "Basic automation section visible while basic master shown");
check(await page.$eval("#autoViewSettings", el => getComputedStyle(el).display !== "none"),
    "Advanced settings section visible while advanced master shown");
for (const id of ["basicAutomationEnabledInput", "predictorRepGapInput", "autoAddRepsInput", "economyOptimizerInput"]) {
    check(await page.$eval(`#autoViewBasicSettings #${id}`, () => true).catch(() => false),
        `${id} lives in the Basic automation section`);
}
check(await page.$eval(`#autoViewSettings #advancedAutomationEnabledInput`, () => true).catch(() => false),
    "advancedAutomationEnabledInput lives in the Advanced settings section");
// "Enable" defaults on, so showing a tier enables it (features run when shown+enabled)
check(await page.evaluate(() => options.basicAutomationEnabled === true && options.advancedAutomationEnabled === true),
    "enable flags default on (show => enabled in one step)");

// 5. settings section holds the moved inputs; Extras hint replaced the block
for (const id of ["plannerModeInput", "plannerScreenKInput", "plannerWeightTravelReliefInput", "plannerWeightHeadroomInput",
                  // §11.10 targeted mode UI (plannerTargets is now a row editor, not a textarea)
                  "plannerStrategyInput", "plannerAutoRankTargetsInput", "plannerTargetsEditor",
                  "plannerTargetsUnlockedOnlyInput", "plannerAntiFixationInput"]) {
    check(await page.$eval(`#automationView #${id}`, () => true).catch(() => false), `${id} lives in the automation view`);
}
check(await page.$eval("#expGainMultiplierInput", el => !el.closest("#automationView")), "expGainMultiplier stays in Extras");

// 5b. §11.7 Design B pipeline controls: live in the settings view; the
//     replan/late sub-controls reveal on plannerPipeline; options round-trip.
for (const id of ["plannerPipelineInput", "plannerReplanEveryInput", "plannerLatePlanInput"]) {
    check(await page.$eval(`#automationView #${id}`, () => true).catch(() => false), `${id} lives in the automation view`);
}
check(await page.$eval("#plannerPipelineSection", el => getComputedStyle(el).display === "none"),
    "pipeline sub-section hidden while plannerPipeline off");
await page.evaluate(() => setOption("plannerPipeline", true));
check(await page.$eval("#plannerPipelineSection", el => getComputedStyle(el).display !== "none"),
    "pipeline sub-section visible while plannerPipeline on");
await page.evaluate(() => setOption("plannerReplanEvery", 3));
check(await page.$eval("#plannerReplanEveryInput", el => (loadOption("plannerReplanEvery", options.plannerReplanEvery), el.value === "3")),
    "replanEvery input syncs from loadOption");
await page.evaluate(() => setOption("plannerLatePlan", "repeat"));
check(await page.$eval("#plannerLatePlanInput", el => (loadOption("plannerLatePlan", options.plannerLatePlan), el.value === "repeat")),
    "late-plan select syncs from loadOption");
await page.evaluate(() => { setOption("plannerReplanEvery", 1); setOption("plannerLatePlan", "auto"); setOption("plannerPipeline", false); });

// 6. option round-trip through the moved input
await page.evaluate(() => setOption("plannerScreenK", 12));
check(await page.$eval("#plannerScreenKInput", el => (loadOption("plannerScreenK", options.plannerScreenK), el.value === "12")),
    "moved input syncs from loadOption");
await page.evaluate(() => setOption("plannerScreenK", 8));

// 7. internals: no worker yet -> hint text
await page.evaluate(() => AdvancedAutomation.refreshInternals());
check(await page.$eval("#autoInternalsStatus", el => /worker not running/i.test(el.textContent)),
    "internals explain when worker is down");

// 8. run a real plan round (suggest mode) and expect internals to populate
await page.evaluate(() => { setOption("plannerMode", "suggest"); AdvancedAutomation.planNow(); });
await page.waitForFunction(() => AdvancedAutomation._debug.getSuggestion() !== null, null, { timeout: 120000 });
await page.waitForTimeout(500);
check(await page.$eval("#autoIntLastPlanBody", el => /score/.test(el.textContent)), "last-plan section populated");
check(await page.$eval("#autoIntKnowledgeBody", el => el.querySelectorAll("tr").length > 3), "knowledge table populated");
check(await page.$eval("#autoIntThresholdsBody", el => el.textContent.length > 20), "thresholds populated");

// 8b. lootable-first control ON (default): the step-8 plan set every box
const togglerIds = await page.evaluate(() => {
    const ids = [];
    for (const t of townsUnlocked) for (const a of towns[t].totalActionList)
        if (a.type === "limited" && document.getElementById("searchToggler" + a.varName)) ids.push("searchToggler" + a.varName);
    return ids;
});
check(togglerIds.length > 0, `searchToggler boxes exist (${togglerIds.length})`);
check(await page.evaluate((ids) => ids.every(id => document.getElementById(id).checked), togglerIds),
    "control ON: planning set all Lootable-first boxes");

// 8c. control OFF: user's checkbox survives planning (states forwarded instead)
const prevReqId = await page.evaluate(() => AdvancedAutomation._debug.getSuggestion()?.reqId ?? 0);
await page.evaluate((id) => {
    setOption("plannerControlLootFirst", false);
    document.getElementById(id).checked = false;
    AdvancedAutomation.planNow();
}, togglerIds[0]);
await page.waitForFunction((prev) =>
    (AdvancedAutomation._debug.getSuggestion()?.reqId ?? 0) > prev, prevReqId, { timeout: 120000 });
check(await page.evaluate((id) => !document.getElementById(id).checked, togglerIds[0]),
    "control OFF: planning leaves the user's checkbox alone");
await page.evaluate(() => setOption("plannerControlLootFirst", true));

// 8d. §11.7 Design B live flow: enable auto + pipeline, START the game (it boots
//     paused), and let it run. Loops must advance with no permanent stall and no
//     planner error — the soft-lock regression guard for the pipeline state
//     machine. gameSpeed is cranked so loops complete fast.
await page.evaluate(() => {
    gameSpeed = 200;
    setOption("plannerScreenK", 4);
    actions.clearActions(); actions.addAction("Wander", 1); view.requestUpdate("updateNextActions");
    setOption("plannerReplanEvery", 1);
    setOption("plannerLatePlan", "auto");
    setOption("plannerMode", "auto");
    setOption("plannerPipeline", true);
    if (gameIsStopped) pauseGame();   // press play (boots paused)
});
const loopsLive0 = await page.evaluate(() => totals.loops);
await page.waitForFunction((l0) => totals.loops >= l0 + 5, loopsLive0, { timeout: 120000 });
const live = await page.evaluate(() => ({ loops: totals.loops,
    engaged: AdvancedAutomation.isEnabled(), err: AdvancedAutomation._debug.getLastError() }));
check(live.loops >= loopsLive0 + 5, `pipeline: loops advance under auto pipelining (no soft-lock) ${loopsLive0}->${live.loops}`);
check(live.engaged, "pipeline: planner stays engaged while pipelining");
check(!live.err, "pipeline: no planner error while pipelining", live.err ? String(live.err) : "");
// stop the game + reset for the rest of the smoke
await page.evaluate(() => {
    setOption("plannerMode", "off"); setOption("plannerPipeline", false);
    setOption("plannerReplanEvery", 1); setOption("plannerScreenK", 8);
    gameSpeed = 1; if (!gameIsStopped) pauseGame();
});

// 9. disable ONE master leaves the view (other still on); disabling BOTH falls back
await page.evaluate(() => setOption("advancedAutomation", false));
check(await page.$eval("#automationStatsWrap", el => getComputedStyle(el).display !== "none"),
    "radio stays visible with only basic master on");
check(await page.$eval("#autoViewSettings", el => getComputedStyle(el).display === "none"),
    "Advanced settings hidden when advanced master off");
check(await page.$eval("#statsWindow", el => el.dataset.view === "automation"), "view stays automation while basic still on");
await page.evaluate(() => setOption("basicAutomation", false));
check(await page.$eval("#automationStatsWrap", el => getComputedStyle(el).display === "none"),
    "radio hidden when both masters off");
check(await page.$eval("#statsWindow", el => el.dataset.view === "regular"), "both gates off falls back to regular view");

// 9b. re-enable both masters, restore the view; targeted-mode UI round-trips
await page.evaluate(() => { setOption("basicAutomation", true); setOption("advancedAutomation", true); });
await page.click("#automationStats");
const targetsJSON = JSON.stringify([{ kind: "a", action: "Continue On" }, { kind: "b", target: { type: "skill", name: "Magic" }, value: 50, budget: 0.3 }]);
await page.evaluate((tj) => { setOption("plannerStrategy", "targeted"); setOption("plannerTargets", tj); setOption("plannerAutoRankTargets", true); setOption("plannerAntiFixation", true); }, targetsJSON);
check(await page.$eval("#plannerAntiFixationInput", el => (loadOption("plannerAntiFixation", options.plannerAntiFixation), el.checked === true)),
    "anti-fixation checkbox syncs from loadOption");
check(await page.$eval("#plannerStrategyInput", el => (loadOption("plannerStrategy", options.plannerStrategy), el.value === "targeted")),
    "strategy select syncs from loadOption");
check(await page.$eval("#plannerAutoRankTargetsInput", el => (loadOption("plannerAutoRankTargets", options.plannerAutoRankTargets), el.checked === true)),
    "auto-rank checkbox syncs from loadOption");
// priority-list EDITOR renders one row per goal from the option, and greys out
// while auto-rank (set true just above) overrides the manual list.
const editorRows = await page.$eval("#plannerTargetsEditor",
    el => { loadOption("plannerTargets", options.plannerTargets); return el.querySelectorAll(".tg-row").length; });
check(editorRows === 2, `priority-list editor renders a row per goal (${editorRows})`);
check(await page.$eval("#plannerTargetsEditor", el => el.classList.contains("tg-locked")),
    "editor greys out when auto-rank is on");

// 9b-2. editor mutations round-trip to the plannerTargets option: add, edit a
//       value box, disable (park) a row, and reorder by priority.
await page.evaluate(() => { setOption("plannerAutoRankTargets", false); setOption("plannerTargets", "[]"); loadOption("plannerTargets", "[]"); });
await page.click('#plannerTargetsEditor [data-tg="add-a"]');
await page.click('#plannerTargetsEditor [data-tg="add-b"]');
let tg = await page.evaluate(() => JSON.parse(options.plannerTargets));
check(tg.length === 2 && tg[0].kind === "a" && tg[1].kind === "b", "add buttons append kind-a then kind-b goals");
await page.$eval('#plannerTargetsEditor .tg-row:nth-child(2) [data-tg="value"]',
    el => { el.value = "42"; el.dispatchEvent(new Event("change", { bubbles: true })); });
tg = await page.evaluate(() => JSON.parse(options.plannerTargets));
check(tg[1].value === 42, "editing the value box writes to the goal");
await page.$eval('#plannerTargetsEditor .tg-row:nth-child(1) [data-tg="en"]',
    el => { el.checked = false; el.dispatchEvent(new Event("change", { bubbles: true })); });
tg = await page.evaluate(() => JSON.parse(options.plannerTargets));
check(tg[0].enabled === false, "unchecking Enable parks the row (enabled:false), keeping it in the list");
await page.click('#plannerTargetsEditor .tg-row:nth-child(2) [data-tg="up"]');
tg = await page.evaluate(() => JSON.parse(options.plannerTargets));
check(tg[0].kind === "b" && tg[1].kind === "a", "raise-priority reorders the goals");
// "Only unlocked actions" toggles the kind-a dropdown between the unlocked set
// (default) and the full action list (more options, for pre-authoring goals).
const unlockedCount = await page.$eval('#plannerTargetsEditor .tg-action', el => el.options.length);
await page.evaluate(() => setOption("plannerTargetsUnlockedOnly", false));
const allCount = await page.$eval('#plannerTargetsEditor .tg-action', el => el.options.length);
check(allCount > unlockedCount, `unchecking 'Only unlocked' lists more actions (${unlockedCount} -> ${allCount})`);
await page.evaluate(() => setOption("plannerTargetsUnlockedOnly", true));
check(await page.$eval('#plannerTargetsEditor .tg-action', el => el.options.length) === unlockedCount,
    "re-checking 'Only unlocked' restores the restricted list");
// restore the targeted state block 10 expects to survive save()/reload
await page.evaluate((tj) => { setOption("plannerStrategy", "targeted"); setOption("plannerTargets", tj); setOption("plannerAutoRankTargets", true); setOption("plannerAntiFixation", true); }, targetsJSON);

// 9c. Buy Mana optimiser (§11.6 ladder), now in the Basic section (needs the
//     basicAutomation master, on from 9b): enable -> section visible -> optimise
//     a redundant-conversion queue on the worker -> proposal shown -> apply.
check(await page.$eval("#buyManaOptimizerSection", el => getComputedStyle(el).display === "none"),
    "Buy Mana section hidden while optimiser off");
await page.evaluate(() => setOption("economyOptimizer", true));
check(await page.$eval("#buyManaOptimizerSection", el => getComputedStyle(el).display !== "none"),
    "Buy Mana section visible while optimiser on");
// set a town-0 economy + a queue with two redundant Buy Manas
await page.evaluate(() => {
    towns[0].expWander = getExpOfLevel(30);
    for (const [v, n] of [["Pots", 100], ["Locks", 5]]) {
        towns[0][`total${v}`] = n; towns[0][`checked${v}`] = n; towns[0][`good${v}`] = n; towns[0][`goodTemp${v}`] = n;
    }
    adjustAll();
    actions.clearActions();
    for (const [n, l] of [["Buy Mana Z1", 1], ["Smash Pots", 100], ["Pick Locks", 5], ["Buy Mana Z1", 1], ["Buy Mana Z1", 1]])
        actions.addAction(n, l);
    view.requestUpdate("updateNextActions");
});
await page.evaluate(() => AdvancedAutomation.optimizeBuyMana());
await page.waitForFunction(() => AdvancedAutomation._debug.getOptimizeSuggestion() !== null, null, { timeout: 120000 });
await page.waitForTimeout(300);
check(await page.$eval("#buyManaOptimizerBody", el => /Proposal:/.test(el.textContent)), "Buy Mana proposal rendered");
// proposal is a collapsible <details> with TWO before/after/delta tables
check(await page.$eval("#buyManaOptimizerBody details.buyManaProposal", el => el.open === true).catch(() => false),
    "proposal is a collapsible <details>, default open");
check(await page.$$eval("#buyManaOptimizerBody .automation-table", els => els.length === 2),
    "proposal has two tables (waste metrics + per-action reps)");
check(await page.$eval("#buyManaOptimizerBody", el => /Before/.test(el.textContent) && /After/.test(el.textContent)),
    "tables have Before + After + delta columns");
check(await page.$$eval("#buyManaOptimizerBody .automation-table:last-of-type tbody tr", rows => rows.length === 3),
    "reps table has one row per action (3)");
check(await page.$eval("#buyManaOptimizerBody", el => !!el.querySelector("td.d-down")),
    "delta column is colour-coded (a decrease shows d-down)");
check(await page.evaluate(() => {
    const q = AdvancedAutomation._debug.getOptimizeSuggestion().queue;
    return q.filter(([n]) => n === "Buy Mana Z1").reduce((s, [, l]) => s + l, 0) === 1;
}), "proposal reduces 3 Buy Manas to 1");
await page.evaluate(() => AdvancedAutomation.applyOptimize());
check(await page.evaluate(() => actions.next.filter(a => a.name === "Buy Mana Z1").reduce((s, a) => s + a.loops, 0) === 1),
    "Apply (proposal present) installs the rebalanced queue (1 Buy Mana)");

// 9c-bis. Apply with NO prior Suggest auto-computes a proposal, then installs it.
await page.evaluate(() => { setOption("economyOptimizer", false); setOption("economyOptimizer", true); }); // clears the cached proposal
check(await page.evaluate(() => AdvancedAutomation._debug.getOptimizeSuggestion() === null),
    "no cached proposal after toggling the optimiser off/on");
await page.evaluate(() => {
    actions.clearActions();
    for (const [n, l] of [["Buy Mana Z1", 1], ["Smash Pots", 100], ["Pick Locks", 5], ["Buy Mana Z1", 1], ["Buy Mana Z1", 1]])
        actions.addAction(n, l);
    view.requestUpdate("updateNextActions");
});
await page.evaluate(() => AdvancedAutomation.applyOptimize());   // Apply directly, no Suggest
let autoApplied = false;
try {
    await page.waitForFunction(() => actions.next.filter(a => a.name === "Buy Mana Z1").reduce((s, a) => s + a.loops, 0) === 1,
        null, { timeout: 120000 });
    autoApplied = true;
} catch {}
check(autoApplied, "Apply with no proposal auto-computes then installs (3 Buy Manas -> 1)");
check(await page.$eval("#economyOptimizerAutoInput", el => (setOption("economyOptimizerAuto", true), loadOption("economyOptimizerAuto", options.economyOptimizerAuto), el.checked === true)),
    "auto-apply checkbox syncs from loadOption");
await page.evaluate(() => setOption("economyOptimizerAuto", false));

// 9c-ter. Suggest tops up reps first when auto-add is enabled (one evaluate so
//         the live loop can't reset the pool between setup and the top-up read).
const prevOptReq = await page.evaluate(() => AdvancedAutomation._debug.getOptimizeSuggestion()?.reqId ?? 0);
await page.evaluate(() => setOption("autoAddReps", true));
const topFirst = await page.evaluate(() => {
    towns[0].totalPots = 100; towns[0].checkedPots = 0; towns[0].goodPots = 0; towns[0].goodTempPots = 0;   // 100 available
    actions.clearActions();
    actions.addAction("Smash Pots", 50);        // under-queued (100 available)
    actions.addAction("Buy Mana Z1", 1);
    AdvancedAutomation.optimizeBuyMana();        // topUp is synchronous, before the async optimise
    return actions.next.find(a => a.name === "Smash Pots")?.loops;
});
check(topFirst === 100, "Suggest with auto-add on tops up reps first (Smash Pots 50 -> 100)");
await page.waitForFunction((p) => (AdvancedAutomation._debug.getOptimizeSuggestion()?.reqId ?? 0) > p, prevOptReq, { timeout: 120000 });
await page.evaluate(() => setOption("autoAddReps", false));

// 9d. Auto-add reps (§11.6 ladder rung 2), now in the Basic section (needs the
//     basicAutomation master, on from 9b): enable -> section visible -> top up
//     an under-queued action in place (pure UI-thread, no worker); the auto
//     toggle round-trips. Isolate from the optimiser chain (economyOptimizer off).
await page.evaluate(() => setOption("economyOptimizer", false));
check(await page.$eval("#autoAddRepsSection", el => getComputedStyle(el).display === "none"),
    "auto-add section hidden while option off");
await page.evaluate(() => setOption("autoAddReps", true));
check(await page.$eval("#autoAddRepsSection", el => getComputedStyle(el).display !== "none"),
    "auto-add section visible while option on");
// Set the pool (100 pots available: 100 unchecked), queue Smash Pots x50, and
// top up — all in ONE evaluate so the running game loop can't reset the pool
// between setup and the read. Available = good(0) + unchecked(100) = 100, so
// the +50 under-queue tops up to 100 in place.
const topUp = await page.evaluate(() => {
    towns[0].totalPots = 100; towns[0].checkedPots = 0; towns[0].goodPots = 0; towns[0].goodTempPots = 0;
    actions.clearActions();
    actions.addAction("Smash Pots", 50);
    actions.addAction("Wander", 3);
    AdvancedAutomation.applyRepTopUps();
    return {
        smash: actions.next.find(a => a.name === "Smash Pots")?.loops,
        wander: actions.next.find(a => a.name === "Wander")?.loops,
        status: document.getElementById("plannerStatus")?.textContent ?? "",
    };
});
check(topUp.smash === 100, "apply tops Smash Pots up to 100 reps in place");
check(topUp.wander === 3, "non-limited action left untouched by the top-up");
check(/top-ups.*added 50/.test(topUp.status), "top-up status reports the reps added");
check(await page.$eval("#autoAddRepsAutoInput", el => (setOption("autoAddRepsAuto", true), loadOption("autoAddRepsAuto", options.autoAddRepsAuto), el.checked === true)),
    "auto-apply-at-boundary checkbox syncs from loadOption");
await page.evaluate(() => setOption("autoAddRepsAuto", false));

// 9e. the ENABLE axis (in-section checkbox): disabling makes features inert but
//     leaves the section + radio visible (the whole point of the split). Also
//     the SHOW axis: hiding makes it inert too (shown && enabled required).
const enGate = await page.evaluate(() => {
    setOption("basicAutomationEnabled", false);   // shown stays on
    actions.clearActions();
    actions.addAction("Smash Pots", 50);          // 100 available from 9d's pool
    AdvancedAutomation.applyRepTopUps();
    return {
        loops: actions.next.find(a => a.name === "Smash Pots")?.loops,
        status: document.getElementById("plannerStatus")?.textContent ?? "",
        sectionShown: getComputedStyle(document.getElementById("autoViewBasicSettings")).display !== "none",
        radioShown: getComputedStyle(document.getElementById("automationStatsWrap")).display !== "none",
    };
});
check(enGate.loops === 50, "enable OFF: auto-add is inert (no top-up)");
check(/enable auto-add reps first/.test(enGate.status), "enable OFF: reports it is disabled");
check(enGate.sectionShown, "enable OFF: Basic section STAYS visible (not hidden)");
check(enGate.radioShown, "enable OFF: Automation radio STAYS visible");
// disabling the Enable flag does not touch the "Show" state (they're independent)
check(await page.evaluate(() => options.basicAutomation === true),
    "enable OFF: 'Show' state unchanged (tier still shown)");
await page.evaluate(() => setOption("basicAutomationEnabled", true));   // restore

// 10. persistence: settings survive save()/reload (incl. the targeted list).
//     Flip the two enable flags to non-default (false) to prove they round-trip.
await page.evaluate(() => { setOption("basicAutomation", true); setOption("advancedAutomation", true); setOption("basicAutomationEnabled", false); setOption("advancedAutomationEnabled", false); setOption("economyOptimizer", true); setOption("autoAddReps", true); setOption("autoAddRepsAuto", true); setOption("plannerWeightHeadroom", 2.5); setOption("plannerPipeline", true); setOption("plannerReplanEvery", 4); setOption("plannerLatePlan", "pause"); setOption("plannerTargetsUnlockedOnly", false); save(); });
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => typeof options !== "undefined", null, { timeout: 20000 });
await page.waitForTimeout(1000);
check(await page.evaluate(() => options.plannerWeightHeadroom === 2.5 && options.advancedAutomation === true),
    "options persist through reload");
check(await page.evaluate(() => options.basicAutomation === true),
    "basic automation shown master persists through reload");
check(await page.$eval("#basicAutomationInput", el => el.checked === true),
    "basic 'Show' checkbox restored on boot (Extras)");
check(await page.evaluate(() => options.basicAutomationEnabled === false && options.advancedAutomationEnabled === false),
    "enable flags (flipped to false) persist through reload");
check(await page.$eval("#basicAutomationEnabledInput", el => el.checked === false),
    "in-section 'Enable basic' checkbox restored on boot");
check(await page.$eval("#advancedAutomationEnabledInput", el => el.checked === false),
    "in-section 'Enable advanced' checkbox restored on boot");
check(await page.$eval("#autoViewBasicSettings", el => getComputedStyle(el).display !== "none"),
    "Basic automation section visible on boot with master on");
check(await page.evaluate(() => options.economyOptimizer === true),
    "Buy Mana optimiser option persists through reload");
check(await page.$eval("#economyOptimizerInput", el => el.checked === true),
    "Buy Mana optimiser checkbox restored on boot");
check(await page.evaluate(() => options.autoAddReps === true && options.autoAddRepsAuto === true),
    "auto-add reps options persist through reload");
check(await page.$eval("#autoAddRepsInput", el => el.checked === true), "auto-add reps checkbox restored on boot");
check(await page.$eval("#autoAddRepsAutoInput", el => el.checked === true), "auto-add auto checkbox restored on boot");
check(await page.$eval("#autoAddRepsSection", el => getComputedStyle(el).display !== "none"),
    "auto-add section visible on boot with option on");
check(await page.evaluate((tj) => options.plannerStrategy === "targeted" && options.plannerTargets === tj && options.plannerAutoRankTargets === true, targetsJSON),
    "targeted strategy + priority list + auto-rank persist through reload");
check(await page.$eval("#plannerWeightHeadroomInput", el => el.value === "2.5"), "moved weight input restored on boot");
check(await page.$eval("#plannerTargetsEditor", el => el.querySelectorAll(".tg-row").length === 2),
    "priority-list editor restored on boot (a row per persisted goal)");
check(await page.evaluate(() => options.plannerTargetsUnlockedOnly === false),
    "'Only unlocked actions' (flipped off) persists through reload");
check(await page.$eval("#plannerTargetsUnlockedOnlyInput", el => el.checked === false),
    "'Only unlocked actions' checkbox restored on boot");
check(await page.$eval("#automationStatsWrap", el => getComputedStyle(el).display !== "none"),
    "radio visible on boot with gate on");

// 10b. §11.7 pipeline options persist through reload (incl. the flipped
//      replanEvery / late-plan values, and the sub-section restored open).
check(await page.evaluate(() => options.plannerPipeline === true && options.plannerReplanEvery === 4 && options.plannerLatePlan === "pause"),
    "pipeline options persist through reload");
check(await page.$eval("#plannerPipelineInput", el => el.checked === true), "pipeline checkbox restored on boot");
check(await page.$eval("#plannerReplanEveryInput", el => el.value === "4"), "replanEvery input restored on boot");
check(await page.$eval("#plannerLatePlanInput", el => el.value === "pause"), "late-plan select restored on boot");
check(await page.$eval("#plannerPipelineSection", el => getComputedStyle(el).display !== "none"),
    "pipeline sub-section visible on boot with pipeline on");

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
