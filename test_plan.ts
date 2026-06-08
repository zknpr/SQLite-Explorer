import { ModificationTracker } from "./src/core/undo-history";

const tracker = new ModificationTracker<any>(1);
console.log((tracker as any).getCheckpointInvalidationRevision());
