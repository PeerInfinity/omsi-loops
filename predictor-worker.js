importScripts(
    "data.js",
    "localization.js",
    "helpers.js",
    "actionList.js",
    "xmlLite.js",
    "actionListXml.js",
    "data/actionListXml.data.js",
    "unlocks.js",
    "driver.js",
    "stats.js",
    "actions.js",
    "town.js",
    "prestige.js",
    "saving.js",
    "predictor.js"
);

/**
 * @typedef {{
 *  type: "setOptions",
 *  options: typeof options,
 * } | {
 *  type: "verifyDefaultIds",
 *  idRefs: SnapshotIdMap,
 * } | {
 *  type: "importSnapshots",
 *  snapshotExports: SnapshotExport[],
 *  resetToDefaults?: boolean,
 * } | {
 *  type: "startUpdate",
 *  runData: PredictorRunData,
 *  snapshotHeritage: number[],
 * }} MessageToPredictor 
 * 
 * @typedef {{
 *  type: "error",
 *  message: string,
 * } | {
 *  type: "getSnapshots",
 *  snapshotIds: number[],
 * } | {
 *  type: "update",
 *  id: number,
 *  i: number,
 *  state: PredictorRunState,
 *  isValid: boolean,
 * } | {
 *  type: "endUpdate",
 *  id: number,
 *  runData: PredictorRunData,
 * }} MessageFromPredictor
 */

console.log("starting predictor worker");

loadDefaults();

const predictor = Koviko.initWorkerPredictor();
/** @type {MessageToPredictor} */
let queuedUpdate;

/** @param {MessageEvent<MessageToPredictor>} e */
onmessage = e => {
    const {data} = e;
    // console.log("Got message:", data);
    handleMessage(data);
}
/** @param {MessageToPredictor} data */
function handleMessage(data) {
    /** @type {(message: MessageFromPredictor) => void} */
    const postMessage = self.postMessage;

    if (!data?.type) {
        console.error("Unexpected message, no type:", data);
        return;
    }
    
    switch (data.type) {
        // case "loadSave":
        //     console.log("loading save");
        //     doLoad(data.save);
        //     console.log("loaded save");
        //     break;
        case "setOptions":
            predictor.setOptions(data.options);
            // fork: mirror the main window's XML-actions option in this
            // context (apply/revert is idempotent)
            if (data.options.useActionListXml) ActionListXml.applyOverrides();
            else ActionListXml.revertOverrides();
            // fork: P2 transport (cross-game P2-A) — install the world data
            // (award schedule + lootable priority prefs) so this context sims
            // the world that actually exists. Stateless per message: a null
            // worldConfig clears a previously installed one. Runs AFTER the
            // option mirror on purpose: installing a schedule flips
            // useActionListXml ON itself (the carrier lives inside the compiled
            // reward path), and that flip must be the last word — the mirror
            // would otherwise revert the very path the schedule needs.
            if (!ActionListXml.installWorldConfig(data.worldConfig ?? null)) {
                console.warn("predictor-worker: worldConfig rejected; sim runs the vanilla world");
            }
            // console.debug("set options");
            break;
        case "verifyDefaultIds":
            if (!Data.verifyDefaultIds(data.idRefs)) {
                postMessage({type: "error", message: "default id verification failed"});
            }
            // console.debug("default ids verified");
            break;
        case "importSnapshots":
            if (data.resetToDefaults) {
                // when the main thread has reason to believe that none of the cached snapshots will be useful
                // anymore, it will send resetToDefaults to clear Data.snapshotStack.
                Data.resetToDefaults();
            }
            const {snapshotExports} = data;
            let loadCount = 0;
            try {
                for (const exportToLoad of snapshotExports) {
                    if (Data.getSnapshotIndex({id: exportToLoad.id}) >= 0) {
                        // already loaded, skip
                        console.debug(`Already loaded snapshot ${exportToLoad.id}`)
                        continue;
                    }
                    // console.debug(`importing snapshot ${exportToLoad.id}`);
                    Data.importSnapshot(exportToLoad);
                    loadCount++;
                }
            } catch (e) {
                if (e instanceof SnapshotMissingError) {
                    console.error(`missing snapshot ${e.id}?`, e);
                    postMessage({type: "error", message: e.message});
                } else {
                    postMessage({type: "error", message: e.toString()});
                }
                return;
            }
            // console.debug(`imported ${loadCount} snapshots of ${snapshotExports.length} provided`, snapshotExports);
            if (queuedUpdate) {
                // succeeded, go back into startUpdate
                const qu = queuedUpdate;
                queuedUpdate = undefined;
                handleMessage(qu);
            }
            break;
        case "startUpdate":
            const {runData, snapshotHeritage} = data;
            const id = snapshotHeritage.at(-1);
            if (Data.getSnapshotIndex({id}) >= 0) {
                // console.debug(`Loading snapshot ${id}`);
                Data.getSnapshot({id}).applyState();
                predictor.workerUpdate(runData);
                // console.debug("started update");
            } else {
                const requiredSnapshots = snapshotHeritage.filter(id => Data.getSnapshotIndex({id}) === -1);
                // console.debug(`Requesting ${requiredSnapshots.length} snapshots for heritage of length ${snapshotHeritage.length}: ${requiredSnapshots.join(", ")}`, snapshotHeritage);
                queuedUpdate = data;
                postMessage({type: "getSnapshots", snapshotIds: requiredSnapshots});
            }
            break;
    }
};