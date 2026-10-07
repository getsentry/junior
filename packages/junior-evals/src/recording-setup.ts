/**
 * Per-test recording sessions for every eval suite.
 *
 * Each test opens its session before its first request, so the recording
 * proxy also records requests that a test makes before it runs the agent,
 * such as embeddings for stored memories. Traffic outside a test uses the
 * proxy without a session.
 */
import { setGlobalDispatcher } from "undici";
import { beforeEach, inject } from "vitest";
import { installRecordings } from "./fixture/recordings";
import { createProxyDispatcher } from "./recording-run";

const proxy = inject("recordingProxy");
// The proxy variables of the run do not work for `fetch` without a session.
if (proxy) setGlobalDispatcher(createProxyDispatcher(proxy));

beforeEach(() => {
  installRecordings();
});
