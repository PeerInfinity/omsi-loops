"use strict";

// because I hate IE so much
/* eslint-disable max-statements-per-line */
Math.log2 = Math.log2 || function(x) { return Math.log(x) * Math.LOG2E; };
Math.log10 = Math.log10 || function(x) { return Math.log(x) * Math.LOG10E; };

//====================================================================================================
// View-subscribe seam
//====================================================================================================
// Sim files declare semantic state changes here ("skill X leveled", "soulstones
// changed"); the view owns the mapping from those facts onto its render-request
// queue (STATE_SUBSCRIPTIONS in views/main.view.js). This keeps view category
// names out of the sim — notably out of actionList.js, so XML-generated reward
// bodies can call the mutation funnels and get their display updates for free.
//
// Only the real View registers a sink, and views/main.view.js is never loaded by
// predictor-worker, planner-worker, or the Node harnesses. A null sink is a
// no-op by construction, so every view-less context is untouched.

/** @type {((kind: string, key: any) => void) | null} */
let stateChangedSink = null;

/**
 * Declare that a piece of game state changed.
 * @param {string} kind semantic category, e.g. "skill", "buff", "progress"
 * @param {any} [key] a name string, or a small payload object (see STATE_SUBSCRIPTIONS)
 */
function stateChanged(kind, key = null) {
    if (stateChangedSink) stateChangedSink(kind, key);
}

function round1(num) {
    return Math.floor(num * 10) / 10;
}
function round2(num) {
    return Math.floor(num * 100) / 100;
}

function precision2(num) {
    return Number(num.toPrecision(2));
}
function precision3(num) {
    return Number(num.toPrecision(3));
}
function precision4(num) {
    return Number(num.toPrecision(4));
}

function pxToInt(num) {
    return parseFloat(num.substring(0, num.indexOf("px")));
}

function round(num) {
    return formatNumber(num);
}

function formatNumber(num) {
    return Math.floor(num).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function formatTime(seconds) {
    if (seconds > 300) {
        let second = Math.floor(seconds%60);
        let minute = Math.floor(seconds/60%60);
        let hour = Math.floor(seconds/60/60%24);
        let day = Math.floor(seconds/60/60/24);
        
        let timeString = "";
        if(day > 0) timeString += (day + "d ");
        if(day > 0 || hour > 0) timeString += (hour + "h ");
        if(day > 0 || hour > 0 || minute > 0) timeString += (minute + "m ");
        timeString += (second + "s");
        
        return timeString;
    }
    if (Number.isInteger(seconds)) {
        return (formatNumber(seconds) + _txt("time_controls>seconds")).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
    }
    if (seconds < 10) {
        return seconds.toFixed(2) + _txt("time_controls>seconds");
    }
    return (seconds.toFixed(1) + _txt("time_controls>seconds")).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function copyArray(arr) {
    return JSON.parse(JSON.stringify(arr));
}

/** @type {<T>(obj: T) => T} */
function copyObject(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function withinDistance(x1, y1, x2, y2, radius) {
    return getDistance(x1, y1, x2, y2) < radius;
}

function getDistance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(Math.abs(x1 - x2), 2) + Math.pow(Math.abs(y1 - y2), 2));
}

function intToStringNegative(value, amount) {
    let isPositive = 1;
    if (value < 0) {
        isPositive = -1;
        value *= -1;
    }
    if (value >= 10000) {
        return (isPositive === 1 ? "+" : "-") + nFormatter(value, 3);
    }
    let baseValue = 3;
    if (amount) {
        baseValue = amount;
    }
    return (isPositive === 1 ? "+" : "-") + parseFloat(value).toFixed(baseValue - 1);
}

function intToString(value, amount, fixPrecision = false) {
    const prefix = value < 0 ? "-" : "";
    value = Math.abs(parseFloat(value));
    if (value >= 10000) {
        return prefix + nFormatter(value, 3, fixPrecision);
    }
    if (value >= 1000) {
        let baseValue = 3;
        if (amount) {
            baseValue = amount;
        }
        const returnVal = parseFloat(value).toFixed(baseValue - 1);
        return `${prefix}${returnVal[0]},${returnVal.substring(1)}`;
    }
    let baseValue = 3;
    if (amount) {
        baseValue = amount;
    }
    return prefix + parseFloat(value).toFixed(baseValue - 1);
}

function intToStringRound(value) {
    if (value >= 10000) {
        return nFormatter(value, 3);
    }
    return Math.floor(value);
}

function toSuffix(value) {
    value = Math.round(value);
    const suffixes = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "O", "N", "Dc", "Ud", "Dd", "Td", "qd", "Qd", "sd", "Sd", "Od", "Nd", "V"];
    const suffixNum = Math.floor(((String(value)).length - 1) / 3);
    const shortValue = parseFloat((suffixNum === 0 ? value : (value / Math.pow(1000, suffixNum))).toPrecision(3));
    const valueRepr = shortValue % 1 !== 0 ? shortValue.toPrecision(3) : shortValue.toString();
    return valueRepr + suffixes[suffixNum];
}

const Mana = {
    /** @param {number} value @param {number} [minNonZero] */
    ceil(value, minNonZero) {
        return value === 0 ? 0
                : !options.fractionalMana ? Math.ceil(value)
                : !minNonZero ? value
                : value > 0 ? Math.max(value, minNonZero)
                : Math.min(value, -minNonZero);
    },
    
    /** @param {number} value @param {number} [minNonZero] */
    floor(value, minNonZero) {
        return value === 0 ? 0
                : !options.fractionalMana ? Math.floor(value)
                : !minNonZero ? value
                : value > 0 ? Math.max(value, minNonZero)
                : Math.min(value, -minNonZero);
    },
    
    /** @param {number} value @param {number} [minNonZero] */
    round(value, minNonZero) {
        return value === 0 ? 0
                : !options.fractionalMana ? Math.round(value)
                : !minNonZero ? value
                : value > 0 ? Math.max(value, minNonZero)
                : Math.min(value, -minNonZero);
    },
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
    value = Math.max(value, min ?? -Infinity);
    value = Math.min(value, max ?? Infinity);
    return value;
}

const si = [
    { value: 1E63, symbol: "V" },
    { value: 1E60, symbol: "Nd" },
    { value: 1E57, symbol: "Od" },
    { value: 1E54, symbol: "Sd" },
    { value: 1E51, symbol: "sd" },
    { value: 1E48, symbol: "Qd" },
    { value: 1E45, symbol: "qd" },
    { value: 1E42, symbol: "Td" },
    { value: 1E39, symbol: "Dd" },
    { value: 1E36, symbol: "Ud" },
    { value: 1E33, symbol: "Dc" },
    { value: 1E30, symbol: "N" },
    { value: 1E27, symbol: "O" },
    { value: 1E24, symbol: "Sp" },
    { value: 1E21, symbol: "Sx" },
    { value: 1E18, symbol: "Qi" },
    { value: 1E15, symbol: "Qa" },
    { value: 1E12, symbol: "T" },
    { value: 1E9, symbol: "B" },
    { value: 1E6, symbol: "M" },
    { value: 1E3, symbol: "K" }
];
const rx = /\.0+$|(\.[0-9]*[1-9])0+$/u;

function nFormatter(num, digits, fixPrecision=false) {
    for (let i = 0; i < si.length; i++) {
        // /1.000501 to handle rounding
        if ((num) >= si[i].value / 1.000501) {
            // not the most elegant way to implement fixPrecision but whatever
            return (num / si[i].value).toPrecision(digits).replace(rx, fixPrecision ? "$&" : "$1") + si[i].symbol;
        }
    }
    return num.toPrecision(digits).replace(rx, fixPrecision ? "$&" : "$1");
}

function camelize(str) {
    return str.replace(/(?:^\w|[A-Z]|\b\w|\s+)/gu, (match, index) => {
        if (Number(match) === 0) return "";
        return index === 0 ? match.toLowerCase() : match.toUpperCase();
    });
}

function isVisible(obj) {
    return obj.offsetWidth > 0 && obj.offsetHeight > 0;
}

const factorials = [];
function factorial(n) {
    if (n === 0 || n === 1)
        return 1;
    if (factorials[n] > 0)
        return factorials[n];
    return factorials[n] = factorial(n - 1) * n;
}


const fibonaccis = [];
function fibonacci(n) {
    if (n === 0 || n === 1 || n === undefined)
        return 1;
    if (fibonaccis[n] > 0)
        return fibonaccis[n];
    return fibonaccis[n] = fibonacci(n - 1) + fibonacci(n - 2);
}

function sortArrayObjectsByValue(arr, valueName) {
    const n = arr.length;

    // one by one move boundary of unsorted subarray
    for (let i = 0; i < n - 1; i++) {
        // find the minimum element in unsorted array
        let minIdx = i;
        for (let j = i + 1; j < n; j++) {
            if (arr[j][valueName] < arr[minIdx][valueName])
                minIdx = j;
        }

        // swap the found minimum element with the first element
        const swap = arr[minIdx];
        arr[minIdx] = arr[i];
        arr[i] = swap;
    }
}

function addClassToDiv(div, className) {
    const arr = div.className.split(" ");
    if (arr.indexOf(className) === -1) {
        div.className += ` ${className}`;
    }
}

function removeClassFromDiv(div, className) {
    div.classList.remove(className);
}

const wrappedElementSymbol = Symbol("wrappedElement");

/**
 * @template {Element} [T=Element]
 * 
 * @param {string|Element} elementOrId 
 * @param {(new() => T)|((new() => T)[])} [expectedClass]
 * @param {boolean} [throwIfMissing] 
 * @param {boolean} [warnIfMissing] 
 * @returns {T}
 */
function getElement(elementOrId, expectedClass=/** @type {new()=>T} */(Element), throwIfMissing=true, warnIfMissing=true) {
    const expectedClasses = Array.isArray(expectedClass) ? expectedClass : [expectedClass];
    const element = typeof elementOrId === "string" ? document.getElementById(elementOrId) : elementOrId;
    for (const expected of expectedClasses) {
        if (element instanceof expected) return element;
    }
    if (element && wrappedElementSymbol in element) {
        // last try before bailing
        const wrappedResult = getElement(/** @type {Element}*/(element[wrappedElementSymbol]), expectedClasses, false, false);
        if (wrappedResult) return /** @type {T} */(element); // returning the wrapper so it can intercept IDL behaviors
    }
    if (warnIfMissing) {
        console.warn("Expected element missing or wrong type!", elementOrId, expectedClass, element);
    }
    if (throwIfMissing) {
        throw new Error(`Expected to find element of type ${expectedClasses.map(c=>c.name).join("|")} with ${elementOrId}, instead found ${element}!`);
    }
    return undefined;
}

/** @param {string|Element} elementOrId  */
function htmlElement(elementOrId, throwIfMissing=true, warnIfMissing=true) {
    return getElement(elementOrId, HTMLElement, throwIfMissing, warnIfMissing);
}

/** @param {string|Element} elementOrId  */
function inputElement(elementOrId, throwIfMissing=true, warnIfMissing=true) {
    return getElement(elementOrId, HTMLInputElement, throwIfMissing, warnIfMissing);
}

/** @param {string|Element} elementOrId  */
function textAreaElement(elementOrId, throwIfMissing=true, warnIfMissing=true) {
    return getElement(elementOrId, HTMLTextAreaElement, throwIfMissing, warnIfMissing);
}

/** @param {string|Element} elementOrId  */
function selectElement(elementOrId, throwIfMissing=true, warnIfMissing=true) {
    return getElement(elementOrId, HTMLSelectElement, throwIfMissing, warnIfMissing);
}

/** @typedef {HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement} HTMLValueElement */
/** @param {string|Element} elementOrId  */
function valueElement(elementOrId, throwIfMissing=true, warnIfMissing=true) {
    return getElement(elementOrId, [/** @type {new() => HTMLValueElement} */(HTMLInputElement), HTMLTextAreaElement, HTMLSelectElement], throwIfMissing, warnIfMissing);
}

/** @returns {node is HTMLValueElement} */
function isValueElement(node) {
    return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement;
}

/** @param {string|Element} elementOrId  */
function svgElement(elementOrId, throwIfMissing=true, warnIfMissing=true) {
    return getElement(elementOrId, SVGElement, throwIfMissing, warnIfMissing);
}

/** @param {string|Element} elementOrId  */
function templateElement(elementOrId, throwIfMissing=true, warnIfMissing=true) {
    return getElement(elementOrId, HTMLTemplateElement, throwIfMissing, warnIfMissing);
}

/** @overload @param {string|Element} templateOrId @param {boolean} [alwaysReturnFragment] @returns {Element | DocumentFragment} */
/** @overload @param {string|Element} templateOrId @param {true} alwaysReturnFragment @returns {DocumentFragment} */
/** @param {string} templateOrId */
function cloneTemplate(templateOrId, alwaysReturnFragment=false) {
    const template = templateElement(templateOrId);
    const fragment = /** @type {DocumentFragment} */(template.content.cloneNode(true));
    if (!alwaysReturnFragment && fragment.childElementCount === 1) {
        return fragment.firstElementChild;
    } else {
        return fragment;
    }
}

const numbers = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const tens = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

function number2Words(n) {
    if (n < 20) return numbers[n];
    const digit = n % 10;
    if (n < 100) return tens[~~(n / 10) - 2] + (digit ? `-${numbers[digit]}` : "");
    if (n < 1000) return `${numbers[~~(n / 100)]} hundred${n % 100 === 0 ? "" : ` ${number2Words(n % 100)}`}`;
    return `${number2Words(~~(n / 1000))} thousand${n % 1000 === 0 ? "" : ` ${number2Words(n % 1000)}`}`;
}

function capitalizeFirst(s) {
    return s.charAt(0).toUpperCase() + s.substr(1);
}

function numberToWords(n) {
    return capitalizeFirst(number2Words(n));
}

function encode(theSave) {
    return Base64.encode(LZWEncode(theSave));
}

function decode(encodedSave) {
    return LZWDecode(Base64.decode(encodedSave))
}

// lzw-compress a string
function LZWEncode(s) {
    const dict = {};
    const data = String(s).split("");
    const out = [];
    let phrase = data[0];
    let code = 256;
    for (let i = 1; i < data.length; i++) {
        const currChar = data[i];
        if (dict[phrase + currChar] === undefined) {
            out.push(phrase.length > 1 ? dict[phrase] : phrase.charCodeAt(0));
            dict[phrase + currChar] = code;
            code++;
            phrase = currChar;
        } else {
            phrase += currChar;
        }
    }
    out.push(phrase.length > 1 ? dict[phrase] : phrase.charCodeAt(0));
    for (let i = 0; i < out.length; i++) {
        out[i] = String.fromCharCode(out[i]);
    }
    return out.join("");
}

// decompress an LZW-encoded string
function LZWDecode(s) {
    const dict = {};
    const data = (String(s)).split("");
    let currChar = data[0];
    let oldPhrase = currChar;
    const out = [currChar];
    let code = 256;
    let phrase;
    for (let i = 1; i < data.length; i++) {
        const currCode = data[i].charCodeAt(0);
        if (currCode < 256) {
            phrase = data[i];
        } else {
            phrase = dict[currCode] ? dict[currCode] : (oldPhrase + currChar);
        }
        out.push(phrase);
        currChar = phrase.charAt(0);
        dict[code] = oldPhrase + currChar;
        code++;
        oldPhrase = phrase;
    }
    return out.join("");
}

const Base64 = {
    // private property
    _keyStr: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",

    // public method for encoding
    encode(input) {
        let output = "";
        let chr1, chr2, chr3, enc1, enc2, enc3, enc4;
        let i = 0;

        input = Base64.UTF8Encode(input);

        while (i < input.length) {
            chr1 = input.charCodeAt(i++);
            chr2 = input.charCodeAt(i++);
            chr3 = input.charCodeAt(i++);

            enc1 = chr1 >> 2;
            enc2 = ((chr1 & 3) << 4) | (chr2 >> 4);
            enc3 = ((chr2 & 15) << 2) | (chr3 >> 6);
            enc4 = chr3 & 63;

            if (isNaN(chr2)) {
                enc3 = 64;
                enc4 = 64;
            } else if (isNaN(chr3)) {
                enc4 = 64;
            }
            output = output +
                this._keyStr.charAt(enc1) + this._keyStr.charAt(enc2) +
                this._keyStr.charAt(enc3) + this._keyStr.charAt(enc4);
        }
        return output;
    },

    // public method for decoding
    decode(input) {
        let output = "";
        let chr1, chr2, chr3;
        let enc1, enc2, enc3, enc4;
        let i = 0;

        input = input.replace(/[^A-Za-z0-9\+\/\=]/g, "");

        while (i < input.length) {
            enc1 = this._keyStr.indexOf(input.charAt(i++));
            enc2 = this._keyStr.indexOf(input.charAt(i++));
            enc3 = this._keyStr.indexOf(input.charAt(i++));
            enc4 = this._keyStr.indexOf(input.charAt(i++));

            chr1 = (enc1 << 2) | (enc2 >> 4);
            chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
            chr3 = ((enc3 & 3) << 6) | enc4;

            output += String.fromCharCode(chr1);
            if (enc3 !== 64) {
                output += String.fromCharCode(chr2);
            }
            if (enc4 !== 64) {
                output += String.fromCharCode(chr3);
            }
        }
        output = Base64.UTF8Decode(output);
        return output;
    },

    // private method for UTF-8 encoding
    UTF8Encode(string) {
        string = string.replace(/\r\n/gu, "\n");
        let utftext = "";

        for (let n = 0; n < string.length; n++) {
            const c = string.charCodeAt(n);
            if (c < 128) {
                utftext += String.fromCharCode(c);
            } else if ((c > 127) && (c < 2048)) {
                utftext += String.fromCharCode((c >> 6) | 192);
                utftext += String.fromCharCode((c & 63) | 128);
            } else {
                utftext += String.fromCharCode((c >> 12) | 224);
                utftext += String.fromCharCode(((c >> 6) & 63) | 128);
                utftext += String.fromCharCode((c & 63) | 128);
            }
        }
        return utftext;
    },

    // private method for UTF-8 decoding
    UTF8Decode(utftext) {
        let string = "";
        let i = 0;
        let c = 0, c2 = 0;
        while (i < utftext.length) {
            c = utftext.charCodeAt(i);
            if (c < 128) {
                string += String.fromCharCode(c);
                i++;
            } else if ((c > 191) && (c < 224)) {
                c2 = utftext.charCodeAt(i + 1);
                string += String.fromCharCode(((c & 31) << 6) | (c2 & 63));
                i += 2;
            } else {
                c2 = utftext.charCodeAt(i + 1);
                const c3 = utftext.charCodeAt(i + 2);
                string += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
                i += 3;
            }
        }
        return string;
    }
};


function roughSizeOfObject(object) {

    const objectList = [];
    const stack = [object];
    let bytes = 0;

    while (stack.length) {
        const value = stack.pop();
        if (typeof value === "boolean") {
            bytes += 4;
        } else if (typeof value === "string") {
            bytes += value.length * 2;
        } else if (typeof value === "number") {
            bytes += 8;
        } else if (typeof value === "object" && objectList.indexOf(value) === -1) {
            objectList.push(value);
            for (const i in value) {
                stack.push(value[i]);
            }
        }
    }
    return bytes;
}

/** @type {(object: any, strings?: (string|number)[], map?: Record<string, number>) => any} */
function extractStrings(object, strings, map) {
    const isToplevel = strings == undefined;
    strings ??= [];
    map ??= {};
    function extract(v) {
        if (typeof v === "string" || typeof v === "number") {
            if (!(v in map)) {
                map[v] = strings.length;
                strings.push(v);
            }
            return map[v];
        }
        return extractStrings(v, strings, map);
    }
    if (object?.toJSON) object = object.toJSON();
    if (Array.isArray(object)) {
        const arr = [];
        for (const i in object) {
            arr[i] = extract(object[i]);
        }
        return isToplevel ? [strings, arr] : arr;
    } else if (object && typeof object === "object") {
        const exObj = {};
        for (const prop in object) {
            const idx = extract(prop);
            const v = extract(object[prop]);
            exObj[idx] = v;
        }
        return isToplevel ? {"": strings, ...exObj} : exObj;
    }
    return object;
}

/** @type {(object: any, strings?: (string|number)[]) => any} */
function restoreStrings(object, strings) {
    const isTopLevel = strings == undefined;
    if (isTopLevel) {
        if (Array.isArray(object)) {
            [strings, object] = object;
        } else {
            let {"": s, ...o} = object;
            strings = s;
            object = o;
        }
    }
    function restore(v) {
        if (typeof v === "string") v = parseInt(v);
        if (typeof v === "number") return strings[v];
        return restoreStrings(v, strings);
    }
    if (Array.isArray(object)) {
        const arr = [];
        for (const i in object) {
            arr[i] = restore(object[i]);
        }
        return arr;
    } else if (object && typeof object === "object") {
        const resObj = {};
        for (const prop in object) {
            const v = object[prop];
            resObj[restore(prop)] = restore(v);
        }
        return resObj;
    }
    return object;
}

async function delay(milliseconds) {
    await new Promise(r => setTimeout(r, milliseconds));    
}

/** @returns {Promise<DOMHighResTimeStamp>} */
function nextAnimationFrame() {
    /** @param {FrameRequestCallback} r */
    return new Promise(r => requestAnimationFrame(r));
}

/** @param {IdleRequestOptions} [idleRequestOptions] @returns {Promise<IdleDeadline>} */
function nextIdle(idleRequestOptions) {
    return new Promise(r => requestIdleCallback(r, idleRequestOptions));
}

// modified from: https://stackoverflow.com/questions/879152/how-do-i-make-javascript-beep/13194087#13194087
function beep(duration) {
    // @ts-ignore
    const ctxClass = window.audioContext || window.AudioContext || window.AudioContext || window.webkitAudioContext;
    const ctx = new ctxClass();
    const osc = ctx.createOscillator();

    // stop/start for new browsers, on/off for old
    osc.connect(ctx.destination);
    if (osc.noteOn) osc.noteOn(0);
    if (osc.start) osc.start();

    setTimeout(() => {
        if (osc.noteOff) osc.noteOff(0);
        if (osc.stop) osc.stop();
    }, duration);
}

function statistics() {
    let actionCount = 0;
    let actionWithStoryCount = 0;
    let multiPartActionCount = 0;
    let PBAActionCount = 0;
    let limitedActionCount = 0;
    let storyCount = 0;
    // let skillCount = 0;
    // let buffCount = 0;
    for (const action of totalActionList) {
        if (action.storyReqs !== undefined) {
            const name = action.name.toLowerCase().replace(/ /gu, "_");
            storyCount += _txt(`actions>${name}`, "fallback").split("⮀").length - 1;
            actionWithStoryCount++;
        }
        if (action.type === "progress") PBAActionCount++;
        else if (action.type === "limited") limitedActionCount++;
        else if (action.type === "multipart") multiPartActionCount++;
        actionCount++;
    }

    const list = 
`Actions: ${actionCount} (${actionWithStoryCount} with story)
 Multi part actions: ${multiPartActionCount}
 Progress based actions: ${PBAActionCount}
 Limited actions: ${limitedActionCount}
 Training actions: ${trainingActions.length}/9
 Stories: ${storyCount} (~${(storyCount / actionCount).toFixed(2)} avg per action)
 Skills: ${skillList.length}
 Buffs: ${buffList.length}`;
    return list;
}

const nullFunc = () => {};
function benchmark(func, iterations, returnTimeOnly) {
    const baseCost = (func === nullFunc && returnTimeOnly) ? 0 : benchmark(nullFunc, iterations, true);
    const before = performance.mark("benchmark-start");
    for (let i = 0; i < iterations; i++) {
        func();
    }
    const after = performance.mark("benchmark-end");
    const measure = performance.measure("benchmark", "benchmark-start", "benchmark-end");
    if (returnTimeOnly) return (measure.duration - baseCost);
    return `Total cost: ${measure.duration - baseCost}ms\n Cost per iteration: ~${(measure.duration - baseCost) / iterations}ms`;
}

// make a lazy getter for an object (most useful for prototypes), which executes the
// provided function once upon first attempting to get the property, and in the future has
// the computed result as an own property of the instance
// usage: defineLazyGetter(A.prototype, 'prop', function() { return ...; })
function defineLazyGetter(object, name, getter) {
    Object.defineProperty(object, name, {
        get() {
            if (Object.prototype.hasOwnProperty.call(this, name)) {
                // only used if this getter itself is own
                // otherwise, shadowing the property is enough
                delete this[name];
            }
            Object.defineProperty(this, name, {
                value: getter.call(this)
            });
            return this[name];
        },
        configurable: true,
    });
}

/** Strongly-typed version of Object.keys */
const typedKeys = /** @type {<K extends string|number|symbol>(object: Partial<Record<K, any>>) => K[]} */(Object.keys);

/** Strongly-typed version of Object.keys */
const typedEntries = /** @type {<K extends string|number|symbol, V>(object: Partial<Record<K, V>>) => [K, V][]} */(Object.entries);

const devtoolsHeader = Symbol.for("devtoolsHeader");
const devtoolsHasBody = Symbol.for("devtoolsHasBody");
const devtoolsBody = Symbol.for("devtoolsBody");

/**
 * Convenience class for defining devtools formatting 
 * @template {*} DTConfig
 */
class DevtoolsFormattable {
    /** @param {DTConfig} config @returns {DTJHTML<this, DTConfig> | null} */
    dtHeader(config) { return null; }
    /** @param {DTConfig} config */
    dtHasBody(config) { return false; }
    /** @param {DTConfig} config @returns {DTJHTML<this, DTConfig> | null} */
    dtBody(config) { return null; }

    [devtoolsHeader](config) {
        return this.dtHeader(config);
    }
    [devtoolsHasBody](config) {
        return this.dtHasBody(config);
    }
    [devtoolsBody](config) {
        return this.dtBody(config);
    }

    constructor() {
        new.target.addFormatter();
    }

    /** @type {DTFormatter} */
    static formatter = {
        header(object, config) {
            return object?.[devtoolsHeader]?.(config) ?? null;
        },
        hasBody(object, config) {
            return object?.[devtoolsHasBody]?.(config) ?? false;
        },
        body(object, config) {
            return object?.[devtoolsBody]?.(config) ?? null;
        }
    }

    static addFormatter() {
        self.devtoolsFormatters ??= [];
        if (!self.devtoolsFormatters.includes(this.formatter)) {
            self.devtoolsFormatters.push(this.formatter);
        }
    }
}

//Convenience class for rendering html template strings with syntax coloring
/** @satisfies {Record<string, (strings: TemplateStringsArray, ...exprs: any[]) => any>} */
const Raw = {
    html(strings, ...exprs) {
        let htmlString = String.raw(strings, ...exprs);
        if (strings.raw[0][0] === '\n' || strings.raw[0][0] === '\r') { // if this starts with an explicit linebreak, strip early whitespace
            htmlString = htmlString.trimStart();
        }
        return htmlString;
    },
    css(strings, ...exprs) {
        return String.raw(strings, ...exprs);
    },
}

