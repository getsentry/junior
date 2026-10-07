/**
 * Per-test recording session for eval suites without the agent fixture.
 *
 * The Guardian and turn router evals call the model directly. This setup
 * file sends the traffic of each test through the recording proxy as one
 * session, the same as `createFixtureAgent()` does for the other suites.
 */
import { beforeEach } from "vitest";
import { installRecordings } from "./fixture/recordings";

beforeEach(() => {
  installRecordings();
});
