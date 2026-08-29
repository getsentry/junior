import { beforeEach } from "vitest";
import { setExperimentalFeatures } from "@/chat/experimental";

/**
 * Opt this suite into the visible-reply prepare path.
 * Other eval suites keep output-router off.
 */
const OUTPUT_ROUTER_SUITE_EXPERIMENTAL = {
  "output-router": true,
  "passive-routing": true,
  subagents: true,
} as const;

function restoreOutputRouterExperimentalFeatures(): void {
  setExperimentalFeatures(OUTPUT_ROUTER_SUITE_EXPERIMENTAL);
}

restoreOutputRouterExperimentalFeatures();

beforeEach(() => {
  restoreOutputRouterExperimentalFeatures();
});
