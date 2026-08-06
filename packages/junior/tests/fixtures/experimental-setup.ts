import { beforeEach } from "vitest";
import { setExperimentalFeatures } from "@/chat/experimental";

/**
 * Production leaves experimental features off. The suite opts in so
 * agent-invocation coverage exercises the real wiring path without an env flag.
 */
const SUITE_EXPERIMENTAL = { subagents: true } as const;

setExperimentalFeatures(SUITE_EXPERIMENTAL);

beforeEach(() => {
  setExperimentalFeatures(SUITE_EXPERIMENTAL);
});
