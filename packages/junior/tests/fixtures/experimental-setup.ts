import { beforeEach } from "vitest";
import { setExperimentalFeatures } from "@/chat/experimental";

/**
 * Production leaves experimental features off. The suite opts in so coverage
 * exercises the real wiring path without an env flag.
 */
const SUITE_EXPERIMENTAL = {
  "passive-routing": true,
  subagents: true,
} as const;

setExperimentalFeatures(SUITE_EXPERIMENTAL);

beforeEach(() => {
  setExperimentalFeatures(SUITE_EXPERIMENTAL);
});
