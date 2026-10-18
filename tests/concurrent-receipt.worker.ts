import { parseOptions } from "../src/options.js";
import { TrackerStore } from "../src/store.js";

type WorkerInput = {
  directory: string;
  sequence: number;
  barrier: SharedArrayBuffer;
};

(globalThis as any).onmessage = (event: MessageEvent<WorkerInput>) => {
  const store = TrackerStore.open(parseOptions({ dataDir: event.data.directory }));
  const control = new Int32Array(event.data.barrier);
  Atomics.add(control, 0, 1);
  (globalThis as any).postMessage({ type: "ready" });
  while (Atomics.load(control, 1) === 0) Atomics.wait(control, 1, 0);
  const result = store.closeExecution({
    eventID: `event-${event.data.sequence}`,
    aggregateID: "aggregate-1",
    sequence: event.data.sequence,
    sessionID: "session-1",
    outcome: "completed",
    endedAt: 200 + event.data.sequence,
  });
  store.close();
  (globalThis as any).postMessage({ type: "done", value: result });
};
