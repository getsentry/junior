import { beforeEach } from "vitest";
import { setExperimentalFeatures } from "@/chat/experimental";

/**
 * Production leaves experimental features off. The suite opts in so coverage
 * exercises the real wiring path without an env flag.
 */
export const SUITE_EXPERIMENTAL = {
  "output-router": false,
  "passive-routing": true,
  subagents: true,
} as const;

/** Re-apply suite experimental defaults after vi.resetModules(). */
export function restoreSuiteExperimentalFeatures(): void {
  setExperimentalFeatures(SUITE_EXPERIMENTAL);
}

restoreSuiteExperimentalFeatures();

beforeEach(() => {
  restoreSuiteExperimentalFeatures();
});
