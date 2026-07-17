class Schema {
    // constants
    /** @readonly */ static XMLNS_RELAXNG = "http://relaxng.org/ns/structure/1.0";
    /** @readonly */ static XMLNS_RELAXNG_A = "http://relaxng.org/ns/compatibility/annotations/1.0";
    /** @readonly */ static XMLNS_IL = "http://dmchurch.github.io/omsi-loops/schema/1.0";

    // This object exposes functions to the XML schema's <function> element.
    // The *Bonus entries are fork wrappers: <function> must return a number.
    /** @readonly */ static get jsFunctions() {
        return this.#jsFunctions ??= {
            getExploreProgress,
            fullyExploredZones,
            totalAssassinations,
            getWizCollegeRankBonus: () => getWizCollegeRank().bonus,
            getCraftGuildRankBonus: () => getCraftGuildRank().bonus,
            getSelfCombat,
            getTeamCombat,
            minTalent: () => Math.min(...statList.map(s => getTalent(s))),
        };
    }
    static #jsFunctions;


    // well-known instances, should never be reassigned at runtime
    /** @readonly */ static actionList = new Schema("data/schema/actionList.rng");
    
    /** @param {string} url  */
    static async fetchXML(url) {
        const res = await fetch(url);
        const xmlText = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, "text/xml");
        console.log("Schema document", doc, doc.documentElement);
        return doc;
    };

    /** @type {XMLDocument} */
    schemaDocument;
    /** @type {Promise<XMLDocument>} */
    schemaPromise;
    /** @type {string} */
    schemaUrl;

    /** @type {SchemaGrammarNode} */
    grammar;

    /** @param {string} url  */
    constructor(url) {
        this.schemaUrl = url;
    }

    async fetchSchema() {
        if (this.schemaDocument) return this;

        this.schemaPromise ??= Schema.fetchXML(this.schemaUrl).then(d => this.schemaDocument = d);
        await this.schemaPromise;

        const grammar = this.schemaDocument.documentElement;
        if (grammar.getAttribute("xmlns") !== Schema.XMLNS_RELAXNG
            || grammar.getAttribute("xmlns:a") !== Schema.XMLNS_RELAXNG_A
            || grammar.getAttribute("xmlns:il") !== Schema.XMLNS_IL
            || grammar.nodeName !== "grammar") {
            throw new Error("Bad schema document");
        }

        this.grammar = new SchemaGrammarNode(grammar, null);

        return this;
    }
}

class SchemaNode extends DevtoolsFormattable {
    // this can't be a static field assignment because the child classes aren't defined yet
    static get tagMapping() {
        /** @type {Record<string, new(...args: any) => SchemaNode>} */
        const mapping = {
            element: SchemaElementNode,
            attribute: SchemaAttributeNode,
            zeroOrMore: SchemaRepetitionNode,
            oneOrMore: SchemaRepetitionNode,
            optional: SchemaRepetitionNode,
            text: SchemaDataValueNode,
            data: SchemaDataValueNode,
            value: SchemaDataValueNode,
            name: SchemaDataValueNode,
            choice: SchemaAlternativeNode,
            interleave: SchemaAlternativeNode,
            group: SchemaGroupNode,
            empty: SchemaEmptyNode,
            define: SchemaDefineNode,
            ref: SchemaRefNode,
        };
        SchemaNode.prototype.memoize.call(SchemaNode, "tagMapping", mapping);
        return mapping;
    }

    /** @template {SchemaNode} T @param {new(...args:any) => T} nodeType @returns {(node: SchemaNode) => node is T} */
    static is(nodeType) {
        /** @param {SchemaNode} node @returns {node is T} */
        return function nodeIsOfType(node) { return node instanceof nodeType; }
    }

    get schemaChildren() {
        /** @type {SchemaNode[]} */
        const children = [];
        /** @type {Element[]} */
        const elements = [];

        for (const child of this.xmlElement.children) {
            if (child.namespaceURI === Schema.XMLNS_RELAXNG) {
                children.push(new SchemaNode(child, this));
            } else {
                elements.push(child);
            }
        }

        this.memoize("nonSchemaChildren", elements);
        return this.memoize("schemaChildren", children);
    }

    /** @type {Element[]} */
    get nonSchemaChildren() {
        return (this.schemaChildren, this.nonSchemaChildren);
    }

    get treeChildren() {
        return this.schemaChildren;
    }

    get tagName() {
        return this.xmlElement?.tagName;
    }

    /** @type {SchemaNode} */
    parent;
    /** @type {Element} */
    xmlElement;
    /** @param {Element} xmlElement @param {SchemaNode} parent */
    constructor(xmlElement, parent) {
        super();
        if (Object.hasOwn(new.target, "tagMapping") && xmlElement.tagName in new.target.tagMapping) {
            return new new.target.tagMapping[xmlElement.tagName](xmlElement, parent);
        }
        this.parent = parent;
        this.xmlElement = xmlElement;
    }

    get [Symbol.toStringTag]() {
        return this.constructor.name;
    }

    get stringRepArgs() {
        const args = [this.tagName];
        const text = this.xmlElement.childElementCount === 0 ? this.xmlElement.textContent.trim() : "";
        if (text) args.push(JSON.stringify(text));
        return args;
    }

    toString() {
        return `${this.constructor.name}<${this.stringRepArgs.join(", ")}>`;
    }

    /** @returns {DTJHTML<this> | null} */
    dtHeader(cfg) {
        return ["div",
            {style: ""},
            ["span",
                {style: "font-weight:bold;"},
                this.toString(),
            ],
            ...this.dtAttributes(cfg),
            ["object", {object: this.xmlElement}],
        ];
    }

    /** @returns {DTJML<this>[]} */
    dtAttributes(cfg) {
        return [];
    }

    dtHasBody(cfg) {
        return true || this.treeChildren.length > 0 && false;
    }

    /** @returns {DTJHTML<this> | null} */
    dtBody(cfg) {
        return ["ol",
            ...this.treeChildren.map(/** @returns {DTJHTML} */n =>
            ["li",
                ["object", {object: n}]
            ]),
        ];
    }

    /**
     * @template {keyof this} K
     * @template {*} V
     * @param {K} property
     * @param {V} value 
     */
    memoize(property, value, writable = false) {
        if (Object.hasOwn(this, property)) {
            delete this[property];
        }
        Object.defineProperty(this, property, {value, writable, configurable: true, enumerable: true});
        return value;
    }

    /** 
     * @template {string} V
     * @param {keyof this} property
     */
    memoizeAttribute(property, {writable = false, attribute = String(property), allowedValues = /** @type {V[]} */(undefined)} = {}) {
        const value = /** @type {V} */(this.xmlElement.getAttribute(attribute));
        if (allowedValues && !allowedValues.includes(value)) {
            throw new Error(`Bad value for ${attribute}: "${value}" (expected one of: "${allowedValues?.join('", "')}")`);
        }
        return this.memoize(property, value, writable);
    }

    /** @param {string} name @returns {SchemaDefineNode} */
    getDefinition(name) {
        let node = this.parent;
        while (node) {
            if (node instanceof SchemaGrammarNode) {
                return node.getDefinition(name);
            }
            node = node.parent;
        }
    }

    /** @returns {Generator<SchemaNode>} */
    *walkTree() {
        yield this;
        for (const child of this.treeChildren) {
            yield *child.walkTree();
        }
    }

    /** @param {(node: SchemaNode, parent: SchemaNode) => void} callback @param {SchemaNode} [parent]  */
    visitTree(callback, parent) {
        callback(this, parent);
        for (const child of this.treeChildren) {
            child.visitTree(callback, this);
        }
        return this;
    }

    debugTree(parent, level=0, childIndex=0, childLength=1, prefix="                ") {
        if (level > 100) throw new Error("too much recursion");
        const leader = level === 0 ? ""
                     : childIndex === childLength - 1 ? "\\-- "
                     : "+-- ";
        const nextPrefix = `${prefix}${leader.replace(/[-\\]/g, " ").replace("+", "|")}`;
        if (this.treeChildren.length > 1) {
            console.group(`${prefix}${leader}${this}`, this.xmlElement, this);
            for (const [index, child] of this.treeChildren.entries()) {
                child.debugTree(this, level + 1, index, this.treeChildren.length, nextPrefix.slice(2));
            }
            console.groupEnd();
        } else {
            console.log(`${prefix}${leader}${this}`, this.xmlElement, this);
            for (const [index, child] of this.treeChildren.entries()) {
                child.debugTree(this, level + 1, index, this.treeChildren.length, nextPrefix);
            }
        }
    }
}

class SchemaGrammarNode extends SchemaNode {
    /** @type {SchemaElementNode} */
    get startElement() {
        const element = this.xmlElement.querySelector(":scope > start > element");
        if (!element) {
            throw new Error("Could not find start element");
        }
        return this.memoize("startElement", new SchemaElementNode(element, this));
    }

    get defines() {
        /** @type {Record<string, SchemaDefineNode>} */
        const defs = {__proto__: null};
        for (const defNode of this.schemaChildren.filter(SchemaNode.is(SchemaDefineNode))) {
            const { name, alternatives } = defNode;
            if (!name) {
                console.warn("Skipping define without name", defNode);
                continue;
            }
            if (defs[name]) {
                if (!defs[name].combine && defNode.combine) {
                    defs[name].combine = defNode.combine;
                }
                defs[name].alternatives.push(...alternatives);
            } else {
                defs[name] = defNode;
            }
        }
        return this.memoize("defines", defs);
    }

    /** @param {string} name  */
    getDefinition(name) {
        return this.defines[name] ?? super.getDefinition(name);
    }

    get treeChildren() {
        return this.memoize("treeChildren", [this.startElement, ...Object.values(this.defines)]);
    }
}

class SchemaAlternativeNode extends SchemaNode {
    /** @returns {"interleave" | "choice" | null} */
    get alternativeType() {
        if (this.tagName === "interleave") return "interleave";
        if (this.tagName === "choice") return "choice";
        throw new Error(`Unexpected SchemaAlternativeNode tagName: ${this.tagName}`);
    }

    get alternatives() {
        /** @type {SchemaNode[][]} */
        const alternatives = [];

        for (const child of this.schemaChildren) {
            if (child instanceof SchemaAlternativeNode && (child.tagName === this.tagName || child instanceof SchemaGroupNode)) {
                alternatives.push(...child.alternatives);
            } else {
                alternatives.push([child]);
            }
        }

        return this.memoize("alternatives", alternatives);
    }

    get treeChildren() {
        const children = [];
        for (const alt of this.alternatives) {
            if (alt.length === 1) {
                children.push(alt[0]);
            } else {
                const groupElement = this.xmlElement.ownerDocument.createElement("group");
                const group = new SchemaGroupNode(groupElement, this);
                group.alternatives[0] = alt;
                children.push(group);
            }
        }
        return this.memoize("treeChildren", children);
    }

    get stringRepArgs() {
        const args = super.stringRepArgs;
        if (this.alternatives.length > 1) {
            args.push(JSON.stringify(this.alternativeType));
        }
        return args;
    }

}

class SchemaGroupNode extends SchemaAlternativeNode {
    get alternativeType() {
        return null;
    }

    get alternatives() {
        return this.memoize("alternatives", [this.schemaChildren]);
    }

    get treeChildren() {
        return this.alternatives[0];
    }
}

class SchemaEmptyNode extends SchemaGroupNode {
}

class SchemaDefineNode extends SchemaAlternativeNode {
    get name() {return this.memoizeAttribute("name");}
    
    get combine() {return (this.memoizeAttribute("combine", {writable: true, allowedValues: ["choice", "interleave", null]}));}
    set combine(v) {this.memoize("combine", v, true);}
    get alternativeType() { return this.combine; }
    get alternatives() {
        if (this.schemaChildren.length === 1 && this.schemaChildren[0] instanceof SchemaAlternativeNode && this.schemaChildren[0].tagName === this.combine) {
            return this.memoize("alternatives", this.schemaChildren[0].alternatives);
        } else {
            return this.memoize("alternatives", [this.schemaChildren]);
        }
    }

    get stringRepArgs() {
        const args = super.stringRepArgs;
        args.splice(1, 0, JSON.stringify(this.name));
        return args;
    }
}

class SchemaRefNode extends SchemaAlternativeNode {
    get name() {return this.memoizeAttribute("name");}

    get definition() {
        return this.memoize("definition", this.getDefinition(this.name));
    }

    get alternativeType() {return this.definition.alternativeType;}
    get alternatives() {return this.definition.alternatives;}

    get treeChildren() {
        return [];
    }
}

class SchemaXMLComponent extends SchemaNode {
    get name() {
        if (this.xmlElement.hasAttribute("name")) {
            const nameElement = this.xmlElement.ownerDocument.createElement("name");
            nameElement.textContent = this.xmlElement.getAttribute("name");
            return this.memoize("name", new SchemaNode(nameElement, this));
        } else {
            return this.memoize("name", this.schemaChildren.shift());
        }
    }

    get schemaChildren() {
        super.schemaChildren;
        this.name;
        return this.schemaChildren;
    }

    get treeChildren() {
        return [this.name, ...this.schemaChildren];
    }
}

class SchemaElementNode extends SchemaXMLComponent {
}

class SchemaAttributeNode extends SchemaXMLComponent {
}

class SchemaDataValueNode extends SchemaNode {
    get type() {
        const {tagName} = this.xmlElement;
        return this.memoize("type", tagName === "data" ? this.xmlElement.getAttribute("type") ?? "string"
                                  : tagName === "value" ? this.xmlElement.getAttribute("type") ?? "token"
                                  : tagName === "name" ? "token"
                                  : tagName);
    }
}

class SchemaRepetitionNode extends SchemaNode {
    get minOccur() { return this.memoize("minOccur", this.tagName === "oneOrMore" ? 1 : 0); }
    get maxOccur() { return this.memoize("maxOccur", this.tagName === "optional" ?  1 : Infinity); }
}