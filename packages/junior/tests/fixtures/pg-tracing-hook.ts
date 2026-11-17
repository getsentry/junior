/**
 * Node `--import` hook for tests. It injects the `orchestrion:pg:*` tracing
 * channels into `pg` and `pg-pool`, as the Sentry build plugin does in a
 * production build. Sentry's Postgres integration makes database spans from
 * these channels, and `sql-budget.ts` counts statements from them.
 *
 * Node runs this file before Vitest starts, so it uses only Node type
 * stripping and package imports.
 */
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { SENTRY_INSTRUMENTATIONS } from "@sentry/server-utils/orchestrion/config";
import { createLoadHookTransform } from "@sentry/server-utils/orchestrion/load-hook";

const PG_MODULES = new Set(["pg", "pg-pool"]);

const transform = createLoadHookTransform({
  dcModule: "node:diagnostics_channel",
  instrumentations: SENTRY_INSTRUMENTATIONS.filter((config) =>
    PG_MODULES.has(config.module.name),
  ),
});

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith("file:") || result.source == null) return result;
    const code = transform(fileURLToPath(url), result.source.toString());
    return code === undefined ? result : { ...result, source: code };
  },
});
