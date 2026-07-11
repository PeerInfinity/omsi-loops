// test/harness.mjs — headless Idle Loops sim boot for tests (Node vm, no
// browser, no dependencies).
//
// The sim/UI seam already exists in production: predictor-worker.js runs the
// full simulation in a Web Worker with no view layer, gated on
// `selfIsGame = typeof View !== "undefined"` (saving.js). This harness loads
// the exact same 11-file importScripts list into a Node vm context with ~40
// lines of stubs, giving tests a real, deterministic engine.
//
// Boot facts this encodes (each one bites if forgotten):
//   - stub View flips selfIsGame -> true so the sim wires itself up fully;
//   - getElementById -> null is load-bearing (Town.finishRegular probes
//     searchToggler inputs with throwIfMissing=false on every limited-action
//     completion; a truthy stub would change search-toggle semantics);
//   - story functions (setStoryFlag & co.) live in views/main.view.js, NOT in
//     the 11 sim files, but action story()/finish() hooks call them — shimmed;
//   - stonesUsed is initialized in load(), not loadDefaults() — without it the
//     four HaulZ* actions throw in canStart/storyReqs;
//   - townsUnlocked is [] after loadDefaults(); only load() defaults it to [0];
//   - Math.random is replaced with seeded mulberry32 and a consumption counter
//     (declarative fields consume zero RNG; reward paths need seeding).

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The exact importScripts list from predictor-worker.js (11 files).
export const SIM_FILES = ["data.js", "localization.js", "helpers.js", "actionList.js",
    "driver.js", "stats.js", "actions.js", "town.js", "prestige.js", "saving.js", "predictor.js"];

const noopProxy = () => new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) });

export function makeContext(seed = 12345) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
        $: Object.assign(() => ({ length: 0, find: () => ({ text: () => "" }), each() {} }), { get() {}, param() {} }),
        setTimeout, clearTimeout, setInterval, clearInterval, performance,
        structuredClone: (o) => JSON.parse(JSON.stringify(o ?? null)),
        View: class { constructor() { return noopProxy(); } },
        ActionLog: class { constructor() { return noopProxy(); } },
        GoogleCloud: class { constructor() { return noopProxy(); } },
        HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
        HTMLElement: class {}, Element: class {}, Node: class {},
        Event: class { constructor(type) { this.type = type; } },
        document: {
            title: "", getElementById: () => null, dispatchEvent: () => true,
            documentElement: { style: { setProperty() {}, getPropertyValue: () => "" }, classList: { toggle() {}, add() {}, remove() {} } },
        },
        requestAnimationFrame: () => 0,
        shiftDown: false, controlDown: false, altDown: false,
        localStorage: new (class {
            #m = new Map();
            getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
            setItem(k, v) { this.#m.set(k, String(v)); }
            removeItem(k) { this.#m.delete(k); }
        })(),
    };
    sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of SIM_FILES) {
        new vm.Script(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f })
            .runInContext(sandbox);
    }

    new vm.Script(`
        // Story-function shims (defined in views/main.view.js in the browser).
        function setStoryFlag(name) { storyFlags[name] = true; }
        var unlockStory = setStoryFlag;
        function increaseStoryVarTo(name, value) { if (storyVars[name] < value) storyVars[name] = value; }
        function unlockGlobalStory(num) { if (num > storyMax) storyMax = num; }

        function __setQueue(entries) {
            actions.clearActions();
            for (const [name, loops] of entries) actions.addAction(name, loops);
        }

        // One driver iteration (the executeGameTicks core). cap > 0 bounds the
        // mana spent per step.
        function __stepLoop(cap) {
            let manaAvailable = timeNeeded - timer;
            if (shouldRestart) manaAvailable = Math.min(manaAvailable, 1);
            if (cap > 0) manaAvailable = Math.min(manaAvailable, cap);
            const manaSpent = Mana.ceil(actions.tick(manaAvailable), timer / 1e15);
            timer += manaSpent;
            timeCounter += manaSpent / baseManaPerSecond;
            effectiveTime += manaSpent / baseManaPerSecond;
            refreshDungeons(manaSpent);
            let ended = false;
            if (shouldRestart || timer >= timeNeeded) {
                ended = true;
                loopEnd(); prepareRestart();
            } else if (manaSpent === 0) {
                throw new Error("step driver stalled: 0 mana spent, no restart");
            }
            return JSON.stringify({ spent: manaSpent, ended });
        }

        // Full-state snapshot for determinism checks.
        function __snapshot() {
            const townDump = towns.map(t => {
                const o = {};
                for (const v of t.allVarNames) {
                    for (const p of ["exp", "checked", "good", "goodTemp", "total"]) {
                        const k = p + v;
                        if (typeof t[k] === "number") o[k] = t[k];
                    }
                }
                return o;
            });
            return JSON.stringify({
                timer, timeNeeded, curTown, totals, resources, townsUnlocked,
                totalTalent, townDump,
                skillExp: Object.fromEntries(Object.entries(skills).map(([k, v]) => [k, v.exp ?? 0])),
                statExp: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, [v.exp ?? 0, v.talentLevelExp?.exp ?? 0]])),
                storyFlagsOn: Object.keys(storyFlags).filter(k => storyFlags[k]),
                storyMax,
            });
        }

        // Shape invariants for every action (save-format guard: varName is
        // load-bearing in player saves — see the Action constructor comment).
        function __actionShapes() {
            return JSON.stringify(totalActionList.map(a => {
                let allowed = null;
                try { allowed = a.allowed ? a.allowed() : null; } catch (e) { allowed = "throws:" + e.message; }
                return {
                    name: a.name, varName: a.varName ?? null, type: a.type ?? null,
                    townNum: a.townNum ?? null, expMult: a.expMult ?? null,
                    stats: a.stats ?? null, affectedBy: a.affectedBy ?? null,
                    allowed,
                };
            }));
        }
    `, { filename: "test-shims.js" }).runInContext(sandbox);

    const ev = (e) => vm.runInContext(e, sandbox);

    // Seeded mulberry32 with a consumption counter.
    const rng = { s: seed >>> 0, n: 0 };
    ev("Math").random = () => {
        rng.n++;
        rng.s = (rng.s + 0x6D2B79F5) >>> 0;
        let t = rng.s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    ev("loadDefaults()");
    ev("stonesUsed = {1:0, 3:0, 5:0, 6:0}");
    ev("if (!townsUnlocked.length) townsUnlocked = [0]");

    return {
        sandbox, ev,
        rngCount: () => rng.n,
        setQueue: (q) => sandbox.__setQueue(q),
        step: (cap) => JSON.parse(sandbox.__stepLoop(cap)),
        restart: () => ev("restart()"),
        snapshot: () => sandbox.__snapshot(),
        hash: () => crypto.createHash("sha256").update(sandbox.__snapshot()).digest("hex").slice(0, 16),
        actionShapes: () => JSON.parse(sandbox.__actionShapes()),
    };
}
