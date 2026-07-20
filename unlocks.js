"use strict";
// unlocks.js — the unlock table: ONE derivation of every action's
// visible()/unlocked() conditions from the structured <visible>/<unlocked>
// elements in data/actionList.xml.
//
// Why this file exists (unlock-discretization plan §1/§5):
//   the game gates 157 actions with hand-written closures. That is fine for
//   playing, but it makes the unlock conditions unreadable to anything else —
//   there is no way to enumerate "what can be unlocked", diff which unlocks
//   were newly achieved, or hand a location pool to Archipelago. The table
//   makes them data.
//
// Where the rows come from: the XML migration already moved the conditions
// into structured elements (compiled by actionListXml.js evalConditionList and
// proven equivalent to the JS closures by the field-matrix differential). So
// this module WALKS those elements rather than re-deriving anything — the XML
// is the single source, and the JS closures are the independent oracle the
// U0 verifier checks the walk against.
//
// Two consumers, one implementation:
//   - test/regen-unlock-table.mjs walks the XML and writes data/unlockTable.json
//     (the golden, and the artifact the AP side reads for its location pool).
//   - at runtime the same walk runs at boot off the XML carrier, and CI asserts
//     the derived rows are identical to the committed JSON.
//
// THE CLOSED-VOCABULARY RULE: any tag or attribute outside the mapping below
// is a HARD ERROR, never a skip. A silent skip would drop a real condition
// from the table and, downstream, hand Archipelago a location that is
// reachable under conditions nobody modelled. If the XML vocabulary grows,
// this file must grow with it deliberately.
const Unlocks = (() => {

    const err = (msg) => { throw new Error(`unlocks: ${msg}`); };

    // ---- numeric tests -----------------------------------------------------
    // The interpreter's testNumeric supports six comparison attributes; the
    // <visible>/<unlocked> elements use exactly three. The other three
    // (max/equals/notEquals) are unmapped ON PURPOSE — they would need a
    // monotonicity ruling before any row carrying one could become a location.
    const OPS = { min: "gte", minExclusive: "gt", maxExclusive: "ltExclusive" };
    // A clause is monotone when, within a prestige epoch, growing its dim can
    // only ever turn it ON. Upper bounds and inversions can turn a row back
    // OFF — such rows are never AP-eligible (plan §3.4, superseded registry).
    const MONOTONE_OPS = new Set(["gte", "gt"]);

    /**
     * Read the single numeric comparison off a condition node.
     * @param {string} where diagnostic label (action + predicate)
     * @param {string[]} ignore attributes that carry meaning other than a test
     */
    function readTest(node, where, ignore = []) {
        let op = null, level = null;
        for (const [k, v] of Object.entries(node.attrs)) {
            if (ignore.includes(k)) continue;
            if (!(k in OPS)) err(`${where}: unmapped attribute ${k}="${v}" on <${node.tag}> (closed vocabulary)`);
            if (op !== null) err(`${where}: <${node.tag}> carries more than one numeric test`);
            op = OPS[k];
            level = Number(v);
            if (!Number.isFinite(level)) err(`${where}: non-numeric ${k}="${v}" on <${node.tag}>`);
        }
        if (op === null) err(`${where}: <${node.tag}> carries no numeric test`);
        return { op, level };
    }

    /** boolean condition nodes: the only attribute they may carry is `inverted` */
    function readInverted(node, where, ignore = []) {
        for (const k of Object.keys(node.attrs)) {
            if (k === "inverted" || ignore.includes(k)) continue;
            err(`${where}: unmapped attribute ${k} on <${node.tag}> (closed vocabulary)`);
        }
        return node.attrs.inverted !== undefined;
    }

    const noChildren = (node, where) => {
        if (node.children.length) err(`${where}: <${node.tag}> has unexpected children`);
    };

    // ---- <if> : a numeric test over a base value ---------------------------
    // Shapes present in the tree (census 2026-07-19):
    //   <if min><skillLevel skillName/></if>                       -> skillLevel
    //   <if min><skillLevel/><addition><skillLevel/></addition></if> -> skillSum
    //   <if min><buffLevel buffName/></if>                         -> buffLevel
    //   <if min><function name="getExploreProgress"/></if>         -> exploreProgress
    //   <if min><globalValue name="storyMax"/></if>                -> storyMax
    function clauseFromIf(node, where) {
        const { op, level } = readTest(node, where);
        if (!node.children.length) err(`${where}: <if> without a base value`);
        const [base, ...rest] = node.children;

        // skill sums are a base <skillLevel> plus one <addition> per extra term
        if (base.tag === "skillLevel" && rest.length) {
            const vs = [readSkillName(base, where)];
            for (const add of rest) {
                if (add.tag !== "addition") err(`${where}: unmapped <${add.tag}> inside <if> (closed vocabulary)`);
                if (Object.keys(add.attrs).length) err(`${where}: unmapped attributes on <addition>`);
                if (add.children.length !== 1 || add.children[0].tag !== "skillLevel") {
                    err(`${where}: <addition> inside a predicate must hold exactly one <skillLevel>`);
                }
                vs.push(readSkillName(add.children[0], where));
            }
            return { kind: "skillSum", vs, op, level };
        }
        if (rest.length) err(`${where}: unmapped multi-term <if> over <${base.tag}> (closed vocabulary)`);

        switch (base.tag) {
            case "skillLevel":
                return { kind: "skillLevel", v: readSkillName(base, where), op, level };
            case "buffLevel": {
                noChildren(base, where);
                const v = base.attrs.buffName;
                if (!v) err(`${where}: <buffLevel> without buffName`);
                if (Object.keys(base.attrs).length !== 1) err(`${where}: unmapped attributes on <buffLevel>`);
                return { kind: "buffLevel", v, op, level };
            }
            case "function": {
                noChildren(base, where);
                // whitelist: the ONLY function a predicate may call. Anything
                // else would be an opaque dim the diff pass cannot index.
                if (base.attrs.name !== "getExploreProgress") {
                    err(`${where}: unmapped <function name="${base.attrs.name}"> (closed vocabulary)`);
                }
                if (Object.keys(base.attrs).length !== 1) err(`${where}: unmapped attributes on <function>`);
                return { kind: "exploreProgress", op, level };
            }
            case "globalValue": {
                noChildren(base, where);
                if (base.attrs.name !== "storyMax") {
                    err(`${where}: unmapped <globalValue name="${base.attrs.name}"> (closed vocabulary)`);
                }
                if (Object.keys(base.attrs).length !== 1) err(`${where}: unmapped attributes on <globalValue>`);
                return { kind: "storyMax", op, level };
            }
            default:
                err(`${where}: unmapped base value <${base.tag}> inside <if> (closed vocabulary)`);
        }
    }

    function readSkillName(node, where) {
        noChildren(node, where);
        const v = node.attrs.skillName;
        if (!v) err(`${where}: <skillLevel> without skillName`);
        if (Object.keys(node.attrs).length !== 1) err(`${where}: unmapped attributes on <skillLevel>`);
        return v;
    }

    // ---- one condition node -> one clause ----------------------------------
    function clauseFromNode(node, where, resolveTown) {
        switch (node.tag) {
            case "if":
                return clauseFromIf(node, where);
            case "ifProgress": {
                noChildren(node, where);
                const v = node.attrs.varName;
                if (!v) err(`${where}: <ifProgress> without varName`);
                const { op, level } = readTest(node, where, ["varName"]);
                // surveys are split out because they also feed the
                // exploreProgress aggregate, so randomization treats them
                // differently from a plain town progress var
                const kind = v.startsWith("SurveyZ") ? "surveyLevel" : "townLevel";
                return { kind, town: resolveTown(v, where), v, op, level };
            }
            case "ifStoryFlag": {
                noChildren(node, where);
                const v = node.attrs.storyFlagName;
                if (!v) err(`${where}: <ifStoryFlag> without storyFlagName`);
                const inverted = readInverted(node, where, ["storyFlagName"]);
                return inverted ? { kind: "storyFlag", v, inverted } : { kind: "storyFlag", v };
            }
            case "ifPrestige": {
                noChildren(node, where);
                const inverted = readInverted(node, where);
                const c = { kind: "prestige", v: "completedAnyPrestige" };
                return inverted ? { ...c, inverted } : c;
            }
            default:
                err(`${where}: unmapped condition <${node.tag}> in a predicate (closed vocabulary)`);
        }
    }

    const isMonotoneClause = (c) => !c.inverted && (c.op === undefined || MONOTONE_OPS.has(c.op));

    // ---- one <visible>/<unlocked> element -> one row -----------------------
    //
    // Shape rules, read off the tree rather than assumed:
    //   - an element's child list is an AND (evalConditionList semantics)
    //   - <anyOf> is an OR over its children; in this tree every <anyOf> is
    //     the SOLE child of its element, so a flat row shape is sufficient
    //     and no nesting is modelled (plan §3.1: do not add it speculatively)
    //   - <never> is the constant-false gate (Found Glasses)
    //   - an empty element is ALWAYS
    // A single-clause row is recorded as OR: OR and AND coincide at one
    // clause, and OR is what the 2026-07-11 probe extraction called it, which
    // keeps the two derivations directly comparable.
    function rowFromElement(el, { action, name, town, pred, resolveTown }) {
        const where = `${name}.${pred}`;
        const id = `${pred === "unlocked" ? "u" : "v"}:${action}`;
        const base = { id, action, name, town, pred };

        if (!el.children.length) return { ...base, mode: "ALWAYS", requires: [], monotone: true };

        if (el.children.some(c => c.tag === "never")) {
            if (el.children.length !== 1) err(`${where}: <never> must be the only condition`);
            noChildren(el.children[0], where);
            readInverted(el.children[0], where);
            return { ...base, mode: "NEVER", requires: [], monotone: true };
        }

        let mode, nodes;
        if (el.children.length === 1 && el.children[0].tag === "anyOf") {
            const anyOf = el.children[0];
            readInverted(anyOf, where);
            if (!anyOf.children.length) err(`${where}: empty <anyOf>`);
            if (anyOf.children.some(c => c.tag === "anyOf")) err(`${where}: nested <anyOf> is not modelled`);
            mode = "OR";
            nodes = anyOf.children;
        } else {
            if (el.children.some(c => c.tag === "anyOf")) {
                // would need a real AND-of-ORs row shape; the tree has none
                err(`${where}: <anyOf> mixed with sibling conditions is not modelled`);
            }
            nodes = el.children;
            mode = nodes.length > 1 ? "AND" : "OR";
        }

        const requires = nodes.map(n => clauseFromNode(n, where, resolveTown));
        return { ...base, mode, requires, monotone: requires.every(isMonotoneClause) };
    }

    // ---- the walk ----------------------------------------------------------
    /**
     * Walk every action's <visible>/<unlocked> into predicate rows.
     *
     * Uses ActionListXml.parseDocument for action selection rather than a
     * search of its own: <action name="X"/> also appears as a SELF-CLOSING
     * cross-reference inside <affectedBy>, and any naive descendant search
     * picks those up too (200 hits instead of 157). parseDocument takes only
     * direct children of <actions>, which is the correct set by construction.
     *
     * Identity (varName, townNum) comes from the LIVE Action objects, not from
     * the XML attributes: varName is save-format-load-bearing and 109 of the
     * 157 elements leave it implicit, so reading it off the XML would mean
     * re-deriving `withoutSpaces(name)` and silently diverging wherever an
     * action overrides it in its extras.
     *
     * @param {string} xmlText the actionList XML (carrier text or file bytes)
     * @param {object} resolvers
     * @param {(name: string) => {varName: string, town: number}} resolvers.actionMeta
     * @param {(progressVar: string, where: string) => number} resolvers.townOfProgressVar
     * @returns {object[]} predicate rows, action order, unlocked before visible
     */
    function walkPredicates(xmlText, { actionMeta, townOfProgressVar }) {
        const doc = ActionListXml.parseDocument(xmlText);
        const rows = [];
        for (const [name, def] of Object.entries(doc.actions)) {
            const meta = actionMeta(name);
            if (!meta) err(`${name}: <action> has no live Action object`);
            for (const pred of ["unlocked", "visible"]) {
                const el = def.children.filter(c => c.tag === pred);
                if (el.length !== 1) {
                    err(`${name}: expected exactly one <${pred}>, found ${el.length}`);
                }
                rows.push(rowFromElement(el[0], {
                    action: meta.varName, name, town: meta.town, pred,
                    resolveTown: townOfProgressVar,
                }));
            }
        }
        return rows;
    }

    // ---- quantity provenance ----------------------------------------------
    // <totalDiscovered> describes how a limited action's capacity is computed.
    // It is descriptive data the interpreter does not compile — the live
    // adjust*() functions remain authoritative. The walk takes only the
    // PROVENANCE from it: which progress vars drive the curve (the dims), and
    // which modifiers apply. The curve itself is measured by sweeping the
    // real JS, so the table's numbers never come from a re-implementation.
    //
    // It also takes <oneInEvery>, the checking-walk loot ratio (town.js
    // finishRegular yields loot on every N-th check). That ratio is the AP
    // batch size: one item = one full batch of N, one of which is guaranteed
    // to hold the loot. Declarative here, cross-checked against the JS call
    // sites by the generator — the two must agree or the table is describing
    // a pacing the game does not run.
    function walkQuantityDims(xmlText, { actionMeta }) {
        const doc = ActionListXml.parseDocument(xmlText);
        const out = [];
        for (const [name, def] of Object.entries(doc.actions)) {
            const el = def.children.filter(c => c.tag === "totalDiscovered");
            if (!el.length) continue;
            if (el.length !== 1) err(`${name}: more than one <totalDiscovered>`);
            const meta = actionMeta(name);
            if (!meta) err(`${name}: <action> has no live Action object`);
            const dims = [];
            const modifiers = [];
            const visit = (node) => {
                for (const c of node.children) {
                    if (c.tag === "progressLevel") {
                        if (!c.attrs.varName) err(`${name}: <progressLevel> without varName`);
                        if (!dims.includes(c.attrs.varName)) dims.push(c.attrs.varName);
                    } else if (c.tag === "skillMod") {
                        modifiers.push({ kind: "skillMod", v: c.attrs.name });
                    } else if (c.tag === "surveyBonus") {
                        modifiers.push({ kind: "surveyBonus" });
                    } else if (c.tag === "adjustment") {
                        modifiers.push({ kind: "adjustment", v: c.attrs.name });
                    }
                    visit(c);
                }
            };
            visit(el[0]);
            if (!dims.length) err(`${name}: <totalDiscovered> names no <progressLevel> dim`);
            const oieEl = def.children.filter(c => c.tag === "oneInEvery");
            if (oieEl.length !== 1) {
                err(`${name}: <totalDiscovered> requires exactly one <oneInEvery> (found ${oieEl.length})`);
            }
            const oneInEvery = Number(oieEl[0].text.trim());
            if (!Number.isInteger(oneInEvery) || oneInEvery < 1) {
                err(`${name}: <oneInEvery> must be a positive integer, got "${oieEl[0].text}"`);
            }
            out.push({ action: meta.varName, name, town: meta.town, dims, modifiers, oneInEvery });
        }
        return out;
    }

    // ---- live evaluation ---------------------------------------------------
    // Rows are evaluated live, never latched (plan §5.1): within a prestige
    // epoch every monotone row is live-equivalent to a latched one, and living
    // evaluation means prestige re-locking falls out for free instead of
    // needing wipe logic on every reset path — the exact class of bug the
    // JtA prestige defect was.

    function clauseValue(c) {
        switch (c.kind) {
            case "townLevel":
            case "surveyLevel":  return towns[c.town].getLevel(c.v);
            case "skillLevel":   return getSkillLevel(c.v);
            case "skillSum":     return c.vs.reduce((sum, v) => sum + getSkillLevel(v), 0);
            case "buffLevel":    return getBuffLevel(c.v);
            case "exploreProgress": return getExploreProgress();
            case "storyMax":     return storyMax;
            default: err(`clauseValue: non-numeric clause kind ${c.kind}`);
        }
    }

    function clauseSatisfied(c) {
        if (c.kind === "storyFlag") return !!storyFlags[c.v] !== !!c.inverted;
        if (c.kind === "prestige") return !!prestigeValues[c.v] !== !!c.inverted;
        const value = clauseValue(c);
        switch (c.op) {
            case "gte":         return value >= c.level;
            case "gt":          return value > c.level;
            case "ltExclusive": return value < c.level;
            default: err(`clauseSatisfied: unmapped op ${c.op}`);
        }
    }

    /** local satisfaction of a row, evaluated against live game state */
    function achievedNow(row) {
        switch (row.mode) {
            case "ALWAYS": return true;
            case "NEVER":  return false;
            case "OR":     return row.requires.some(clauseSatisfied);
            case "AND":    return row.requires.every(clauseSatisfied);
            default: err(`achievedNow: unmapped mode ${row.mode}`);
        }
    }

    // ---- the live row set --------------------------------------------------
    // Derived once, lazily, from the XML carrier.
    //
    // LAZY, not at script load: unlocks.js loads immediately after
    // actionList.js so it is in place before anything can call a predicate,
    // but `towns` is not built until town.js runs several files later, and the
    // walk needs it to resolve which town owns a progress var. Deriving on
    // first use sidesteps the load-order question in all four boot contexts
    // (page, both workers, harness) instead of encoding a fragile ordering.
    //
    // Rows never change during a run — the XML is static — so one derivation
    // per context is enough, and prestige needs no invalidation: relocking
    // happens because the DIMS reset, not because the rows do.
    let rows = null;
    let byAction = null;

    function build() {
        const meta = new Map();
        for (const a of totalActionList) meta.set(a.name, { varName: a.varName, town: a.townNum });
        const townOfProgressVar = (v, where) => {
            for (const t of towns) if (t.progressVars.includes(v)) return t.index;
            err(`${where}: no town owns progress var ${v}`);
        };
        if (typeof actionListXmlText !== "string") {
            // post-cutover there is no JS fallback to degrade to, so this is
            // fatal rather than a warning: every boot context loads the
            // carrier (data/actionListXml.data.js)
            err("no XML text available (data/actionListXml.data.js not loaded?)");
        }
        rows = walkPredicates(actionListXmlText, { actionMeta: (n) => meta.get(n), townOfProgressVar });
        byAction = new Map();
        for (const r of rows) {
            const entry = byAction.get(r.action) ?? {};
            entry[r.pred] = r;
            byAction.set(r.action, entry);
        }
        return rows;
    }

    const ensure = () => (rows ?? build());

    /** the row set, derived on first use */
    const getRows = () => ensure();

    /**
     * What visible()/unlocked() answer.
     *
     * `suppressed` and `granted` are the Archipelago overlay and are EMPTY in
     * vanilla play, so effective() reduces exactly to achievedNow() and the
     * game behaves identically — that inertness is what the byte-gate proves.
     * They are in-memory only: the one thing that must survive a save/load for
     * AP (which unlocks were granted) is host-authoritative and re-applied on
     * connect, so there is no new save field and vanilla saves stay
     * byte-identical.
     */
    const suppressed = new Set();
    const granted = new Set();

    function effective(row) {
        if (!row) err("effective: no row");
        return suppressed.has(row.id) ? granted.has(row.id) : achievedNow(row);
    }

    /** the predicate answer for one action, by varName */
    function predicate(varName, pred) {
        ensure();
        const entry = byAction.get(varName);
        if (!entry) err(`no unlock rows for action ${varName}`);
        return effective(entry[pred]);
    }

    return { walkPredicates, walkQuantityDims, isMonotoneClause, achievedNow,
             clauseSatisfied, effective, predicate, getRows, suppressed, granted,
             OPS, MONOTONE_OPS };
})();

if (typeof module !== "undefined") module.exports = Unlocks;
