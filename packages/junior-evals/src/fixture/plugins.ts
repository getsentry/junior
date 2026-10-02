/**
 * Plugin sets for `agent({ plugins })`. Tests that run the agent do not
 * import plugin packages, so the fixture builds the set that evals install.
 */
import { defineJuniorPlugins, type JuniorPluginSet } from "@/plugins";
import { evalRuntimePlugins } from "../eval-plugin-fixtures";

/** A plugin package that agent tests can install. */
export type EvalPluginPackage =
  | "@sentry/junior-github"
  | "@sentry/junior-memory"
  | "@sentry/junior-sentry";

/** Install these plugin packages with the eval GitHub App and OAuth clients. */
export function evalPlugins(packages: EvalPluginPackage[]): JuniorPluginSet {
  return defineJuniorPlugins(evalRuntimePlugins(packages));
}
