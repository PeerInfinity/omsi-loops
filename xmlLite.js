// @ts-check
"use strict";

// xmlLite — a minimal, strict XML parser for the action-data files (fork
// addition; XML migration Phase 4).
//
// Why not DOMParser: the sim must parse data/actionList.xml in every
// environment it runs in — the browser page, the predictor/planner Workers,
// and the Node `vm` test harness. DOMParser exists only in the first. The
// repo has a zero-runtime-dependencies rule, so instead of shipping a parser
// library we parse the strict subset of XML the action data actually uses:
// elements, attributes, text, comments, CDATA, processing instructions, and
// the five predefined entities (plus numeric character references).
//
// Deliberately NOT supported (the editor emits none of these): DTDs,
// namespace resolution (prefixed names are kept verbatim, e.g. "xi:include"),
// entity definitions. Malformed input throws with an offset, never guesses —
// this parser feeds a differential gate, so silence would be worse than
// failure.
//
// Node shape (plain objects, JSON-safe):
//   { tag: string, attrs: {[name]: string}, children: XmlNode[], text: string }
// `text` is the concatenated direct text content (entity-decoded, original
// whitespace); `children` holds element nodes only, in document order.

/** @typedef {{tag: string, attrs: Record<string, string>, children: XmlNode[], text: string}} XmlNode */

const XmlLite = (() => {
    const NAME_RE = /[A-Za-z_:][\w.:-]*/y;
    const SPACE_RE = /\s*/y;

    /** @param {string} src @returns {XmlNode} the document element */
    function parse(src) {
        let pos = 0;
        const fail = (msg) => {
            const line = src.slice(0, pos).split("\n").length;
            throw new Error(`xmlLite: ${msg} at offset ${pos} (line ${line})`);
        };
        const skipSpace = () => { SPACE_RE.lastIndex = pos; pos = SPACE_RE.exec(src)[0].length + pos; };
        const readName = () => {
            NAME_RE.lastIndex = pos;
            const m = NAME_RE.exec(src);
            if (!m) fail("expected name");
            pos += m[0].length;
            return m[0];
        };
        const decode = (s) => s.replace(/&(#x?[0-9A-Fa-f]+|\w+);/g, (all, ent) => {
            if (ent[0] === "#") {
                const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
                if (!Number.isFinite(code)) fail(`bad character reference ${all}`);
                return String.fromCodePoint(code);
            }
            const known = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[ent];
            if (known === undefined) fail(`unknown entity ${all}`);
            return known;
        });

        // skip prolog, PIs, comments, doctype-less whitespace
        const skipMisc = () => {
            for (;;) {
                skipSpace();
                if (src.startsWith("<?", pos)) {
                    const end = src.indexOf("?>", pos);
                    if (end < 0) fail("unterminated processing instruction");
                    pos = end + 2;
                } else if (src.startsWith("<!--", pos)) {
                    const end = src.indexOf("-->", pos);
                    if (end < 0) fail("unterminated comment");
                    pos = end + 3;
                } else if (src.startsWith("<!DOCTYPE", pos)) {
                    fail("DTDs are not supported");
                } else {
                    return;
                }
            }
        };

        /** @returns {XmlNode} */
        const readElement = () => {
            if (src[pos] !== "<") fail("expected element");
            pos++;
            const tag = readName();
            /** @type {XmlNode} */
            const node = { tag, attrs: {}, children: [], text: "" };
            for (;;) {
                skipSpace();
                if (src.startsWith("/>", pos)) { pos += 2; return node; }
                if (src[pos] === ">") { pos++; break; }
                const attr = readName();
                skipSpace();
                if (src[pos] !== "=") fail(`expected = after attribute ${attr}`);
                pos++;
                skipSpace();
                const quote = src[pos];
                if (quote !== '"' && quote !== "'") fail(`expected quoted value for attribute ${attr}`);
                const end = src.indexOf(quote, pos + 1);
                if (end < 0) fail(`unterminated attribute ${attr}`);
                if (attr in node.attrs) fail(`duplicate attribute ${attr}`);
                node.attrs[attr] = decode(src.slice(pos + 1, end));
                pos = end + 1;
            }
            // content
            for (;;) {
                if (pos >= src.length) fail(`unterminated element <${tag}>`);
                if (src.startsWith("</", pos)) {
                    pos += 2;
                    const closing = readName();
                    if (closing !== tag) fail(`mismatched </${closing}>, expected </${tag}>`);
                    skipSpace();
                    if (src[pos] !== ">") fail(`malformed </${closing}>`);
                    pos++;
                    return node;
                }
                if (src.startsWith("<!--", pos)) {
                    const end = src.indexOf("-->", pos);
                    if (end < 0) fail("unterminated comment");
                    pos = end + 3;
                } else if (src.startsWith("<![CDATA[", pos)) {
                    const end = src.indexOf("]]>", pos);
                    if (end < 0) fail("unterminated CDATA");
                    node.text += src.slice(pos + 9, end);
                    pos = end + 3;
                } else if (src.startsWith("<?", pos)) {
                    const end = src.indexOf("?>", pos);
                    if (end < 0) fail("unterminated processing instruction");
                    pos = end + 2;
                } else if (src[pos] === "<") {
                    node.children.push(readElement());
                } else {
                    let end = src.indexOf("<", pos);
                    if (end < 0) end = src.length;
                    node.text += decode(src.slice(pos, end));
                    pos = end;
                }
            }
        };

        skipMisc();
        const root = readElement();
        skipMisc();
        if (pos !== src.length) fail("content after document element");
        return root;
    }

    return { parse };
})();
