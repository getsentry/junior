import { beforeEach } from "vitest";
import { setExperimentalFeatures } from "@/chat/experimental";

/**
 * Production leaves experimental features off. The suite opts in so coverage
 * exercises the real wiring path without an env flag.
 *
 * Isolated output-router evals call prepareAssistantReply directly and do not
 * use this file. Delivery wiring stays covered by full-runtime suites with
 * output-router left off unless a case opts in explicitly.
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
