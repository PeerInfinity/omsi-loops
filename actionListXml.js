// @ts-check
"use strict";

// actionListXml — compiles data/actionList.xml into Action-shaped field
// closures (fork addition; XML migration Phase 4).
//
// This is the interpreter for the declarative action format started upstream
// (cirne's data/actionList.xml + data/schema/actionList.rng). It compiles
// each <action> definition into the same field closures a hand-written
// `Action` carries: manaCost, goldCost, visible, unlocked, canStart, allowed,
// storyReqs, plus the data fields (stats, affectedBy, expMult, townNum...).
//
// Ground rules, enforced by test/xml-differential.test.mjs:
//   - actionList.js is the ORACLE. Every compiled field must return `===`
//     the hand-written implementation across the full Phase-3 state corpus
//     (test/field-matrix.lib.mjs). Any divergence is a bug here or in the
//     XML data, never a tolerance.
//   - Migration is incremental: an action absent from the XML simply keeps
//     its JS definition. Every commit stays shippable.
//   - finish()/story() side-effect vocabulary (<reward>/<cost>/<progress>)
//     is Phase 6: effect slots compile per (action, slot) from the XML when
//     the data is there, and keep their JS bodies when it is not. The effect
//     differential (test/effect-differential.test.mjs) is the oracle gate:
//     JS body and compiled body must leave IDENTICAL state.
//
// Evaluation model (mirrors §1.1 of the migration plan):
//   numericEvaluation = base value (attribute, text, or a baseValue element)
//     + an ordered rule list applied in document order.
//   A conditional rule inside a rule list is a GUARD: when its test fails,
//   the evaluation is void — a void inner evaluation makes the containing
//   adjustment a no-op (this is how <multiplier value="4"><ifResource
//   resourceName="glasses"/></multiplier> expresses `glasses ? 4 : 1`).
//   Adjustment elements carrying their own conditionalEvaluation children
//   (skillBonus, ceil, ...) apply only when all their guards pass.
//   <additiveBonus> applies each child adjustment to the value as it stood
//   on entry and sums the deltas — `base*modA + base*bonusB` composes as
//   additiveBonus(skillMod A, surveyBonus B).
//   Boolean properties (visible/unlocked/canStart/storyReqs stories) are a
//   conditional list: AND of all rules, true when empty.

const ActionListXml = (() => {
    /** @typedef {import("./xmlLite.js").XmlNode} XmlNode */

    // the six effect slots Phase 6 compiles (§10-Q6); each is compiled from
    // its own XML element, per action, or left to JS
    const SLOTS = ["finish", "loopsFinished", "segmentFinished", "floorReward", "cost", "story"];
    const BASE_VALUE_TAGS = new Set(["skillLevel", "skillExp", "buffLevel", "talentLevel", "primaryValue",
        "progressLevel", "goodItems", "discoveredItems", "checkedItems", "value", "function",
        "resourceValue", "townValue", "globalValue", "stonesUsed", "storyVar",
        "segment", "loopCounter", "totalCompletions", "segments", "power", "fibonacci",
        "dungeonCompleted", "dungeonFloors", "trialCompleted", "trialFloors", "buffCap", "guildSegment",
        "currentFloor", "completed", "goodTempItems"]);
    const CONDITIONAL_TAGS = new Set(["if", "ifCurrentValue", "ifResource", "ifHasResource",
        "ifStoryFlag", "ifProgress", "ifGoodItems", "ifDiscoveredItems", "ifCheckedItems",
        "ifPrestige", "ifTownUnlocked", "anyOf", "never", "ifGuild", "ifGlobalFlag", "ifSoulstoneSac",
        "ifGuildRankName"]);
    // whitelisted <ifGuildRankName which="..."/> targets. These return the
    // DECORATED rank name ("A+, Mult x1.4"), which is what the JS bodies
    // compare against — quirk included, since JS is the oracle.
    const GUILD_RANK_NAMES = {
        craftGuild: () => getCraftGuildRank().name,
        wizCollege: () => getWizCollegeRank().name,
    };
    // whitelisted <function name="..."/> targets (mirrors schema.js / the rng);
    // the *Bonus wrappers exist because <function> must return a number
    const FUNCTIONS = {
        getExploreProgress: () => getExploreProgress(),
        fullyExploredZones: () => fullyExploredZones(),
        totalAssassinations: () => totalAssassinations(),
        getWizCollegeRankBonus: () => getWizCollegeRank().bonus,
        getCraftGuildRankBonus: () => getCraftGuildRank().bonus,
        getThievesGuildRankBonus: () => getThievesGuildRank().bonus,
        getFrostGiantsRankBonus: () => getFrostGiantsRank().bonus,
        getFightJungleMonstersRankBonus: () => getFightJungleMonstersRank().bonus,
        getSelfCombat: () => getSelfCombat(),
        getTeamCombat: () => getTeamCombat(),
        getZombieStrength: () => getZombieStrength(),
        getExploreSkill: () => getExploreSkill(),
        // fork wrapper: Imbue Body gates every talent >= a threshold
        minTalent: () => Math.min(...statList.map(s => getTalent(s))),
    };
    // <guildSegmentIncrement name="..."/>: the loop-temp counter bumps. The
    // stateChanged emission belongs to the primitive, never to the XML — and
    // it mirrors actionList.js site-for-site, which is why only wizCollege
    // emits (upstream's other nine increments are silent).
    const GUILD_SEGMENT_INCREMENTS = {
        advGuild: () => { curAdvGuildSegment++; },
        craftGuild: () => { curCraftGuildSegment++; },
        thievesGuild: () => { curThievesGuildSegment++; },
        wizCollege: () => { curWizCollegeSegment++; stateChanged("guildSegment", { name: "WizCollege" }); },
        frostGiants: () => { curFightFrostGiantsSegment++; },
        jungleMonsters: () => { curFightJungleMonstersSegment++; },
        gods: () => { curGodsSegment++; },
    };
    // whitelisted <guildSegment name="..."/> -> cur*Segment loop-temp globals
    const GUILD_SEGMENTS = {
        advGuild: () => curAdvGuildSegment,
        craftGuild: () => curCraftGuildSegment,
        thievesGuild: () => curThievesGuildSegment,
        wizCollege: () => curWizCollegeSegment,
        frostGiants: () => curFightFrostGiantsSegment,
        jungleMonsters: () => curFightJungleMonstersSegment,
        gods: () => curGodsSegment,
    };
    // whitelisted <globalValue name="..."/> targets
    const GLOBALS = {
        trainingLimits: () => trainingLimits,
        goldInvested: () => goldInvested,
        storyMax: () => storyMax,
        effectiveTime: () => effectiveTime,
    };
    // whitelisted <ifGlobalFlag name="..."/> targets (boolean loop-temp globals)
    const GLOBAL_FLAGS = {
        portalUsed: () => portalUsed,
    };

    /** @param {string} xmlText */
    function parseDocument(xmlText) {
        const root = XmlLite.parse(xmlText);
        if (root.tag !== "actions") throw new Error(`actionListXml: expected <actions>, got <${root.tag}>`);
        /** @type {Record<string, XmlNode[]>} */
        const adjustments = {};
        /** @type {Record<string, XmlNode>} */
        const actions = {};
        for (const child of root.children) {
            if (child.tag === "defs") {
                for (const d of child.children) {
                    if (d.tag === "defineAdjustment") adjustments[d.attrs.name] = d.children;
                }
            } else if (child.tag === "action") {
                if (!child.attrs.name) throw new Error("actionListXml: <action> without name");
                actions[child.attrs.name] = child;
            }
            // <xi:include>/<refs> are IDE affordances; ignored by the game
        }
        return { adjustments, actions };
    }

    const num = (s, what) => {
        const n = Number(s);
        if (!Number.isFinite(n)) throw new Error(`actionListXml: bad number "${s}" in ${what}`);
        return n;
    };

    const child = (node, tag) => node.children.find(c => c.tag === tag);
    const childs = (node, tag) => node.children.filter(c => c.tag === tag);

    // ---- evaluation ------------------------------------------------------
    // ctx: { doc, action: {varName, townNum}, current: number|undefined }
    // A void (guard-failed) evaluation returns null.

    /** town that owns a varName (getLevel & the item ledgers are per-town) */
    const townFor = (varName) => {
        for (const t of towns) if (t.allVarNames.includes(varName)) return t;
        throw new Error(`actionListXml: no town owns varName ${varName}`);
    };

    const ownVar = (node, ctx) => node.attrs.varName ?? ctx.action.varName;

    const TEST_ATTRS = ["min", "minExclusive", "max", "maxExclusive", "equals", "notEquals"];
    const hasTests = (node) => TEST_ATTRS.some(k => k in node.attrs);

    function testNumeric(node, value) {
        const a = node.attrs;
        if ("min" in a && !(value >= num(a.min, node.tag))) return false;
        if ("minExclusive" in a && !(value > num(a.minExclusive, node.tag))) return false;
        if ("max" in a && !(value <= num(a.max, node.tag))) return false;
        if ("maxExclusive" in a && !(value < num(a.maxExclusive, node.tag))) return false;
        if ("equals" in a && !(value === num(a.equals, node.tag))) return false;
        if ("notEquals" in a && !(value !== num(a.notEquals, node.tag))) return false;
        return true;
    }

    /** @returns {boolean} */
    function evalConditional(node, ctx) {
        const inverted = node.attrs.inverted !== undefined;
        switch (node.tag) {
            case "if": {
                const v = evalNumeric(node, ctx);
                return v !== null && testNumeric(node, v);
            }
            case "ifCurrentValue": {
                if (ctx.current === undefined) throw new Error("actionListXml: ifCurrentValue outside numeric evaluation");
                return testNumeric(node, ctx.current);
            }
            case "ifResource": {
                const v = resources[node.attrs.resourceName];
                // no numeric tests = truthiness (upstream's Wander uses bare
                // <ifResource resourceName="glasses"/> for `glasses ? ...`)
                if (!hasTests(node)) return !!v !== inverted;
                return testNumeric(node, Number(v ?? 0));
            }
            case "ifHasResource":
                return !!resources[node.attrs.resourceName] !== inverted;
            case "ifStoryFlag":
                return !!storyFlags[node.attrs.storyFlagName] !== inverted;
            case "ifPrestige":   // fork schema extension: prestigeValues.completedAnyPrestige
                return !!prestigeValues.completedAnyPrestige !== inverted;
            case "ifTownUnlocked":   // fork schema extension: townsUnlocked membership
                return townsUnlocked.includes(num(node.attrs.townNum, "ifTownUnlocked")) !== inverted;
            case "ifGuild":   // fork schema extension: guild membership (guild="" = no guild)
                return (guild === node.attrs.guild) !== inverted;
            case "ifGlobalFlag": {   // fork schema extension: whitelisted boolean global
                const f = GLOBAL_FLAGS[node.attrs.name];
                if (!f) throw new Error(`actionListXml: global flag ${node.attrs.name} not whitelisted`);
                return !!f() !== inverted;
            }
            case "ifSoulstoneSac": {   // fork schema extension: checkSoulstoneSac(amount)
                const amount = evalNumeric(node, ctx);
                return (amount !== null && checkSoulstoneSac(amount)) !== inverted;
            }
            case "ifGuildRankName": {   // fork schema extension: guild-rank name match
                const f = GUILD_RANK_NAMES[node.attrs.which];
                if (!f) throw new Error(`actionListXml: guild rank ${node.attrs.which} not whitelisted`);
                return (f() === node.attrs.name) !== inverted;
            }
            case "anyOf": {   // fork schema extension: disjunction over child conditionals
                for (const c of node.children) {
                    if (evalConditional(c, ctx)) return !inverted;
                }
                return inverted;
            }
            case "never":   // fork schema extension: constant false (unlocks by other means)
                return inverted;
            case "ifProgress":
                return testNumeric(node, townFor(ownVar(node, ctx)).getLevel(ownVar(node, ctx)));
            case "ifGoodItems":
                return testNumeric(node, townFor(ownVar(node, ctx))["good" + ownVar(node, ctx)]);
            case "ifDiscoveredItems":
                return testNumeric(node, townFor(ownVar(node, ctx))["total" + ownVar(node, ctx)]);
            case "ifCheckedItems":
                return testNumeric(node, townFor(ownVar(node, ctx))["checked" + ownVar(node, ctx)]);
            default:
                throw new Error(`actionListXml: unknown conditional <${node.tag}>`);
        }
    }

    /** AND over a conditional list; empty list is true. */
    function evalConditionList(nodes, ctx) {
        for (const n of nodes) {
            if (!CONDITIONAL_TAGS.has(n.tag)) throw new Error(`actionListXml: expected conditional, got <${n.tag}>`);
            if (!evalConditional(n, ctx)) return false;
        }
        return true;
    }

    /** base value of a baseValue element */
    function evalBase(node, ctx) {
        switch (node.tag) {
            case "skillLevel": return getSkillLevel(node.attrs.skillName);
            case "skillExp": return skills[node.attrs.skillName].exp;
            case "buffLevel": return getBuffLevel(node.attrs.buffName);
            case "talentLevel": return getTalent(node.attrs.statName);
            case "stonesUsed": {
                const t = node.attrs.townNum !== undefined ? num(node.attrs.townNum, "stonesUsed") : ctx.action.townNum;
                return stonesUsed[t];
            }
            case "resourceValue": return resources[node.attrs.name];
            case "townValue": {
                const t = node.attrs.townNum !== undefined ? num(node.attrs.townNum, "townValue") : ctx.action.townNum;
                return towns[t][node.attrs.name];
            }
            case "globalValue": {
                const g = GLOBALS[node.attrs.name];
                if (!g) throw new Error(`actionListXml: global ${node.attrs.name} not whitelisted`);
                return g();
            }
            case "storyVar": {
                if (!(node.attrs.name in storyVars)) throw new Error(`actionListXml: unknown storyVar ${node.attrs.name}`);
                return storyVars[node.attrs.name];
            }
            // ---- multipart context values (fork schema extensions) ----
            case "segment": {
                if (ctx.mp?.segment === undefined) throw new Error("actionListXml: <segment/> outside loopCost");
                return ctx.mp.segment;
            }
            case "loopCounter": {
                // source="town" always reads the town's counter (trial
                // canStart bodies ignore their loopCounter argument);
                // varName reads ANOTHER action's counter (Prepare Buffet
                // scales off how many survivors were rescued this loop)
                const lcVar = node.attrs.varName ?? ctx.action.varName;
                if (node.attrs.varName !== undefined) return townFor(lcVar)[lcVar + "LoopCounter"];
                if (node.attrs.source === "town") return towns[ctx.action.townNum][lcVar + "LoopCounter"];
                return ctx.mp?.loopCounter
                    ?? towns[ctx.action.townNum][lcVar + "LoopCounter"];
            }
            case "totalCompletions":
                return ctx.mp?.totalCompletions
                    ?? towns[ctx.action.townNum]["total" + ctx.action.varName];
            case "segments":
                return ctx.action.segments;
            case "power":   // base^exponent; the exponent is the child evaluation
                return Math.pow(num(node.attrs.base, "power"), evalNumeric(node, ctx));
            case "fibonacci":
                return fibonacci(evalNumeric(node, ctx));
            case "dungeonCompleted": {   // completions of the floor given by the child evaluation
                const d = dungeons[num(node.attrs.dungeonNum, "dungeonCompleted")];
                return d[evalNumeric(node, ctx)].completed;
            }
            case "dungeonFloors":
                return dungeons[num(node.attrs.dungeonNum, "dungeonFloors")].length;
            case "trialCompleted": {
                const t = trials[num(node.attrs.trialNum, "trialCompleted")];
                return t[evalNumeric(node, ctx)].completed;
            }
            case "trialFloors":
                return trialFloors[num(node.attrs.trialNum, "trialFloors")];
            case "buffCap":
                return getBuffCap(node.attrs.buffName);
            case "completed":
                // story(completed): how many times the action finished this loop
                if (ctx.completed === undefined) throw new Error("actionListXml: <completed/> outside a story body");
                return ctx.completed;
            case "goodTempItems":
                // the per-loop remainder of a limited pool; good minus goodTemp
                // is how many were spent THIS loop
                return townFor(ownVar(node, ctx))["goodTemp" + ownVar(node, ctx)];
            case "currentFloor":
                // trial/dungeon floor derived from the town loop counter; the
                // method lives on the live action, so this is effect-context only
                if (!ctx.self?.currentFloor) throw new Error("actionListXml: <currentFloor/> outside a trial effect body");
                return ctx.self.currentFloor();
            case "guildSegment": {
                const g = GUILD_SEGMENTS[node.attrs.name];
                if (!g) throw new Error(`actionListXml: unknown guildSegment ${node.attrs.name}`);
                return g();
            }
            case "progressLevel": return townFor(node.attrs.varName).getLevel(node.attrs.varName);
            case "goodItems": return townFor(ownVar(node, ctx))["good" + ownVar(node, ctx)];
            case "discoveredItems": return townFor(ownVar(node, ctx))["total" + ownVar(node, ctx)];
            case "checkedItems": return townFor(ownVar(node, ctx))["checked" + ownVar(node, ctx)];
            case "value": return evalNumeric(node, ctx);
            case "function": {
                const fn = FUNCTIONS[node.attrs.name];
                if (!fn) throw new Error(`actionListXml: function ${node.attrs.name} not whitelisted`);
                return fn();
            }
            case "primaryValue": {
                const name = node.attrs.actionName ?? ctx.action.name;
                const def = ctx.doc.actions[name];
                if (!def) throw new Error(`actionListXml: primaryValue of unmigrated action ${name}`);
                const pv = child(def, "primaryValue");
                if (!pv) throw new Error(`actionListXml: ${name} has no <primaryValue>`);
                return evalNumeric(pv, { ...ctx, current: undefined });
            }
            default:
                throw new Error(`actionListXml: unknown base value <${node.tag}>`);
        }
    }

    /**
     * Apply one adjustment element to `value`. Returns the new value, or
     * `value` unchanged if the adjustment's guards fail. Returns null only
     * when a BARE conditional rule fails (voiding the whole evaluation).
     */
    function applyAdjustment(node, value, ctx) {
        if (CONDITIONAL_TAGS.has(node.tag)) {
            return evalConditional(node, { ...ctx, current: value }) ? value : null;
        }
        const guardsPass = (guards) => evalConditionList(guards, { ...ctx, current: value });
        switch (node.tag) {
            case "addition": case "subtraction": case "multiplier": case "divisor": {
                const operand = evalNumeric(node, { ...ctx, current: value });
                if (operand === null) return value;   // vetoed operand: adjustment is a no-op
                switch (node.tag) {
                    case "addition": return value + operand;
                    case "subtraction": return value - operand;
                    case "multiplier": return value * operand;
                    case "divisor": return value / operand;
                }
                break;
            }
            case "adjustment": {
                const rules = ctx.doc.adjustments[node.attrs.name];
                if (!rules) throw new Error(`actionListXml: unknown adjustment ${node.attrs.name}`);
                const applied = applyRuleList(rules, value, ctx);
                return applied === null ? value : applied;
            }
            case "skillBonus":
                return guardsPass(node.children) ? value * getSkillBonus(node.attrs.name) : value;
            case "skillMod":
                return guardsPass(node.children)
                    ? value * getSkillMod(node.attrs.name, num(node.attrs.minExclusive, "skillMod"),
                        num(node.attrs.max, "skillMod"), num(node.attrs.percentChange, "skillMod"))
                    : value;
            case "prestigeBonus":
                return guardsPass(node.children) ? value * prestigeBonus(node.attrs.name) : value;
            case "surveyBonus":
                return guardsPass(node.children)
                    ? value + value * getSurveyBonus(towns[ctx.action.townNum])
                    : value;
            case "ceil": return guardsPass(node.children) ? Math.ceil(value) : value;
            case "floor": return guardsPass(node.children) ? Math.floor(value) : value;
            case "round": return guardsPass(node.children) ? Math.round(value) : value;
            case "squareRoot": return guardsPass(node.children) ? Math.sqrt(value) : value;
            case "absoluteValue": return guardsPass(node.children) ? Math.abs(value) : value;
            case "precision3": return guardsPass(node.children) ? precision3(value) : value;
            case "setValue": {
                const v = evalNumeric(node, { ...ctx, current: value });
                return v === null ? value : v;
            }
            case "clampMin": {
                const v = evalNumeric(node, { ...ctx, current: value });
                return v === null ? value : Math.max(value, v);
            }
            case "clampMax": {
                const v = evalNumeric(node, { ...ctx, current: value });
                return v === null ? value : Math.min(value, v);
            }
            case "additiveBonus": {
                // each child applies to the value as it stood on entry;
                // deltas accumulate: v0 + Σ (apply_i(v0) - v0)
                let total = value;
                for (const c of node.children) {
                    const applied = applyAdjustment(c, value, ctx);
                    if (applied === null) return null;
                    total += applied - value;
                }
                return total;
            }
            default:
                throw new Error(`actionListXml: unknown adjustment <${node.tag}>`);
        }
    }

    /** @returns {number|null} null = evaluation voided by a failed guard */
    function applyRuleList(rules, value, ctx) {
        for (const r of rules) {
            const next = applyAdjustment(r, value, ctx);
            if (next === null) return null;
            value = next;
        }
        return value;
    }

    /**
     * numericEvaluation: base from `value` attribute, element text, or a
     * leading baseValue element; then the ordered rule list.
     * @returns {number|null}
     */
    function evalNumeric(node, ctx) {
        let rules = node.children;
        let value;
        if ("value" in node.attrs) {
            value = num(node.attrs.value, `<${node.tag}>`);
        } else if (rules.length && BASE_VALUE_TAGS.has(rules[0].tag)) {
            value = evalBase(rules[0], ctx);
            rules = rules.slice(1);
        } else if (node.text.trim() !== "") {
            value = num(node.text.trim(), `<${node.tag}>`);
        } else {
            throw new Error(`actionListXml: <${node.tag}> has no base value`);
        }
        return applyRuleList(rules, value, { ...ctx, current: value });
    }

    // ---- effect execution (Phase 6) --------------------------------------
    //
    // Effect elements execute in DOCUMENT ORDER. Guards are the existing
    // conditional semantics: a voided evaluation (null) makes the enclosing
    // effect a no-op — which is how
    //   <setStoryFlag name="craft10Armor"><ifResource resourceName="armor"
    //     min="10"/></setStoryFlag>
    // expresses `if (resources.armor >= 10) setStoryFlag(...)`.
    //
    // Every resource and mana grant in the executor funnels through the ONE
    // dispatcher below. That is the P2 §2d award-indirection seam: the
    // carrier consults a world-data award schedule here to route a grant
    // local | foreign | dummy. No schedule ⇒ the dispatcher IS the direct
    // call, which is what keeps the option byte-inert.

    // ---- P2 award carrier (cross-game §2d) --------------------------------
    //
    // The schedule is WORLD DATA (installed by the managed-mode host via
    // IdleLoopsManaged.setAwardSchedule; never present in standalone play).
    // Key: (varName, resourceName, n-th grant of that resource by that
    // action within the current loop) — the recorded design's
    // (actionVarName, completionIndexWithinLoop) key refined per resource
    // name, because one completion may grant several resources (Long
    // Quest: gold AND reputation) and an entry must target exactly one.
    // Grant counters restart every loop (driver restart() calls
    // onLoopRestart — the same reset moment as resetResources), so the
    // routing is replay-stable with zero runtime RNG.
    //
    // Entry forms (array index = grant index within the loop; a missing or
    // null entry keeps the vanilla grant):
    //   null                          vanilla grant
    //   { dummy: true }               suppressed — nothing granted anywhere
    //   { name, count? }              local re-route ("mana" allowed; count default 1)
    //   { substrate, type, count? }   foreign award — handed to the managed-mode
    //       outbound hook; with no hook registered (workers, standalone play)
    //       the grant is DROPPED locally, which is the declared semantics:
    //       the local player deliberately receives nothing.
    //
    // Only POSITIVE NUMERIC grants are routable: cost deductions (sign < 0)
    // and boolean unlock flags are outside the consumable pool by the P1
    // sharing declaration, and the validator refuses schedules that name
    // them.

    /** @type {object|null} validated world-data schedule, or null (inert) */
    let awardSchedule = null;
    /** @type {Record<string, number>} per-loop grant counters, "var res" -> count */
    let awardCounters = { __proto__: null };
    /** @type {((info: {varName: string, resource: string, index: number, substrate: string, type: string, count: number}) => void) | null} */
    let foreignAwardHook = null;

    function validAwardEntry(e) {
        if (e === null) return true;
        if (typeof e !== "object") return false;
        if (e.dummy === true) return Object.keys(e).length === 1;
        const count = e.count ?? 1;
        if (!Number.isInteger(count) || count <= 0) return false;
        if (typeof e.substrate === "string") {
            return e.substrate !== "" && e.substrate !== "omsi"
                && typeof e.type === "string" && e.type !== "";
        }
        return typeof e.name === "string" && routableResource(e.name);
    }

    function routableResource(name) {
        if (name === "mana") return true;
        // numeric template entries only — booleans are unlock flags, not
        // consumables (guard: saving.js may be absent in exotic contexts)
        return typeof resourcesTemplate !== "undefined"
            && typeof resourcesTemplate[name] === "number";
    }

    /**
     * Install (or clear, with null) the award schedule. Whole-schedule
     * validation: an invalid document is REJECTED and the carrier stays
     * inert — world data must not half-apply.
     * @returns {boolean} true when installed (or cleared)
     */
    function setAwardSchedule(schedule) {
        awardCounters = { __proto__: null };
        lootStates = { __proto__: null };
        if (schedule == null) { awardSchedule = null; return true; }
        const reject = (why) => {
            console.warn(`actionListXml: award schedule rejected: ${why}`);
            awardSchedule = null;
            return false;
        };
        if (typeof schedule !== "object") return reject("not an object");
        const awards = schedule.awards;
        if (awards !== undefined) {
            if (typeof awards !== "object" || awards === null) return reject("awards is not an object");
            for (const varName in awards) {
                const site = awards[varName];
                if (typeof site !== "object" || site === null) return reject(`awards.${varName} is not an object`);
                for (const res in site) {
                    if (!routableResource(res)) return reject(`awards.${varName}.${res}: not a routable resource`);
                    const entries = site[res];
                    if (!Array.isArray(entries)) return reject(`awards.${varName}.${res} is not an array`);
                    for (const e of entries) {
                        if (!validAwardEntry(e)) return reject(`awards.${varName}.${res}: bad entry ${JSON.stringify(e)}`);
                    }
                }
            }
        }
        const lootables = schedule.lootables;
        if (lootables !== undefined) {
            if (typeof lootables !== "object" || lootables === null) return reject("lootables is not an object");
            for (const varName in lootables) {
                const contents = lootables[varName]?.contents;
                if (!Array.isArray(contents)) return reject(`lootables.${varName}.contents is not an array`);
                for (const e of contents) {
                    if (!validAwardEntry(e)) return reject(`lootables.${varName}: bad entry ${JSON.stringify(e)}`);
                }
            }
        }
        awardSchedule = schedule;
        return true;
    }

    /** Per-loop carrier state restarts with the loop (driver restart()). */
    function onLoopRestart() {
        awardCounters = { __proto__: null };
        // the walk state rebuilds lazily from (contents, good) — restart
        // already reset every goodTemp, so the burn count is zero
        lootStates = { __proto__: null };
    }

    /** Managed-mode outbound hook for foreign entries (bridge-registered). */
    function setForeignAwardHook(fn) {
        foreignAwardHook = typeof fn === "function" ? fn : null;
    }

    /** @returns {number} the amount granted LOCALLY (0 for dummy/foreign) */
    function applyAwardEntry(varName, resource, index, entry) {
        if (entry.dummy === true) return 0;
        if (entry.substrate !== undefined) {
            if (foreignAwardHook !== null) {
                try {
                    foreignAwardHook({
                        varName, resource, index,
                        substrate: entry.substrate, type: entry.type,
                        count: entry.count ?? 1,
                    });
                } catch (e) {
                    console.error("actionListXml: foreign award hook threw", e);
                }
            }
            return 0;
        }
        const count = entry.count ?? 1;
        if (entry.name === "mana") addMana(count);
        else addResource(entry.name, count);
        return count;
    }

    /**
     * The single grant site.
     * @param {object} action  the live Action (grant attribution)
     * @param {string} name    resource name; "mana" is the loop-budget pseudo-resource
     * @param {number|boolean} amount
     * @returns {number|boolean} the amount granted (finishRegular's ledger value)
     */
    function grantResource(action, name, amount) {
        if (awardSchedule !== null && typeof amount === "number" && amount > 0) {
            const site = awardSchedule.awards?.[action.varName];
            const entries = site === undefined ? undefined : site[name];
            if (entries !== undefined) {
                const key = action.varName + " " + name;
                const idx = awardCounters[key] = (awardCounters[key] ?? 0) + 1;
                const entry = entries[idx - 1];
                if (entry !== undefined && entry !== null) {
                    return applyAwardEntry(action.varName, name, idx - 1, entry);
                }
            }
        }
        if (name === "mana") addMana(/** @type {number} */(amount));
        else addResource(name, amount);
        return amount;
    }

    // ---- P2 lootable contents (cross-game §9b-pre) -------------------------
    //
    // Limited actions harvest a per-town pool of "good" instances (pots
    // with mana). A lootable contents schedule — schedule.lootables[varName]
    // .contents — maps the k-th GOOD instance (k = the persistent good
    // index, 0-based in discovery order; NOT the per-loop checked index) to
    // a content: null = the vanilla loot, or the carrier's entry vocabulary
    // (local {name, count} / foreign {substrate, type, count} / {dummy}).
    // Indices past the array end are vanilla.
    //
    // Discovery stays vanilla-order (contents are unknown until checked —
    // this also keeps the U-plan's discovery axis untouched): the discovery
    // branch reveals contents[k] at the moment the k-th good is minted and
    // harvests it immediately, exactly like vanilla. RE-HARVESTING known
    // goods (the goodTemp walk) is where the player's per-category priority
    // applies: each harvest picks the first category, in priority order,
    // with instances remaining this loop and not disabled, consuming that
    // category's instances in ascending k. Per-loop walk state rebuilds on
    // every restart from (contents, good) — replay-stable, zero RNG.
    //
    // Discovery memory: a persistent per-action category census
    // (town[`lootCensus${varName}`] = { category -> count }) is minted
    // lazily at first scheduled discovery and kept beside the ledger vars
    // (saving.js persists it; restore is assign-or-DELETE, absent in old
    // saves = empty). It is reconciled against (contents, good) whenever
    // the walk state rebuilds, so an old save entering a scheduled world
    // starts with the correct discovered set.
    //
    // lootFrom semantics: only VANILLA harvests feed the lootFrom ledger —
    // a re-routed/foreign/dummy instance contributes 0 (the tooltip counts
    // what the pool itself yielded).
    //
    // Town.finishRegular delegates here when a schedule names its varName;
    // with no schedule the vanilla body runs untouched (byte-inert).

    /** @type {Record<string, {byCat: Record<string, {ks: number[], cursor: number}>}>} per-loop walk state by varName */
    let lootStates = { __proto__: null };
    /** @type {Record<string, {order: string[], disabled: Set<string>}>} session-only UI prefs by varName */
    let lootPrefs = { __proto__: null };

    function lootCategoryOf(entry) {
        if (entry === null || entry === undefined) return "vanilla";
        if (entry.dummy === true) return "dummy";
        if (entry.substrate !== undefined) return `foreign:${entry.substrate}/${entry.type}`;
        return `local:${entry.name}`;
    }

    /** @returns {boolean} true when a contents schedule names this varName */
    function handlesLoot(varName) {
        return awardSchedule?.lootables?.[varName] != null;
    }

    /** Category priority: user prefs first, then default order (vanilla
     *  first, dummy last, others by first appearance in the pool). */
    function lootOrder(varName, byCat) {
        const cats = Object.keys(byCat);
        cats.sort((a, b) => {
            const rank = (c) => c === "vanilla" ? 0 : c === "dummy" ? 2 : 1;
            if (rank(a) !== rank(b)) return rank(a) - rank(b);
            return (byCat[a].ks[0] ?? 0) - (byCat[b].ks[0] ?? 0);
        });
        const pref = lootPrefs[varName];
        if (!pref) return cats;
        const inPref = pref.order.filter((c) => c in byCat);
        return [...inPref, ...cats.filter((c) => !inPref.includes(c))];
    }

    function lootDisabled(varName) {
        return lootPrefs[varName]?.disabled ?? new Set();
    }

    /**
     * Rebuild one action's per-loop walk state from world data + the
     * persistent town ledgers, reconciling the census. Called on loop
     * restart and on schedule install; a mid-loop install additionally
     * burns the goods already harvested this loop (good - goodTemp) in
     * priority order — a one-loop approximation that the next restart
     * squares exactly.
     */
    function buildLootState(varName) {
        const contents = awardSchedule.lootables[varName].contents;
        const town = townFor(varName);
        const good = town[`good${varName}`] ?? 0;
        /** @type {Record<string, {ks: number[], cursor: number}>} */
        const byCat = { __proto__: null };
        for (let k = 0; k < good; k++) {
            const cat = lootCategoryOf(contents[k] ?? null);
            (byCat[cat] ??= { ks: [], cursor: 0 }).ks.push(k);
        }
        const censusKey = `lootCensus${varName}`;
        const census = town[censusKey];
        const censusTotal = census
            ? Object.values(census).reduce((a, b) => a + b, 0) : 0;
        if (censusTotal !== good) {
            const rebuilt = {};
            for (const cat in byCat) rebuilt[cat] = byCat[cat].ks.length;
            town[censusKey] = rebuilt;
        }
        const st = { byCat };
        let burn = good - (town[`goodTemp${varName}`] ?? good);
        while (burn-- > 0) {
            const cat = pickLootCategory(st, varName, /* anyCategory */ true);
            if (cat === null) break;
            byCat[cat].cursor++;
        }
        return st;
    }

    function lootState(varName) {
        return lootStates[varName] ?? (lootStates[varName] = buildLootState(varName));
    }

    /** Instances remaining this loop across ENABLED categories. */
    function lootEnabledRemaining(varName) {
        const st = lootState(varName);
        const disabled = lootDisabled(varName);
        let n = 0;
        for (const cat in st.byCat) {
            if (disabled.has(cat)) continue;
            n += st.byCat[cat].ks.length - st.byCat[cat].cursor;
        }
        return n;
    }

    /** @returns {string|null} the category the next re-harvest consumes */
    function pickLootCategory(st, varName, anyCategory = false) {
        const disabled = anyCategory ? new Set() : lootDisabled(varName);
        for (const cat of lootOrder(varName, st.byCat)) {
            if (disabled.has(cat)) continue;
            const b = st.byCat[cat];
            if (b.cursor < b.ks.length) return cat;
        }
        return null;
    }

    /** @returns {number} the harvested instance's lootFrom contribution */
    function executeLootEntry(varName, k, entry, rewardFunc) {
        if (entry === null || entry === undefined) return rewardFunc();
        applyAwardEntry(varName, "loot", k, entry);
        return 0;
    }

    /**
     * The scheduled finishRegular walk — mirrors Town.finishRegular
     * (town.js) with the contents schedule applied; the vanilla body stays
     * authoritative for the no-schedule path. Keep the two in sync.
     */
    function lootFinishRegular(town, varName, rewardRatio, rewardFunc) {
        // error state, negative numbers (verbatim vanilla fixup)
        if (town[`total${varName}`] - town[`checked${varName}`] < 0) {
            town[`checked${varName}`] = town[`total${varName}`];
            town[`good${varName}`] = Math.floor(town[`total${varName}`] / rewardRatio);
            town[`goodTemp${varName}`] = town[`good${varName}`];
            console.log("Error state fixed");
        }

        const contents = awardSchedule.lootables[varName].contents;
        const st = lootState(varName);
        const searchToggler = inputElement(`searchToggler${varName}`, false, false);
        const unchecked = town[`total${varName}`] - town[`checked${varName}`];
        const effective = lootEnabledRemaining(varName);

        if (unchecked > 0 && ((searchToggler && !searchToggler.checked) || effective <= 0)) {
            town[`checked${varName}`]++;
            if (town[`checked${varName}`] % rewardRatio === 0) {
                // the k-th good is minted, revealed and harvested in one act
                const k = town[`good${varName}`];
                const entry = contents[k] ?? null;
                town[`lootFrom${varName}`] += executeLootEntry(varName, k, entry, rewardFunc);
                town[`good${varName}`]++;
                const census = town[`lootCensus${varName}`] ?? (town[`lootCensus${varName}`] = {});
                const cat = lootCategoryOf(entry);
                census[cat] = (census[cat] ?? 0) + 1;
                // freshly minted goods do not join this loop's walk (vanilla
                // goodTemp is not incremented mid-loop either)
            }
        } else if (effective > 0) {
            const cat = pickLootCategory(st, varName);
            const bucket = st.byCat[cat];
            const k = bucket.ks[bucket.cursor++];
            town[`goodTemp${varName}`]--;
            const entry = contents[k] ?? null;
            town[`lootFrom${varName}`] += executeLootEntry(varName, k, entry, rewardFunc);
        }
        view.requestUpdate("updateRegular", { name: varName, index: town.index });
    }

    /** Session-only per-category priority + disable set (the §9b-pre UI). */
    function setLootPriority(varName, order, disabled) {
        lootPrefs[varName] = {
            order: Array.isArray(order) ? order.slice() : [],
            disabled: new Set(disabled ?? []),
        };
    }

    /**
     * UI readout for one lootable: discovered categories in current
     * priority order with census counts and this-loop remaining.
     */
    function getLootView(varName) {
        if (!handlesLoot(varName)) return null;
        const town = townFor(varName);
        const st = lootState(varName);
        const disabled = lootDisabled(varName);
        const census = town[`lootCensus${varName}`] ?? {};
        return lootOrder(varName, st.byCat).map((cat) => ({
            category: cat,
            discovered: census[cat] ?? st.byCat[cat].ks.length,
            remaining: st.byCat[cat].ks.length - st.byCat[cat].cursor,
            disabled: disabled.has(cat),
        }));
    }

    // whitelisted <effect name="..."/> primitives: composite / RNG-bearing /
    // shared machinery, each wrapping the SAME helper the JS body calls (RNG
    // parity by construction — the XML vocabulary has no draw verbs).
    const EFFECTS = {
        // HaulAction.finish latches which town's ruins the stone came from
        setStoneLoc: (ctx) => { stoneLoc = ctx.action.townNum; },
        // the assassin kill list: a per-loop array of the zones hit, which
        // Guild Assassin reads back. The heart itself is a plain resource.
        pushHeart: (ctx) => { hearts.push(ctx.action.varName); },
        // the four RNG sites stay inside these helpers; the XML invokes them
        // whole, which is what makes RNG parity structural rather than tested
        mineSoulstones: (ctx) => {
            const statToAdd = options.rngMode === "cycle" ? cyclePick(statList, "mineStat")
                : statList[Math.floor(Math.random() * statList.length)];
            const countToAdd = Math.floor(getSkillBonus("Divine"));
            stats[statToAdd].soulstone += countToAdd;
            actionLog.addSoulstones(ctx.self, statToAdd, countToAdd);
            stateChanged("soulstones");
        },
        exchangeMap: () => exchangeMap(),
        // Fall From Grace pins reputation negative, but its notification fires
        // whether or not the guard let the write through
        fallFromGrace: () => {
            if (resources.reputation >= 0) resources.reputation = -1;
            stateChanged("resource", { name: "reputation" });
        },
        // the assassin payout scales with the square of the hearts delivered,
        // with a flat first-kill bonus
        assassinGuildSkill: (ctx) => {
            let assassinExp = 0;
            if (getSkillLevel("Assassin") === 0) assassinExp = 100;
            if (resources.heart > 0) assassinExp = 100 * Math.pow(resources.heart, 2);
            ctx.self.skills.Assassin = assassinExp;
        },
        // dungeon completion: the floor is derived from the town loop counter,
        // and finishDungeon carries the soulstone roll + stat pick
        dungeonFinish: (ctx) => {
            const a = ctx.self;
            const loopCounter = towns[a.townNum][a.varName + "LoopCounter"];
            const curFloor = Math.floor(loopCounter / a.segments + 0.0000001 - 1);
            return a.finishDungeon(curFloor);
        },
        adjustRocks: () => adjustRocks(stoneLoc),
        // RuinsZ* re-lays its OWN town's rocks (Build Tower uses stoneLoc)
        adjustRocksHere: (ctx) => adjustRocks(ctx.action.townNum),
        // Survey: consume a map for survey progress, or — once the zone is
        // fully surveyed — offer the pause instead. One composite because the
        // two arms are exclusive and the second one is a UI action.
        surveyFinish: (ctx) => {
            const a = ctx.self;
            if (towns[a.townNum].getLevel("Survey") != 100) {
                addResource("map", -1);
                addResource("completedMap", 1);
                towns[a.townNum].finishProgress(a.varName, getExploreSkill());
            } else if (options.pauseOnComplete) {
                pauseGame(true, "Survey complete! (Game paused)");
            }
        },
        // Small Dungeon reports which global story beat the run earned
        smallDungeonFinish: (ctx) => {
            const success = EFFECTS.dungeonFinish(ctx);
            if (success === true && storyMax <= 1) unlockGlobalStory(1);
            else if (success === false && storyMax <= 2) unlockGlobalStory(2);
        },
        // the Spire additionally banks an Aspirant level per new floor
        spireFinish: (ctx) => {
            const a = ctx.self;
            const loopCounter = towns[a.townNum][a.varName + "LoopCounter"];
            const curFloor = Math.floor(loopCounter / a.segments + 0.0000001 - 1);
            a.finishDungeon(curFloor);
            if (curFloor >= getBuffLevel("Aspirant")) addBuffAmt("Aspirant", 1, a);
            if (curFloor == dungeonFloors[a.dungeonNum] - 1) setStoryFlag("clearedSpire");
        },
        // Build Tower: one stone consumed into the tower, and at level 100 the
        // whole stone economy is exhausted game-wide
        buildTowerStones: (ctx) => {
            stonesUsed[stoneLoc]++;
            if (towns[ctx.action.townNum].getLevel(ctx.action.varName) >= 100) {
                stonesUsed = { 1: 250, 3: 250, 5: 250, 6: 250 };
            }
        },
        // Haggle knocks 20 off the supply price, floored at zero
        haggleSupplies: () => {
            towns[0].suppliesCost -= 20;
            if (towns[0].suppliesCost < 0) towns[0].suppliesCost = 0;
            stateChanged("resource", { name: "supplies" });
        },
        // Invest banks the whole purse — but a NaN gold value must not be
        // allowed to corrupt the persistent bank (upstream guard, preserved)
        investGold: () => {
            if (isFinite(resources.gold)) {
                goldInvested += resources.gold;
                if (goldInvested > 999999999999) goldInvested = 999999999999;
                resetResource("gold");
            }
            stateChanged("goldInvested");
        },
        completedCurrentGame: () => completedCurrentGame(),
        // Imbue Mind caps training only when the option is on
        capTrainingIfAuto: () => { if (options.autoMaxTraining) capAllTraining(); },
        capAllTraining: () => capAllTraining(),
        adjustTrainingExpMult: () => adjustTrainingExpMult(),
        // Imbue Body drains every stat's talent down toward zero and pays the
        // drained amounts as the buff's spend ledger — one composite, because
        // the amount spent is only known from the drain itself
        imbueBodyEffect: (ctx) => {
            const spent = {};
            for (const stat of statList) {
                const currentTalentLevel = getTalent(stat);
                const targetTalentLevel = Math.max(currentTalentLevel - getBuffLevel("Imbuement2") - 1, 0);
                stats[stat].talentLevelExp.setLevel(targetTalentLevel);
                spent[stat] = currentTalentLevel - targetTalentLevel;
            }
            stateChanged("talentsReset");
            addBuffAmt("Imbuement2", 1, ctx.self, "talent", spent);
        },
        // Imbue Soul is the prestige-shaped wipe: talents, soulstones, the two
        // lower Imbuements and the training limit all reset together
        imbueSoulReset: (ctx) => {
            for (const stat of statList) {
                stats[stat].talentLevelExp.setLevel(0);
                stats[stat].soulstone = 0;
            }
            buffs["Imbuement"].amt = 0;
            buffs["Imbuement2"].amt = 0;
            trainingLimits = 10;
            addBuffAmt("Imbuement3", 1, ctx.self, "imbuement3");
            stateChanged("imbueSoulReset");
        },
        // Spatiomancy resizes every limited pool game-wide when its LEVEL
        // moves, so the grant and the re-adjust are one composite
        spatiomancyFinish: (ctx) => {
            const before = getSkillLevel("Spatiomancy");
            handleSkillExp(ctx.self.skills);
            if (getSkillLevel("Spatiomancy") !== before) adjustAll();
        },
    };

    // whitelisted <sacrifice variant="..."/> targets. `sacrificeSoulstones` is
    // an alias for the by-segments variant, which is what all three buff
    // actions call today; the other two exist upstream and are named here so
    // the vocabulary matches the helpers rather than the alias.
    const SACRIFICES = {
        bySegments: (amount) => sacrificeSoulstonesBySegments(amount),
        proportional: (amount) => sacrificeSoulstonesProportional(amount),
        toEquality: (amount) => sacrificeSoulstonesToEquality(amount),
    };
    const EFFECT_TAGS = new Set(["numericResource", "booleanResource", "setStoryFlag",
        "storyVarMin", "skillExp", "setSkill", "progressExp", "grantProgress",
        "guildSegmentIncrement", "buff", "addTrainingLimit", "unlockGlobalStory",
        "unlockTown", "joinGuild", "resetResource", "setResource", "setGlobalFlag",
        "noEffect", "effect"]);

    /**
     * Execute one effect element.
     * @param {XmlNode} node
     * @param {object} ctx  evaluation context; ctx.self is the live Action
     * @param {1|-1} sign  +1 grants (<reward>), -1 deducts (<cost>): numeric
     *   amounts are negated and boolean resources cleared instead of set
     */
    function execEffect(node, ctx, sign) {
        switch (node.tag) {
            case "numericResource": {
                const amount = evalNumeric(node, ctx);
                if (amount === null) return;   // guard voided
                grantResource(ctx.self, node.attrs.name, sign < 0 ? -amount : amount);
                return;
            }
            case "booleanResource": {
                if (!evalConditionList(node.children, ctx)) return;
                // clear="clear" consumes rather than grants, independent of the
                // slot's sign (Open Rift spends its supplies inside finish())
                grantResource(ctx.self, node.attrs.name, node.attrs.clear === undefined && sign > 0);
                return;
            }
            case "setStoryFlag": {
                if (!evalConditionList(node.children, ctx)) return;
                setStoryFlag(node.attrs.name);
                return;
            }
            case "storyVarMin": {
                const v = evalNumeric(node, ctx);
                if (v === null) return;
                increaseStoryVarTo(node.attrs.name, v);
                return;
            }
            case "grantProgress": {
                // execute the action's own <progress> data field here
                if (!ctx.progress) throw new Error(`actionListXml: <grantProgress/> without <progress>`);
                const amount = evalNumeric(ctx.progress, ctx);
                if (amount === null) return;
                towns[ctx.action.townNum].finishProgress(ctx.action.varName, amount);
                return;
            }
            case "progressExp": {
                // finishProgress against a named progress var — the action's OWN
                // progress normally rides <progress>, but Throw Party feeds Met
                // and the thieves jobs grant mid-body
                const amount = evalNumeric(node, ctx);
                if (amount === null) return;
                const v = node.attrs.varName ?? ctx.action.varName;
                townFor(v).finishProgress(v, amount);
                return;
            }
            case "setSkill": {
                // Seek Blessing and Prepare Buffet WRITE their skills table
                // before granting it (the amount scales with a guild rank /
                // loop counter). The JS bodies mutate this.skills the same way.
                const v = evalNumeric(node, ctx);
                if (v === null) return;
                ctx.self.skills[node.attrs.name] = v;
                return;
            }
            case "skillExp":
                // amounts come from the action's own skills table, which stays
                // runtime-authoritative (main.view.js pulls action.skills[s]())
                handleSkillExp(ctx.self.skills);
                return;
            case "buff": {
                // addBuffAmt(name, 1, action, spendType?, stonesSpent?).
                // A <sacrifice> child runs first and its return is the spend
                // ledger; without one the buff is granted outright (Heroism).
                if (!evalConditionList(node.children.filter(c => c.tag !== "sacrifice"), ctx)) return;
                const sac = child(node, "sacrifice");
                if (sac) {
                    const amount = evalNumeric(sac, ctx);
                    if (amount === null) return;
                    const fn = SACRIFICES[sac.attrs.variant];
                    if (!fn) throw new Error(`actionListXml: sacrifice variant ${sac.attrs.variant} not whitelisted`);
                    addBuffAmt(node.attrs.name, 1, ctx.self, node.attrs.spendType, fn(amount));
                } else if (node.attrs.spendType !== undefined) {
                    addBuffAmt(node.attrs.name, 1, ctx.self, node.attrs.spendType);
                } else {
                    addBuffAmt(node.attrs.name, 1, ctx.self);
                }
                return;
            }
            case "unlockTown": {
                if (!evalConditionList(node.children, ctx)) return;
                unlockTown(num(node.attrs.num, "unlockTown"));
                return;
            }
            case "joinGuild": {
                // the guild is a global, not a resource, and joining one
                // forecloses the others for the loop
                if (!evalConditionList(node.children, ctx)) return;
                guild = node.attrs.name;
                if (node.attrs.notify !== undefined) stateChanged("guild");
                return;
            }
            case "resetResource": {
                if (!evalConditionList(node.children, ctx)) return;
                resetResource(node.attrs.name);
                return;
            }
            case "setResource": {
                // a direct write, bypassing addResource (Fall From Grace pins
                // reputation to -1 rather than adding to it)
                if (!evalConditionList(node.children, ctx)) return;
                resources[node.attrs.name] = num(node.attrs.value, "setResource");
                if (node.attrs.notify !== undefined) stateChanged("resource", { name: node.attrs.name });
                return;
            }
            case "setGlobalFlag": {
                if (!evalConditionList(node.children, ctx)) return;
                const f = node.attrs.name;
                if (f !== "portalUsed") throw new Error(`actionListXml: global flag ${f} not writable`);
                portalUsed = true;
                return;
            }
            case "unlockGlobalStory": {
                if (!evalConditionList(node.children, ctx)) return;
                unlockGlobalStory(num(node.attrs.num, "unlockGlobalStory"));
                return;
            }
            case "addTrainingLimit":
                // Imbue Mind raises the cap on the six training actions
                if (!evalConditionList(node.children, ctx)) return;
                trainingLimits++;
                return;
            case "guildSegmentIncrement": {
                const inc = GUILD_SEGMENT_INCREMENTS[node.attrs.name];
                if (!inc) throw new Error(`actionListXml: guild segment ${node.attrs.name} not whitelisted`);
                if (!evalConditionList(node.children, ctx)) return;
                inc();
                return;
            }
            case "noEffect":
                // this slot intentionally does nothing. An explicit marker, so
                // "compiled as a no-op" is distinguishable from "not modelled
                // yet" (a self-closing placeholder) in the slot manifest.
                return;
            case "effect": {
                const fn = EFFECTS[node.attrs.name];
                if (!fn) throw new Error(`actionListXml: effect ${node.attrs.name} not whitelisted`);
                if (!evalConditionList(node.children, ctx)) return;
                fn(ctx);
                return;
            }
            default:
                throw new Error(`actionListXml: unknown effect <${node.tag}>`);
        }
    }

    /** effect children of a slot element, minus the structural wrappers */
    const effectsOf = (nodes) => nodes.filter(n => {
        if (EFFECT_TAGS.has(n.tag)) return true;
        if (n.tag === "before" || n.tag === "after" || n.tag === "ledger" || n.tag === "deduction") return false;
        throw new Error(`actionListXml: unknown effect <${n.tag}>`);
    });

    // ---- compilation -----------------------------------------------------

    /**
     * Compile one <action> definition into Action-shaped fields.
     * @param {XmlNode} def
     * @param {{adjustments: Record<string, XmlNode[]>, actions: Record<string, XmlNode>}} doc
     */
    function compileAction(def, doc) {
        const name = def.attrs.name;
        const varName = def.attrs.varName ?? name.replace(/ /gu, "");
        const townNum = def.attrs.townNum !== undefined ? num(def.attrs.townNum, "townNum") : 0;
        const ctx = { doc, action: { name, varName, townNum } };
        // multipart: segments defaults to the loopStats count (Fight Monsters
        // overrides with segments="3" against its 9 loopStats, as upstream does)
        const loopStatsNode = child(def, "loopStats");
        const loopStats = loopStatsNode?.children.map(c => c.attrs.statName);
        if (loopStats) {
            ctx.action.segments = def.attrs.segments !== undefined
                ? num(def.attrs.segments, "segments") : loopStats.length;
        }
        const need = (tag) => {
            const c = child(def, tag);
            if (!c) throw new Error(`actionListXml: ${name} lacks required <${tag}>`);
            return c;
        };

        /** @type {Record<string, any>} */
        const fields = { name, varName, townNum, type: def.attrs.type };
        // fields marked native="native" keep their hand-written JS closures —
        // the two-layer model's behavior slot (e.g. Continue On's allowed()
        // reads the action queue). Consumers skip compiling/comparing them.
        const nativeFields = [];
        const native = (node, field) => {
            if (node?.attrs.native === undefined) return false;
            nativeFields.push(field);
            return true;
        };

        const expMultNode = need("expMult");
        fields.expMult = evalNumeric(expMultNode, ctx);

        const stats = {};
        for (const s of need("stats").children) {
            stats[s.attrs.statName] = num(s.text.trim(), `${name} stats`) / 100;
        }
        fields.stats = stats;

        const affectedBy = child(def, "affectedBy");
        if (affectedBy) fields.affectedBy = affectedBy.children.map(c => c.attrs.name);

        const effortCost = need("effortCost");
        if (!native(effortCost, "manaCost")) fields.manaCost = () => evalNumeric(effortCost, ctx);

        const primaryValue = child(def, "primaryValue");
        if (primaryValue && !native(primaryValue, "goldCost")) {
            fields.goldCost = () => evalNumeric(primaryValue, ctx);
        }

        const visible = need("visible");
        if (!native(visible, "visible")) fields.visible = () => evalConditionList(visible.children, ctx);
        const unlocked = need("unlocked");
        if (!native(unlocked, "unlocked")) fields.unlocked = () => evalConditionList(unlocked.children, ctx);

        const allowed = child(def, "allowed");
        if (allowed && !native(allowed, "allowed")) fields.allowed = () => evalNumeric(allowed, ctx);

        // canStart: the explicit <canStart> conditions AND the affordability
        // implied by <cost> numeric resources (JS canStart bodies are the
        // affordability check). Multipart canStart takes a loopCounter arg.
        const canStart = child(def, "canStart");
        const cost = child(def, "cost");
        if (native(canStart, "canStart")) {
            // canStart stays JS; cost (if any) is Phase-6 data only
        } else if (canStart || cost) {
            // implied="none": the cost is deducted but not gated on (e.g.
            // Dark Magic pushes reputation negative)
            const costChecks = (cost?.attrs.implied === "none" ? [] : cost?.children ?? [])
                .filter(c => c.tag === "numericResource" || c.tag === "booleanResource")
                .map(c => ({ kind: c.tag, resource: c.attrs.name, node: c }));
            fields.canStart = (loopCounter) => {
                const c = loopStats ? { ...ctx, mp: { loopCounter } } : ctx;
                for (const { kind, resource, node } of costChecks) {
                    if (kind === "booleanResource") {
                        if (!resources[resource]) return false;
                        continue;
                    }
                    const needAmount = evalNumeric(node, c);
                    if (needAmount === null || !(resources[resource] >= needAmount)) return false;
                }
                return canStart ? evalConditionList(canStart.children, c) : true;
            };
        }

        // multipart-specific fields: loopCost(segment, loopCounter) and
        // tickProgress(offset, loopCounter, totalCompletions) are pure
        // parameterized evaluations; <segmentReward>/<loopReward> are
        // Phase-6 data (parsed, unconsumed), like <reward>
        if (loopStats) {
            fields.loopStats = loopStats;
            fields.segments = ctx.action.segments;
            const loopCost = child(def, "loopCost");
            if (loopCost && !native(loopCost, "loopCost")) {
                fields.loopCost = (segment, loopCounter) =>
                    evalNumeric(loopCost, { ...ctx, mp: { segment, loopCounter } });
            }
            const tickProgress = child(def, "tickProgress");
            if (tickProgress && !native(tickProgress, "tickProgress")) {
                fields.tickProgress = (_offset, loopCounter, totalCompletions) =>
                    evalNumeric(tickProgress, { ...ctx, mp: { loopCounter, totalCompletions } });
            }
        }

        const storyReqs = child(def, "storyReqs");
        if (storyReqs && !native(storyReqs, "storyReqs")) {
            /** @type {Map<number, XmlNode>} */
            const stories = new Map();
            for (const s of childs(storyReqs, "story")) {
                stories.set(num(s.attrs.num, `${name} story`), s);
            }
            fields.storyReqs = (storyNum) => {
                const s = stories.get(storyNum);
                return s ? evalConditionList(s.children, ctx) : false;
            };
        }

        // ---- effect slots (Phase 6) --------------------------------------
        // A slot compiles when its XML element carries data; otherwise the JS
        // body stays (the Phase-4 per-action increment, here per (action,
        // slot)). `this` inside a compiled body is the live Action, so
        // <skillExp/> reads the authoritative JS skills table.
        const bindCtx = function () { return { ...ctx, self: this, progress }; };

        // finish(): <reward>. The action `type` selects the wrapper, mirroring
        // how the JS bodies are structured — limited actions wrap their grants
        // in finishRegular(varName, oneInEvery, rewardFn). <before>/<after>
        // hold the effects that sit OUTSIDE that callback (Accept Donations
        // flags before it; Mana Well checks its ledger after it).
        // <progress> stays a DATA field; a <grantProgress/> marker inside the
        // reward body is what executes it (opt-in, because 13 actions carry
        // <progress> alongside a longer finish body that isn't modeled yet).
        const progress = child(def, "progress");
        const reward = child(def, "reward");
        if (reward && !native(reward, "finish") && reward.children.length) {
            const before = effectsOf(reward && child(reward, "before")?.children || []);
            const after = effectsOf(reward && child(reward, "after")?.children || []);
            const inner = effectsOf(reward?.children ?? []);
            // finishRegular accumulates lootFrom{var} += rewardFn(); several JS
            // bodies deliberately return nothing (lootFrom goes NaN — preserved,
            // not "fixed") and Gamble returns its unmodified base, so the ledger
            // amount is always EXPLICIT rather than inferred from the stacks.
            const ledger = reward && child(reward, "ledger");
            const run = (nodes, c) => { for (const n of nodes) execEffect(n, c, 1); };

            if (def.attrs.type === "limited") {
                const ratio = num(need("oneInEvery").text.trim(), `${name} oneInEvery`);
                fields.finish = function () {
                    const c = bindCtx.call(this);
                    run(before, c);
                    towns[townNum].finishRegular(varName, ratio, () => {
                        run(inner, c);
                        return ledger ? evalNumeric(ledger, c) ?? undefined : undefined;
                    });
                    run(after, c);
                };
            } else {
                fields.finish = function () {
                    const c = bindCtx.call(this);
                    run(before, c); run(inner, c); run(after, c);
                };
            }
        }

        // segmentFinished / loopsFinished / floorReward: the multipart slots.
        // All three are called with no arguments by actions.js, so the bodies
        // that read a loopCounter fall through to their default parameter —
        // the town counter, i.e. <loopCounter source="town"/>.
        for (const [tag, slot] of [["segmentReward", "segmentFinished"],
            ["loopReward", "loopsFinished"], ["floorReward", "floorReward"]]) {
            const el = child(def, tag);
            if (!el || native(el, slot) || !el.children.length) continue;
            const nodes = effectsOf(el.children);
            fields[slot] = function () {
                const c = bindCtx.call(this);
                for (const n of nodes) execEffect(n, c, 1);
            };
        }

        // story(completed): dispatched once per loop by actionStory, and only
        // when completed > 0. The count is exposed as <completed/>.
        const storyEffects = child(def, "storyEffects");
        if (storyEffects && !native(storyEffects, "story") && storyEffects.children.length) {
            const nodes = effectsOf(storyEffects.children);
            fields.story = function (completed) {
                const c = { ...bindCtx.call(this), completed };
                for (const n of nodes) execEffect(n, c, 1);
            };
        }

        // cost(): the <cost> deduction leg (the canStart affordability leg is
        // compiled above). deduction="none" = the element gates canStart only
        // and the deduction lives in finish() (Map buys its own map). An
        // explicit <deduction> replaces the stacks for the deduction leg alone
        // (Gather Team's cost() runs AFTER finish, so it reads the already
        // incremented teamMembers and must not re-add the +1 canStart needs).
        if (cost && !native(cost, "cost") && cost.attrs.deduction !== "none") {
            const ded = child(cost, "deduction");
            const nodes = effectsOf(ded ? ded.children : cost.children);
            if (nodes.length) {
                fields.cost = function () {
                    const c = bindCtx.call(this);
                    for (const n of nodes) execEffect(n, c, -1);
                };
            }
        }

        fields.__nativeFields = nativeFields;
        fields.__compiledSlots = SLOTS.filter(s => typeof fields[s] === "function");
        return fields;
    }

    /**
     * Compile every action in the document.
     * @param {string} xmlText
     * @returns {Record<string, Record<string, any>>} name -> compiled fields
     */
    function compileAll(xmlText) {
        const doc = parseDocument(xmlText);
        const out = {};
        for (const [name, def] of Object.entries(doc.actions)) {
            out[name] = compileAction(def, doc);
        }
        return out;
    }

    // ---- game-side wiring (options.useActionListXml) ---------------------
    // Overrides the compiled field closures onto the LIVE Action objects,
    // per-action, restorably. Only function-valued fields are overridden:
    // the data fields (stats, affectedBy, expMult, loopStats, segments, ...)
    // are value-identical by the differential gate and the JS objects stay
    // authoritative for them until cutover, which keeps object identity
    // stable for anything that might hold a reference. Incremental fallback:
    // an action absent from the XML, or one whose compile throws, keeps its
    // JS definition (with a console warning). The XML text arrives via the
    // generated data/actionListXml.data.js carrier — the sim boots
    // synchronously in three contexts (main window <script>, predictor-worker
    // and planner-worker importScripts) and none of them can load .xml
    // synchronously (regen: node test/regen-xml-carrier.mjs).

    /** @type {{action: object, saved: Record<string, PropertyDescriptor|undefined>}[] | null} */
    let overrideBackup = null;

    /**
     * @param {string} [xmlText]
     * @returns {{applied: number, total: number} | null} counts, or null if
     *   nothing could be applied (no carrier / parse failure)
     */
    function applyOverrides(xmlText = globalThis.actionListXmlText) {
        if (overrideBackup) return { applied: overrideBackup.length, total: overrideBackup.length };
        if (typeof xmlText !== "string") {
            console.error("actionListXml: no XML text available (data/actionListXml.data.js not loaded?)");
            return null;
        }
        let doc;
        try {
            doc = parseDocument(xmlText);
        } catch (e) {
            console.error("actionListXml: parse failed; keeping JS definitions", e);
            return null;
        }
        const byName = new Map();
        for (const prop in Action) {
            if (Action[prop] instanceof Action) byName.set(Action[prop].name, Action[prop]);
        }
        const backup = [];
        for (const name in doc.actions) {
            const action = byName.get(name);
            if (!action) {
                console.warn(`actionListXml: no JS action named "${name}"; skipping`);
                continue;
            }
            let fields;
            try {
                fields = compileAction(doc.actions[name], doc);
            } catch (e) {
                console.warn(`actionListXml: compile failed for "${name}"; keeping JS`, e);
                continue;
            }
            /** @type {Record<string, PropertyDescriptor|undefined>} */
            const saved = { __proto__: null };
            for (const [key, value] of Object.entries(fields)) {
                if (typeof value !== "function") continue;
                saved[key] = Object.getOwnPropertyDescriptor(action, key);
                Object.defineProperty(action, key, { value, writable: true, configurable: true, enumerable: true });
            }
            backup.push({ action, saved });
        }
        overrideBackup = backup;
        return { applied: backup.length, total: Object.keys(doc.actions).length };
    }

    function revertOverrides() {
        if (!overrideBackup) return;
        for (const { action, saved } of overrideBackup) {
            for (const key in saved) {
                if (saved[key]) Object.defineProperty(action, key, saved[key]);
                else delete action[key];
            }
        }
        overrideBackup = null;
    }

    return { SLOTS, parseDocument, compileAction, compileAll, applyOverrides, revertOverrides,
        setAwardSchedule, onLoopRestart, setForeignAwardHook,
        handlesLoot, lootFinishRegular, setLootPriority, getLootView,
        getAwardSchedule: () => awardSchedule };
})();
