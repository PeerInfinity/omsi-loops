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
        "currentFloor"]);
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
    // post-Phase-6 carrier consults an award schedule here to route a grant
    // local | foreign | dummy. Phase 6 lands the seam with zero state and
    // zero behavior change — no schedule ⇒ the dispatcher IS today's direct
    // call, which is what keeps the option byte-inert.

    /**
     * The single grant site.
     * @param {object} action  the live Action (grant attribution)
     * @param {string} name    resource name; "mana" is the loop-budget pseudo-resource
     * @param {number|boolean} amount
     * @returns {number|boolean} the amount granted (finishRegular's ledger value)
     */
    function grantResource(action, name, amount) {
        if (name === "mana") addMana(/** @type {number} */(amount));
        else addResource(name, amount);
        return amount;
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
        "guildSegmentIncrement", "buff", "addTrainingLimit", "noEffect", "effect"]);

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
                grantResource(ctx.self, node.attrs.name, sign > 0);
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

    return { SLOTS, parseDocument, compileAction, compileAll, applyOverrides, revertOverrides };
})();
