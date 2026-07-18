"use strict";

// Enough of a DOM for uicomponents.js + views/main.view.js to *load* in the
// Node vm harness. Load it as the first extraFile, before those two:
//
//   makeContext(seed, ["test/view-dom-stub.js", "uicomponents.js", "views/main.view.js"])
//
// This is a load-time stub only. main.view.js has a top-level block that walks
// actionOptionsTown0..8 and appends to each, and uicomponents.js defines custom
// elements in static initializers — both need real-looking objects at script
// evaluation time. Everything returns a permissive proxy, so render methods run
// without throwing but write nowhere; tests must assert on the request QUEUE
// (view.requests), never on DOM contents.
//
// Note the contrast with harness.mjs's `getElementById: () => null` stub, which
// is load-bearing for the tick path (Town.finishRegular probes searchToggler
// inputs and a truthy stub would change search-toggle semantics). Tests that
// need the sim's tick path back should restore the null stub after loading:
//
//   ctx.ev("document.getElementById = () => null");

// harness.mjs declares the element classes as unrelated `class {}` stubs, which
// is fine for the sim but not here: helpers.js getElement() gates on
// `instanceof`, so an input must also be an HTMLElement. Re-declare them as a
// real chain. Safe to do from this file because it loads after the sim files
// and only the view tests load it at all.
globalThis.Node = class Node {};
globalThis.Element = class Element extends globalThis.Node {};
globalThis.HTMLElement = class HTMLElement extends globalThis.Element {};
globalThis.HTMLInputElement = class HTMLInputElement extends globalThis.HTMLElement {};
globalThis.HTMLTextAreaElement = class HTMLTextAreaElement extends globalThis.HTMLElement {};
globalThis.HTMLSelectElement = class HTMLSelectElement extends globalThis.HTMLElement {};

globalThis.customElements = {
    define() {},
    get: () => undefined,
    whenDefined: () => Promise.resolve(),
    upgrade() {},
};

globalThis.HTMLDivElement = class extends HTMLElement {};
globalThis.HTMLSpanElement = class extends HTMLElement {};
globalThis.HTMLButtonElement = class extends HTMLElement {};
globalThis.HTMLCanvasElement = class extends HTMLElement {};
globalThis.HTMLLabelElement = class extends HTMLElement {};
globalThis.DocumentFragment = class {};
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
globalThis.CustomEvent = class extends Event {
    constructor(type, init) { super(type); this.detail = init?.detail; }
};

// The proxy target is a real HTMLInputElement instance, not a bare object:
// helpers.js getElement() gates on `element instanceof HTMLElement` (and
// HTMLInputElement for inputs) and THROWS otherwise, so a plain-object stub
// fails every htmlElement() call the render methods make.
const __stubElement = () => new Proxy(new HTMLInputElement(), {
    get(target, prop) {
        if (prop in target) return target[prop];
        switch (prop) {
            case "classList": return { add() {}, remove() {}, toggle() {}, contains: () => false };
            case "style": return { setProperty() {}, getPropertyValue: () => "", removeProperty() {} };
            case "textContent": case "value": case "innerHTML": case "id": case "className": return "";
            case "checked": case "disabled": case "hidden": return false;
            case "children": case "childNodes": return [];
            // element-list accessors must be iterable, not another stub
            case "querySelectorAll": case "getElementsByClassName": case "getElementsByTagName":
                return () => [];
            case "content": return __stubElement();
            case "parentElement": case "firstChild": case "nextSibling": return __stubElement();
            case Symbol.toPrimitive: case Symbol.iterator: return undefined;
            default: return () => __stubElement();
        }
    },
    set() { return true; },
});

document.getElementById = () => __stubElement();
document.createElement = () => __stubElement();
document.createTextNode = () => __stubElement();
document.createDocumentFragment = () => __stubElement();
document.querySelector = () => __stubElement();
document.querySelectorAll = () => [];
document.getElementsByClassName = () => [];
document.getElementsByTagName = () => [];
document.addEventListener = () => {};
document.removeEventListener = () => {};
document.body = __stubElement();
document.head = __stubElement();
