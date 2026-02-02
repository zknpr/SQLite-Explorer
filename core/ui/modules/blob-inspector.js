export class BlobInspector {
    constructor(hostBridge) {
        this.hostBridge = hostBridge;
    }

    inspect(blobData, rowId, colName) {
        console.log("Inspecting blob", blobData.length);
    }
}
