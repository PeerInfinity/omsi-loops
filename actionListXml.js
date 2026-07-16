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
//     is Phase 6; until then compiled actions keep the JS finish().
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

    const BASE_VALUE_TAGS = new Set(["skillLevel", "buffLevel", "talentLevel", "primaryValue",
        "progressLevel", "goodItems", "discoveredItems", "checkedItems", "value", "function",
        "resourceValue", "townValue", "globalValue"]);
    const CONDITIONAL_TAGS = new Set(["if", "ifCurrentValue", "ifResource", "ifHasResource",
        "ifStoryFlag", "ifProgress", "ifGoodItems", "ifDiscoveredItems", "ifCheckedItems",
        "ifPrestige", "ifTownUnlocked", "anyOf", "never"]);
    // whitelisted <function name="..."/> targets (mirrors schema.js / the rng)
    const FUNCTIONS = {
        getExploreProgress: () => getExploreProgress(),
    };
    // whitelisted <globalValue name="..."/> targets
    const GLOBALS = {
        trainingLimits: () => trainingLimits,
        goldInvested: () => goldInvested,
        storyMax: () => storyMax,
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
            case "ifResource":
                return testNumeric(node, Number(resources[node.attrs.resourceName] ?? 0) || (resources[node.attrs.resourceName] === true ? 1 : 0));
            case "ifHasResource":
                return !!resources[node.attrs.resourceName] !== inverted;
            case "ifStoryFlag":
                return !!storyFlags[node.attrs.storyFlagName] !== inverted;
            case "ifPrestige":   // fork schema extension: prestigeValues.completedAnyPrestige
                return !!prestigeValues.completedAnyPrestige !== inverted;
            case "ifTownUnlocked":   // fork schema extension: townsUnlocked membership
                return townsUnlocked.includes(num(node.attrs.townNum, "ifTownUnlocked")) !== inverted;
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
            case "buffLevel": return getBuffLevel(node.attrs.buffName);
            case "talentLevel": return getTalent(node.attrs.statName);
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
        const need = (tag) => {
            const c = child(def, tag);
            if (!c) throw new Error(`actionListXml: ${name} lacks required <${tag}>`);
            return c;
        };

        /** @type {Record<string, any>} */
        const fields = { name, varName, townNum, type: def.attrs.type };

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
        fields.manaCost = () => evalNumeric(effortCost, ctx);

        const primaryValue = child(def, "primaryValue");
        if (primaryValue) fields.goldCost = () => evalNumeric(primaryValue, ctx);

        const visible = need("visible");
        fields.visible = () => evalConditionList(visible.children, ctx);
        const unlocked = need("unlocked");
        fields.unlocked = () => evalConditionList(unlocked.children, ctx);

        const allowed = child(def, "allowed");
        if (allowed) fields.allowed = () => evalNumeric(allowed, ctx);

        // canStart: the explicit <canStart> conditions AND the affordability
        // implied by <cost> numeric resources (JS canStart bodies are the
        // affordability check)
        const canStart = child(def, "canStart");
        const cost = child(def, "cost");
        if (canStart || cost) {
            const costChecks = (cost?.children ?? [])
                .filter(c => c.tag === "numericResource" || c.tag === "booleanResource")
                .map(c => ({ kind: c.tag, resource: c.attrs.name, node: c }));
            fields.canStart = () => {
                for (const { kind, resource, node } of costChecks) {
                    if (kind === "booleanResource") {
                        if (!resources[resource]) return false;
                        continue;
                    }
                    const needAmount = evalNumeric(node, ctx);
                    if (needAmount === null || !(resources[resource] >= needAmount)) return false;
                }
                return canStart ? evalConditionList(canStart.children, ctx) : true;
            };
        }

        const storyReqs = child(def, "storyReqs");
        if (storyReqs) {
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

    return { parseDocument, compileAction, compileAll };
})();
