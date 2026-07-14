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

// 1. gate off: radio hidden
check(await page.$eval("#automationStatsWrap", el => getComputedStyle(el).display === "none"),
    "automation radio hidden while gate off");

// 2. enable the master gate (as the Extras checkbox would)
await page.evaluate(() => setOption("advancedAutomation", true));
await page.evaluate(() => AdvancedAutomation.refreshSectionVisibility());
check(await page.$eval("#automationStatsWrap", el => getComputedStyle(el).display !== "none"),
    "automation radio visible while gate on");

// 3. switch to the automation view
await page.click("#automationStats");
check(await page.$eval("#statsWindow", el => el.dataset.view === "automation"), "data-view flips to automation");
check(await page.$eval("#automationView", el => getComputedStyle(el).display !== "none"), "automation view shown");
check(await page.$eval("#statsContainer", el => getComputedStyle(el).display === "none"), "regular stat rows hidden");

// 4. compact stats table populated
await page.waitForTimeout(200);
const statRows = await page.$$eval("#autoStatsBody tr", rr => rr.length);
check(statRows >= 9, `compact stats rows (${statRows})`);

// 5. settings section holds the moved inputs; Extras hint replaced the block
for (const id of ["plannerModeInput", "plannerScreenKInput", "plannerWeightTravelReliefInput", "plannerWeightHeadroomInput",
                  // §11.10 targeted mode UI
                  "plannerStrategyInput", "plannerAutoRankTargetsInput", "plannerTargetsInput", "plannerAntiFixationInput"]) {
    check(await page.$eval(`#automationView #${id}`, () => true).catch(() => false), `${id} lives in the automation view`);
}
check(await page.$eval("#expGainMultiplierInput", el => !el.closest("#automationView")), "expGainMultiplier stays in Extras");

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

// 9. disable gate while automation view active -> falls back to regular
await page.evaluate(() => { setOption("advancedAutomation", false); AdvancedAutomation.refreshSectionVisibility(); });
check(await page.$eval("#statsWindow", el => el.dataset.view === "regular"), "gate off falls back to regular view");

// 9b. §11.10 targeted-mode UI round-trips through setOption + loadOption
await page.evaluate(() => { setOption("advancedAutomation", true); AdvancedAutomation.refreshSectionVisibility(); });
const targetsJSON = JSON.stringify([{ kind: "a", action: "Continue On" }, { kind: "b", target: { type: "skill", name: "Magic" }, value: 50, budget: 0.3 }]);
await page.evaluate((tj) => { setOption("plannerStrategy", "targeted"); setOption("plannerTargets", tj); setOption("plannerAutoRankTargets", true); setOption("plannerAntiFixation", true); }, targetsJSON);
check(await page.$eval("#plannerAntiFixationInput", el => (loadOption("plannerAntiFixation", options.plannerAntiFixation), el.checked === true)),
    "anti-fixation checkbox syncs from loadOption");
check(await page.$eval("#plannerStrategyInput", el => (loadOption("plannerStrategy", options.plannerStrategy), el.value === "targeted")),
    "strategy select syncs from loadOption");
check(await page.$eval("#plannerTargetsInput", (el, tj) => (loadOption("plannerTargets", options.plannerTargets), el.value === tj), targetsJSON),
    "priority-list textarea syncs from loadOption");
check(await page.$eval("#plannerAutoRankTargetsInput", el => (loadOption("plannerAutoRankTargets", options.plannerAutoRankTargets), el.checked === true)),
    "auto-rank checkbox syncs from loadOption");

// 9c. Buy Mana optimiser (§11.6 ladder): enable -> section visible -> optimise
//     a redundant-conversion queue on the worker -> proposal shown -> apply.
await page.evaluate(() => { setOption("advancedAutomation", true); AdvancedAutomation.refreshSectionVisibility(); });
await page.click("#automationStats");   // switch to automation view so renderOptimize fires
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
check(await page.$eval("#buyManaOptimizerBody", el => /proposed:/.test(el.textContent)), "Buy Mana proposal rendered");
check(await page.evaluate(() => {
    const q = AdvancedAutomation._debug.getOptimizeSuggestion().queue;
    return q.filter(([n]) => n === "Buy Mana Z1").reduce((s, [, l]) => s + l, 0) === 1;
}), "proposal reduces 3 Buy Manas to 1");
await page.evaluate(() => AdvancedAutomation.applyOptimize());
check(await page.evaluate(() => actions.next.filter(a => a.name === "Buy Mana Z1").reduce((s, a) => s + a.loops, 0) === 1),
    "apply installs the rebalanced queue (1 Buy Mana)");
check(await page.$eval("#economyOptimizerAutoInput", el => (setOption("economyOptimizerAuto", true), loadOption("economyOptimizerAuto", options.economyOptimizerAuto), el.checked === true)),
    "auto-apply checkbox syncs from loadOption");
await page.evaluate(() => setOption("economyOptimizerAuto", false));

// 9d. Auto-add reps (§11.6 ladder rung 2): enable -> section visible -> top up
//     an under-queued action in place (pure UI-thread, no worker); the auto
//     toggle round-trips. Controls live in the Extras menu, not the automation
//     view. Isolate from the optimiser chain here (economyOptimizer off).
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

// 10. persistence: settings survive save()/reload (incl. the targeted list)
await page.evaluate(() => { setOption("advancedAutomation", true); setOption("economyOptimizer", true); setOption("autoAddReps", true); setOption("autoAddRepsAuto", true); setOption("plannerWeightHeadroom", 2.5); save(); });
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => typeof options !== "undefined", null, { timeout: 20000 });
await page.waitForTimeout(1000);
check(await page.evaluate(() => options.plannerWeightHeadroom === 2.5 && options.advancedAutomation === true),
    "options persist through reload");
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
check(await page.$eval("#plannerTargetsInput", (el, tj) => el.value === tj, targetsJSON), "priority-list textarea restored on boot");
check(await page.$eval("#automationStatsWrap", el => getComputedStyle(el).display !== "none"),
    "radio visible on boot with gate on");

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
