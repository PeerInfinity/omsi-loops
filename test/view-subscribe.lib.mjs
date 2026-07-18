// test/view-subscribe.lib.mjs — boot a context with the REAL view loaded, so
// the view-subscribe tests exercise the shipped STATE_SUBSCRIPTIONS table, the
// shipped sink, and the shipped request queue rather than a copy of them.
//
// (A test that reimplemented the sink would share the implementation's
// assumptions and verify nothing.)

import fs from "node:fs";
import path from "node:path";
import { makeContext, ROOT } from "./harness.mjs";

/** Files that turn the headless sim context into one that also has the real View. */
export const VIEW_FILES = ["test/view-dom-stub.js", "uicomponents.js", "views/main.view.js"];

/**
 * Boot the sim + the real view.
 *
 * Note `view` (saving.js) is already bound to the harness's noop-proxy View by
 * the time main.view.js loads, and it is a `const`. That is fine and in fact
 * useful: tests construct their own real View, whose constructor claims the
 * stateChanged sink, so the only requests that land in its queue are the ones
 * the subscription table produced.
 */
export function makeViewContext(seed = 12345) {
    const ctx = makeContext(seed, VIEW_FILES);
    ctx.ev("var testView = new View()");
    ctx.requests = () => JSON.parse(ctx.ev(`JSON.stringify(testView.requests, (k, v) =>
        (v && typeof v === "object" && typeof v.varName === "string" && typeof v.name === "string")
            ? {"@action": v.name} : v)`));
    ctx.clearRequests = () => ctx.ev("for (const c in testView.requests) testView.requests[c] = []");
    /** category -> targets, dropping the empty categories */
    ctx.pendingRequests = () => Object.fromEntries(
        Object.entries(ctx.requests()).filter(([, targets]) => targets.length > 0));
    ctx.emit = (kind, key) => ctx.ev(`stateChanged(${JSON.stringify(kind)}, ${JSON.stringify(key ?? null)})`);
    return ctx;
}

/** actionList.js source with comments stripped — the criterion is about live code. */
export function actionListSourceWithoutComments() {
    const src = fs.readFileSync(path.join(ROOT, "actionList.js"), "utf8");
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => line.replace(/^(\s*)\/\/.*$/, "$1"))
        .join("\n");
}
