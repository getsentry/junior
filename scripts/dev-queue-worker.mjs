// The local queue worker process that `scripts/dev-server.mjs` starts when
// `pnpm dev` uses the BullMQ queue. Nitro only sends jobs. This process
// creates the example app, pulls its jobs, and owns every connection it
// opens. The dev server passes the environment and restarts this process
// when the Junior build or the example app's runtime files change. If this
// process does not exit within 10 seconds of `SIGTERM`, the dev server kills it.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const exampleDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "example",
);

const { default: app } = await import(
  pathToFileURL(path.join(exampleDir, "server.ts")).href
);
const worker = await app.startQueueWorker();

let stopping = false;
async function stop(signal) {
  if (stopping) {
    // A second signal stops at once, without waiting for running jobs.
    process.exit(1);
  }
  stopping = true;
  try {
    await worker.close();
  } catch (error) {
    console.error(`Queue worker did not close cleanly (${signal}):`, error);
    process.exit(1);
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stop(signal);
  });
}
