import { beforeEach } from "vitest";
import { setExperimentalFeatures } from "@/chat/experimental";

/**
 * Production leaves experimental features off. Suites opt in so coverage
 * exercises the real wiring path without an env flag.
 *
 * Full-runtime eval suites can enable the prepare path with
 * `JUNIOR_EVAL_OUTPUT_ROUTER=1` before this setup file loads.
 */
export const SUITE_EXPERIMENTAL = {
  "output-router": process.env.JUNIOR_EVAL_OUTPUT_ROUTER === "1",
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
