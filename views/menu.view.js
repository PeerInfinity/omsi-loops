
const menuView = Views.registerView("menu", {
    selector: "#menu",
    html() {
        let html = "";
        html += Views.menu.htmlMenusMenu();
        html += Views.menu.htmlChangelog();
        html += Views.menu.htmlSaveMenu();
        html += Views.menu.htmlFAQMenu();
        html += Views.menu.htmlOptionsMenu();
        html += Views.menu.htmlExtrasMenu();
        html += Views.menu.htmlChallengeMenu();
        html += Views.menu.htmlTotalsMenu();
        html += Views.menu.htmlPrestigeMenu();
        html += Views.menu.htmlWarningMenu();
        return html;
    },
    htmlMenusMenu() {
        const menus = [
            "changelog",
            "save",
            "faq",
            "options",
            "extras",
            "challenges",
            "totals",
            "prestige_bonus",
        ];
        const disabledMenus = this.getDisabledMenus();
        const html =
        `<li id='menusMenu' tabindex='0' style='display:inline-block;height:30px;margin-right:10px;' class='showthatH${menus.map(menu => disabledMenus.includes(menu) ? ` disabled-${menu}` : "").join("")}'>
            <i class='fas fa-bars'></i>
            <div class='showthisH' id='menus'>
                <ul>
                    ${menus.map(menu => `
                    <li>
                        <input type='checkbox' id='enableMenu_${menu}' data-menu='${menu}' onchange='Views.menu.onEnableMenu(this)' ${disabledMenus.includes(menu) ? "" : "checked"}>
                        <label for='enableMenu_${menu}'>${_txt(`menu>${menu}>meta>title`)}</label>
                    </li>`).join("\n")}
                </ul>
            </div>
        </li>`;
        return html;

    },
    getDisabledMenus() {
        let disabledMenus = [];
        try {
            disabledMenus = JSON.parse(localStorage.getItem("disabledMenus")) ?? disabledMenus;
        } catch { }
        return disabledMenus;
    },
    /** @param {HTMLInputElement} input  */
    onEnableMenu(input) {
        const menu = input.dataset.menu;
        htmlElement("menusMenu").classList.toggle(`disabled-${menu}`, !input.checked);
        const disabledMenus = this.getDisabledMenus();
        const index = disabledMenus.indexOf(menu);
        if (index === -1 && !input.checked) {
            disabledMenus.push(menu);
        } else if (index >= 0 && input.checked) {
            disabledMenus.splice(index, 1);
        }
        localStorage.setItem("disabledMenus", JSON.stringify(disabledMenus));
    },
    versions() {
        let html = "";
        const versions = _txtsObj("menu>changelog>version");
        $(versions).each((_index, version) => {
            const caption = $(version).attr("caption");
            const verNum = $(version).attr("verNum");
            html += `
                    <li class='showthat2' tabindex='0' ${verNum ? `data-verNum="${verNum}"` : ""}>
                        ${caption ? caption : `${_txt("menu>changelog>meta>version_prefix")} ${verNum}`}
                        <div class='showthis2'>
                            ${$(version).text()}
                        </div>
                    </li>`;
        });
        return html;
    },
    htmlChangelog() {
        const html =
        `<li id='changelogMenu' tabindex='0' style='display:inline-block;height:30px;margin-left:10px;' class='showthatH'>
            ${_txt("menu>changelog>meta>title")}
            <ul class='showthisH' id='changelog'>
                ${this.versions()}
            </ul>
        </li>`;
        return html;
    },
    htmlSaveMenu() {
        const html =
        `<li id='saveMenu' tabindex='0' style='display:inline-block;height:30px;margin-left:10px;' class='showthatH'>
            ${_txt("menu>save>meta>title")}
            <div class='showthisH'>
                <button class='button' onclick='save()'>${_txt("menu>save>manual_save")}</button>
                <br>
                <textarea id='exportImportList'></textarea><label for='exportImportList'> ${_txt("menu>save>list_label")}</label>
                <br>
                <button class='button' style='margin-right: 2px;' onclick='exportCurrentList()'>${_txt("menu>save>export_button")}</button>
                <button class='button' onclick='importCurrentList()'>${_txt("menu>save>import_button")}</button>
                <br>
                ${_txt("menu>save>list_comment")}
                <br><br>
                <input id='exportImport'><label for='exportImport'> ${_txt("menu>save>input_label")}</label><br>
                <button class='button' style='margin-top: 5px; margin-right: 2px;' onclick='exportSave()'>${_txt("menu>save>export_button")}</button>
                <button class='button' style='margin-top: 1px;' onclick='importSave()'>${_txt("menu>save>import_button")}</button><br>
                ${_txt("menu>save>export_comment")}<br>
                ${_txt("menu>save>import_comment")}<br>
                <button class='button' style='margin-top: 5px; margin-right: 2px;' onclick='exportSaveFile()'>${_txt("menu>save>exportfile_button")}</button>
                <button class='button' style='margin-top: 1px;' onclick='openSaveFile()'>${_txt("menu>save>importfile_button")}</button>
                <input id="SaveFileInput" type='file' style="visibility:hidden;" onchange="importSaveFile(event)" />
                <br>
                <div id="cloud_save" class="block" style="display:none">
                    ${_txt("menu>save>cloud_label")}<br>
                    <button class='button' style='margin-top: 5px; margin-right: 2px;' onclick='googleCloud.exportSave()'>${_txt("menu>save>exportcloud_button")}</button>
                    <button class='button' style='margin-top: 1px;' onclick='googleCloud.loadSaves(true)'>${_txt("menu>save>importcloud_button")}</button>
                    <ul id='cloud_save_result'></ul>
                </div>
            </div>
        </li>`;
        return html;
    },
    FAQs() {
        let html = "";
        const QAs = _txtsObj("menu>faq>q_a");
        $(QAs).each((_index, QA) => {
            html += `
                <li class='showthat2' tabindex='0'>
                    ${$(QA).find("q").html()}
                    <div class='showthis2'>
                        ${$(QA).find("a").html()}
                    </div>
                </li>`;
        });
        return html;
    },
    htmlFAQMenu() {
        const html = 
        `<li id='faqMenu' tabindex='0' style='display:inline-block;height:30px;margin-left:10px;' class='showthatH'>
            ${_txt("menu>faq>meta>title")}
            <ul class='showthisH' id="faq">
                ${this.FAQs()}
            </ul>
        </li>`;
        return html;
    },
    htmlOptionsMenu() {
        const html =
            `<li id='optionsMenu' tabindex='0' style='display:inline-block;height:30px;margin-left:10px;' class='showthatH'>
            ${_txt("menu>options>meta>title")}
            <div class='showthisH'>
                <a target='_blank' href='${_txt("menu>options>discord>link")}'>${_txt("menu>options>discord>title")}</a><br>
                ${Views.menu.htmlThemeMenu()}
                ${Object.keys(Localization.supportedLang).length > 1 ? Views.menu.htmlLocalizationMenu() : ""}
                ${_txt("menu>options>adblock_warning")}<br>
                <input id='responsiveUIInput' type='checkbox' onchange='setOption("responsiveUI", this.checked)'/>
                    <label for='responsiveUIInput'>${_txt("menu>options>responsive_ui")}</label>
                <br>
                <input id='actionLogInput' type='checkbox' onchange='setOption("actionLog", this.checked)'/>
                    <label for='actionLogInput'>${_txt("menu>options>action_log")}</label>
                <br>
                <input id='googleCloudInput' type='checkbox' onchange='setOption("googleCloud", this.checked)'/>
                    <label for='googleCloudInput'>${_txt("menu>options>google_cloud")}</label>
                <br>
                <input id='highlightNewInput' type='checkbox' onchange='setOption("highlightNew", this.checked)'/>
                    <label for='highlightNewInput'>${_txt("menu>options>highlight_new")}</label>
                <br>
                <input id='statColorsInput' type='checkbox' onchange='setOption("statColors", this.checked)'/>
                    <label for='statColorsInput'>${_txt("menu>options>stat_colors")}</label>
                <br>
                <input id='statHintsInput' type='checkbox' onchange='setOption("statHints", this.checked)'/>
                    <label for='statHintsInput'>${_txt("menu>options>stat_hints")}</label>
                <br>
                <input id='pingOnPauseInput' type='checkbox' onchange='setOption("pingOnPause", this.checked)'/>
                    <label for='pingOnPauseInput'>${_txt("menu>options>pause_audio_cue")}</label>
                <br>
                <input id='notifyOnPauseInput' type='checkbox' onchange='setOption("notifyOnPause", this.checked)'/>
                    <label for='notifyOnPauseInput'>${_txt("menu>options>pause_notify_cue")}</label>
                <br>
                <input id='autoMaxTrainingInput' type='checkbox' onchange='setOption("autoMaxTraining", this.checked)'/>
                    <label for='autoMaxTrainingInput'>${_txt("menu>options>auto_max_training")}</label>
                <br>
                <input id='hotkeysInput' type='checkbox' onchange='setOption("hotkeys", this.checked)'/>
                    <label class='showthat' for='hotkeysInput'>${_txt("menu>options>hotkeys")}
                    <div class='showthis'>${_txt("menu>options>hotkeys_tooltip")}</div>
                </label>
                <br>
                ${_txt("menu>options>update_rate")}
                <input id='updateRateInput' type='number' value='50' min='1' style='width: 50px;transform: translateY(-2px);' oninput='setOption("updateRate", parseInt(this.value))' />
                <br>
                ${_txt("menu>options>autosave_rate")}
                <input id='autosaveRateInput' type='number' value='30' min='1' style='width: 50px;transform: translateY(-2px);' oninput='setOption("autosaveRate", parseInt(this.value))' />
                <br>
            </div>
        </li>`;
        return html;
    },
    htmlLocalizationMenu() {
        const lg = Localization.supportedLang;
        let html = `${_txt("menu>options>localization_title")}: <select id='localization_menu' onchange='Localization.change();'>`;
        $.each(lg, (val, str) => {
            html += `<option value='${val}'${Localization.currentLang === val ? "selected" : ""}>${str}</option>`;
        });
        html += "</select><br>";
        return html;
    },
    htmlThemeMenu() {
        const themeList = ["normal", "dark", "cubic", "cubic t-dark", "zen", "zen t-dark"];
        const themes = _txtsObj("menu>options>theme");
        let html = `${_txt("menu>options>theme_title")}: <select id='themeInput' onchange='view.changeTheme();'>`;
        $(themes).each((index, theme) => {
            html += `<option value='${themeList[index]}'>${$(theme).find(themeList[index].replaceAll(" ","_")).text()}</option>`;
        });
        html += "</select><br>";
        html += `<div class='block' id='themeVariantSection'>${_txt("menu>options>theme_variant_title")}: <select id='themeVariantInput' onchange='view.changeTheme();'>`;
        $(themes).each((index, theme) => {
            $(theme).find("variants>*").each((vindex, variant) => {
                html += `<option class='variant-${themeList[index].replaceAll(" ","_")}' value='${variant.tagName}'>${$(variant).text()}</option>`;
            });
        });
        html += "</select></div>"
        return html;
    },
    htmlExtrasMenu() {
        const html =
            `<li id='extrasMenu' tabindex='0' style='display:inline-block;height:30px;margin-left:10px;' class='showthatH'>
            ${_txt("menu>extras>meta>title")}
            <div class='showthisH' style='padding-top:1ex'>
                ${_txt("menu>options>extras_warning")}<br>
                <br>
                <input id='fractionalManaInput' type='checkbox' onchange='setOption("fractionalMana", this.checked)'/>
                    <label for='fractionalManaInput'>${_txt("menu>options>fractional_mana")}</label>
                <br>
                <input id='predictorInput' type='checkbox' onchange='setOption("predictor", this.checked)'/>
                    <label for='predictorInput'>${_txt("menu>options>predictor")}</label>
                <br>
                <div class='control'>
                    <input type='checkbox' id='speedIncrease10xInput' onchange='setOption("speedIncrease10x", this.checked)'>
                    <label for='speedIncrease10xInput'>${_txt("menu>options>speedIncrease10x_text")}</label>
                </div>
                <br>
                <div class='control'>
                    <input type='checkbox' id='speedIncrease20xInput' onchange='setOption("speedIncrease20x", this.checked)'>
                    <label for='speedIncrease20xInput'>${_txt("menu>options>speedIncrease20x_text")}</label>
                </div>
                <br>
                ${_txt("menu>options>speedIncreaseCustom_text")}
                <input id='speedIncreaseCustomInput' type='number' value='5' min='1' style='width: 50px;transform: translateY(-2px);' oninput='setOption("speedIncreaseCustom", parseInt(this.value))' />
                <br>
                ${_txt("menu>options>speedIncreaseBackground_text")}
                <input id='speedIncreaseBackgroundInput' type='number' value='' placeholder='same' min='0' style='width: 50px;transform: translateY(-2px);' oninput='setOption("speedIncreaseBackground", parseFloat(this.value))' />
                <div id='speedIncreaseBackgroundWarning' class='small block' style='display:none'>${_txt("menu>options>speedIncreaseBackground_warning")}</div>
                <br>
                <button id='borrowTimeButton' class='button showthat control' onclick='borrowTime()'>${_txt("menu>options>borrow_time")}
                    <div class='showthis'>${_txt("menu>options>borrow_time_tooltip")}</div>
                </button>
                <div class='show-when-time-borrowed'>
                    <button id='returnTimeButton' class='button control' onclick='returnTime()'>${_txt("menu>options>return_time")}</button>
                    ${_txt("menu>options>time_borrowed")} <span id='borrowedTimeDays'></span>
                </div><br>
                <div id='predictorSettings'>
                    <br>
                    <b>${_txt("predictor>settings")}</b>
                    <br>
                    <input id='predictorBackgroundThreadInput' type='checkbox' onchange='setOption("predictorBackgroundThread", this.checked)'>
                    <label for='predictorBackgroundThreadInput'>${_txt("predictor>background_thread")}</label>
                    <br>
                    <label for='predictorTimePrecisionInput'>${_txt("predictor>time_precision")}</label>
                    <input id='predictorTimePrecisionInput' type='number' value='1' min='1' max='10' style='width: 50px;' oninput='setOption("predictorTimePrecision", parseInt(this.value))'>
                    <br>
                    <label for='predictorNextPrecisionInput'>${_txt("predictor>next_precision")}</label>
                    <input id='predictorNextPrecisionInput' type='number' value='2' min='1' max='10' style='width: 50px;' oninput='setOption("predictorNextPrecision", parseInt(this.value))'>
                    <br>
                    <label for='predictorActionWidthInput'>${_txt("predictor>action_list_width")}</label>
                    <input id='predictorActionWidthInput' type='number' value='500' min='100' max='4000' style='width: 50px; margin-left:40px' oninput='setOption("predictorActionWidth", parseInt(this.value))'>
                    <br>
                    <input id='predictorRepeatPredictionInput' type='checkbox' onchange='setOption("predictorRepeatPrediction", this.checked)'>
                    <label for='predictorRepeatPredictionInput'>${_txt("predictor>repeat_last_action")}</label>
                    <br>
                    <input id='predictorSlowModeInput' type='checkbox' onchange='setOption("predictorSlowMode", this.checked)'>
                    <label for='predictorSlowModeInput'>${
                        _txt("predictor>slow_mode")
                        .replace("{slowMode}",
                            `<input id='predictorSlowTimerInput' type='number' value='1' min='1' style='width: 20px;' oninput='setOption("predictorSlowTimer", parseInt(this.value))'>`
                        )
                    }</label>
                </div>
                <div id='advancedAutomationSection'>
                    <br>
                    <b>Advanced Automation (fork)</b>
                    <br>
                    <input id='advancedAutomationInput' type='checkbox' onchange='setOption("advancedAutomation", this.checked)'>
                    <label class='showthat' for='advancedAutomationInput'>Enable Advanced Automation
                        <div class='showthis'>Fork addition: a generic queue planner that learns the game by probing and
                        measurement in a background worker, then builds the action queue for you. All sub-features stay
                        inert until a mode is selected below. Manual queue editing always wins.</div>
                    </label>
                    <div id='advancedAutomationSettings' style='display:none'>
                        Planner mode:
                        <select id='plannerModeInput' onchange='setOption("plannerMode", this.value)'>
                            <option value='off'>Off</option>
                            <option value='suggest'>Suggest (show plans, never install)</option>
                            <option value='auto'>Auto (planner owns the queue)</option>
                        </select>
                        <br>
                        <input id='plannerPauseWhilePlanningInput' type='checkbox' onchange='setOption("plannerPauseWhilePlanning", this.checked)'>
                        <label class='showthat' for='plannerPauseWhilePlanningInput'>Pause while planning (Auto)
                            <div class='showthis'>Pause at each loop boundary until the plan for the next loop arrives, so the
                            planner plays exactly the loop it planned. Off = plans install one loop behind.</div>
                        </label>
                        <br>
                        <input id='plannerSeedFromPredictorInput' type='checkbox' onchange='setOption("plannerSeedFromPredictor", this.checked)'>
                        <label class='showthat' for='plannerSeedFromPredictorInput'>Cross-check with predictor model
                            <div class='showthis'>Also run the Koviko predictor's effect model on each measured action and record
                            predictor-vs-engine divergences (a correctness canary; engine measurement stays authoritative).</div>
                        </label>
                        <br>
                        <input id='plannerMultiTownInput' type='checkbox' checked onchange='setOption("plannerMultiTown", this.checked)'>
                        <label class='showthat' for='plannerMultiTownInput'>Multi-town planning
                            <div class='showthis'>Plan past town 1: measure out-of-town actions through travel-prefixed probes and
                            generate expedition / multi-hop travel candidates. Off = the original town-0-only planner (A/B
                            comparisons). Note: later towns' reward paths can roll dice; the live game cannot roll those back,
                            so plans touching them are advisory rather than exactly replayed.</div>
                        </label>
                        <br>
                        Candidates kept after predictor screen:
                        <input id='plannerScreenKInput' type='number' value='8' min='1' max='20' style='width: 40px;' oninput='setOption("plannerScreenK", parseInt(this.value))'>
                        <br>
                        Re-probe unlock thresholds every N loops:
                        <input id='plannerProbeEveryInput' type='number' value='1' min='1' max='50' style='width: 40px;' oninput='setOption("plannerProbeEvery", parseInt(this.value))'>
                        <br>
                        <b>Objective weights</b> (what the planner values each loop):
                        <br>
                        Town unlock <input id='plannerWeightTownInput' type='number' value='1000000000000' style='width: 100px;' oninput='setOption("plannerWeightTown", parseFloat(this.value))'>
                        Action unlock <input id='plannerWeightUnlockActionInput' type='number' value='1000' style='width: 60px;' oninput='setOption("plannerWeightUnlockAction", parseFloat(this.value))'>
                        Action visible <input id='plannerWeightVisibleActionInput' type='number' value='300' style='width: 60px;' oninput='setOption("plannerWeightVisibleAction", parseFloat(this.value))'>
                        <br>
                        Frontier progress <input id='plannerWeightFrontierInput' type='number' value='4000' style='width: 60px;' oninput='setOption("plannerWeightFrontier", parseFloat(this.value))'>
                        Mana growth <input id='plannerWeightManaInput' type='number' value='800' style='width: 60px;' oninput='setOption("plannerWeightMana", parseFloat(this.value))'>
                        <br>
                        Banked items <input id='plannerWeightBankInput' type='number' value='30' style='width: 60px;' oninput='setOption("plannerWeightBank", parseFloat(this.value))'>
                        Pool discovery <input id='plannerWeightBankPotInput' type='number' value='15' style='width: 60px;' oninput='setOption("plannerWeightBankPot", parseFloat(this.value))'>
                        Talent <input id='plannerWeightTalentInput' type='number' value='0.01' step='0.01' style='width: 60px;' oninput='setOption("plannerWeightTalent", parseFloat(this.value))'>
                        <br>
                        Travel relief <input id='plannerWeightTravelReliefInput' type='number' value='3' style='width: 60px;' oninput='setOption("plannerWeightTravelRelief", parseFloat(this.value))'>
                        Headroom <input id='plannerWeightHeadroomInput' type='number' value='1' style='width: 60px;' oninput='setOption("plannerWeightHeadroom", parseFloat(this.value))'>
                        <br>
                        <button class='button control' onclick='AdvancedAutomation.planNow()'>Plan Now</button>
                        <button class='button control' onclick='AdvancedAutomation.applySuggestion()'>Apply Suggestion</button>
                        <button class='button control' onclick='AdvancedAutomation.showDivergences()'>Divergences</button>
                        <br>
                        Status: <span id='plannerStatus'>idle</span>
                    </div>
                </div>
                <div id='forkTestingSection'>
                    <br>
                    <b>Testing (fork)</b>
                    <br>
                    <label class='showthat' for='expGainMultiplierInput'>Experience gain multiplier
                        <div class='showthis'>Fork testing aid: multiplies experience/progress gains — town progress exp,
                        skill exp, stat exp and talent — so threshold grinds compress in test runs. Resources (gold, mana,
                        reputation, items) and multipart/dungeon progress are deliberately NOT multiplied; the game's
                        economy stays real. 1 = exactly vanilla behavior.</div>
                    </label>
                    <input id='expGainMultiplierInput' type='number' value='1' min='0.1' step='1' style='width: 60px;' oninput='setOption("expGainMultiplier", parseFloat(this.value) || 1)'>
                </div>
            </div>
        </li>`;
        return html;
    },
    htmlChallengeMenu() {
        const html = 
        `<li id='challengesMenu' tabindex='0' style='display:inline-block;height:30px;margin-left:10px;' class='showthatH'>
            ${_txt("menu>challenges>meta>title")}
            <div class='showthisH'>
                ${this.challenges()}
            </div>
        </li>`;
        return html;
    },
    htmlTotalsMenu() {
        const html = 
        `<li id='totalsMenu' tabindex='0' style='display:inline-block;height:30px;margin-left:10px;' class='showthatH'>
            ${_txt("menu>totals>meta>title")}
            <div class='showthisH'>
                ${this.totals()}
            </div>
        </li>`;
        return html;
    },
    htmlPrestigeMenu() {
        const html = 
        `<li id='prestige_bonusesMenu' tabindex='0' style='display:inline-block;height:30px;margin-left:10px;' class='showthatH'>
            ${_txt("menu>prestige_bonus>meta>title")}
            <div class='showthisH'>
                ${this.prestige_bonuses()}
            </div>
        </li>`;
        return html;
    },
    htmlWarningMenu() {
        const html = 
        `<li id='browser_warningMenu' tabindex='0' style='display:inline-block;height:30px;margin-left:10px;' class='showthatH alert'>
            CRITICAL ALERT
            <div class='showthisH'>
                <p>
                There is currently a bug in the latest versions of Chrome (and browsers based on it, like Edge; your browser counts)
                which can cause the game to fail unexpectedly. There is nothing we can do about this other than hope Google fixes what
                they broke; if you have issues, export your save and import it into another browser like Firefox. If your game is working
                and you have not updated this browser recently, do not update it right now or your game may break!
                </p><p>
                If you would like to help Google realize what they have accidentally broken, you can report that you are affected by
                clicking the +1 button on <a href="https://issues.chromium.org/issues/401652934">the issue page</a>.
                </p>
            </div>
        </li>`;
        return navigator.vendor === 'Google Inc.' ? html : "";
    },
    challenges() {
        let html = 
        `<div>Challenges are special modes that impose special conditions and heavy restrictions.<br> 
            They give no rewards ard are just here for fun.<br>
            It is only recommended to try them after beating the main game.<br>
            Please export and save your data locally before starting.<br>
            <b>Beginning a challenge will permanently delete your current save.</b><br>
            `;
        if (challengeSave.challengeMode !== 0 || 1===1)
            html += `<button class='button showthat control' style='margin-top: 2px;' onclick='exitChallenge()'>Exit Challenge 
                </button>
                <button class='button showthat control' style='margin-top: 2px;' onclick='resumeChallenge()'>Resume Challenge 
                </button><br>`;
        html += 
        `<button class='button showthat control' style='margin-top: 2px;' onclick='beginChallenge(1)'>Mana Drought 
            <div class='showthis' style='color:var(--default-color);width:230px;margin-left:100px;'>${_txt("menu>challenges>mana_drought")}</div>
        </button><br>
        <button class='button showthat control' style='margin-top: 2px;' onclick='beginChallenge(2)'>Noodle Arms
            <div class='showthis' style='color:var(--default-color);width:230px;margin-left:100px;'>${_txt("menu>challenges>noodle_arms")}</div>
        </button><br>
        <button class='button showthat control' style='margin-top: 2px;' onclick='beginChallenge(3)'>Mana Burn
            <div class='showthis' style='color:var(--default-color);width:230px;margin-left:100px;'>${_txt("menu>challenges>mana_burn")}</div>
        </button><br>`
        html += `</div>`
        return html;
    },
    totals() {
        let html =
        `<div>
        Effective Time: <div id='totalEffectiveTime'></div><br>
        Running Time: <div id='totalPlaytime'></div><br>
        <span class='show-when-time-borrowed'>${_txt("menu>options>time_borrowed")} <div id='borrowedTimeBalance'></div><br></span>
        Loops: <div id='totalLoops'></div><br>
        Actions: <div id='totalActions'></div><br>
        </div>`;
        return html;
    },
    prestige_bonuses() {
        let html =
        `<div><br> 
        Prestige bonuses are always active.<br>
        Each time you complete the game, you receive 90 points to spend on these bonuses.<br>
        Please export and save your data locally before attempting to trigger a prestige.<br>
        <br>
        <b>The ability to spec into prestige bonuses may be done at any time, but keep in mind this will reset ALL progress.</b>
        <br><br>
        Imbue Soul levels will carry over between prestiges, up to the maximum number of prestiges you've completed. <br>
        Max carryover possible: <div id='maxTotalImbueSoulLevels'></div>
        <br>
        <br><br><br>
        <b>Total Prestiges Completed: <div id='currentPrestigesCompleted'></div></b><br>
        Available points: <div id='currentPrestigePoints'></div> / <div id='totalPrestigePoints'></div>
        <br>
        Upgrade cost follows the format of: 
        <br>
        30 -> 40 -> 55 -> 75 -> 100 -> 130 -> ...
        <br>

        `;
        html +=
        
        `
        <br>
        <button class='button showthat control' style='margin-top: -50px;' onclick='prestigeUpgrade("PrestigePhysical")'>Prestige Physical
            <div class='showthis' style='color:var(--default-color);width:230px;margin-left:200px;'>${_txt("menu>prestige_bonus>PrestigePhysical")}
                <br><br>
                Current Bonus: <div id='prestigePhysicalCurrentBonus'></div>%<br>
                Next level cost: <div id='prestigePhysicalNextCost'></div> points<br> 
            </div>
        </button><br>

        <button class='button showthat control' style='margin-top: -50px;' onclick='prestigeUpgrade("PrestigeMental")'>Prestige Mental
        <div class='showthis' style='color:var(--default-color);width:230px;margin-left:200px;'>${_txt("menu>prestige_bonus>PrestigeMental")}
            <br><br>
            Current Bonus: <div id='prestigeMentalCurrentBonus'></div>%<br>
            Next level cost: <div id='prestigeMentalNextCost'></div> points<br> 
        </div>
        </button><br>


        <button class='button showthat control' style='margin-top: -50px;' onclick='prestigeUpgrade("PrestigeCombat")'>Prestige Combat
            <div class='showthis' style='color:var(--default-color);width:230px;margin-left:200px;'>${_txt("menu>prestige_bonus>PrestigeCombat")}
                <br><br>
                Current Bonus: <div id='prestigeCombatCurrentBonus'></div>%<br>
                Next level cost: <div id='prestigeCombatNextCost'></div> points<br> 
            </div>
        </button><br>

        <button class='button showthat control' style='margin-top: -50px;' onclick='prestigeUpgrade("PrestigeSpatiomancy")'>Prestige Spatiomancy
            <div class='showthis' style='color:var(--default-color);width:230px;margin-left:200px;'>${_txt("menu>prestige_bonus>PrestigeSpatiomancy")}
                <br><br>
                Current Bonus: <div id='prestigeSpatiomancyCurrentBonus'></div>%<br>
                Next level cost: <div id='prestigeSpatiomancyNextCost'></div> points<br> 
            </div>
        </button><br>

        <button class='button showthat control' style='margin-top: -50px;' onclick='prestigeUpgrade("PrestigeChronomancy")'>Prestige Chronomancy
            <div class='showthis' style='color:var(--default-color);width:230px;margin-left:200px;'>${_txt("menu>prestige_bonus>PrestigeChronomancy")}
                <br><br>
                Current Bonus: <div id='prestigeChronomancyCurrentBonus'></div>%<br>
                Next level cost: <div id='prestigeChronomancyNextCost'></div> points<br> 
            </div>
        </button><br>

        <button class='button showthat control' style='margin-top: -50px;' onclick='prestigeUpgrade("PrestigeBartering")'>Prestige Bartering
            <div class='showthis' style='color:var(--default-color);width:230px;margin-left:200px;'>${_txt("menu>prestige_bonus>PrestigeBartering")}
                <br><br>
                Current Bonus: <div id='prestigeBarteringCurrentBonus'></div>%<br>
                Next level cost: <div id='prestigeBarteringNextCost'></div> points<br> 
            </div>
        </button><br>

        <button class='button showthat control' style='margin-top: -50px;' onclick='prestigeUpgrade("PrestigeExpOverflow")'>Prestige Experience Overflow
            <div class='showthis' style='color:var(--default-color);width:230px;margin-left:200px;'>${_txt("menu>prestige_bonus>PrestigeExpOverflow")}
                <br><br>
                Current Bonus: <div id='prestigeExpOverflowCurrentBonus'></div>%<br>
                Next level cost: <div id='prestigeExpOverflowNextCost'></div> points<br> 
            </div>
        </button><br>

        <br><br>

        <button class='button showthat control' style='margin-top: -50px;' onclick='resetAllPrestiges()'>Reset All Prestiges
            <div class='showthis' style='color:var(--default-color);width:230px;margin-left:200px;'>${_txt("menu>prestige_bonus>PrestigeResetAll")}
            </div>
        </button><br>

        `

        ;
        return html;
    }
});
