/**
 * The recording session of each eval test.
 *
 * Global setup starts the recording proxy (`src/recording-run.ts`). The
 * proxy owns all reads and writes of recordings. This file only sends the
 * traffic of the worker through the proxy and tells the proxy when each
 * test starts and ends. The proxy writes the new recordings of a passed
 * test and drops those of a failed test, so a bad sample is never replayed.
 * The session opens before the first request of a test, so requests that a
 * test makes before it runs the agent, such as embeddings for stored
 * memories, are in it too.
 */
import { setGlobalDispatcher } from "undici";
import { afterAll, beforeEach, inject, onTestFinished } from "vitest";
import { installEvalAiGatewayDispatcher } from "./eval-ai-gateway-dispatcher";
import "./eval-context";
import { useGlobalDispatcherForFetch } from "./fetch-dispatcher";
import { connectRecordingProxy } from "./recording-proxy/client";
import { createProxyDispatcher } from "./recording-run";

const address = inject("recordingProxy");
if (address) {
  const proxy = connectRecordingProxy(address);
  // Node 24 already uses the proxy variables for `fetch`. This also covers
  // an older Node. The AI Gateway timeouts wrap the proxy dispatcher.
  setGlobalDispatcher(createProxyDispatcher(address));
  afterAll(installEvalAiGatewayDispatcher());

  beforeEach(async ({ task }) => {
    // MSW replaces `fetch` before each test file, so this runs after it.
    useGlobalDispatcherForFetch();
    await proxy.startSession(task.fullName);
    onTestFinished(async ({ task: finished }) => {
      await proxy.endSession(finished.result?.state === "pass");
    });
  });
}
