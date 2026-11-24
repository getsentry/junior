import type { PluginRegistration } from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import { FAN_OUT_CONCURRENCY } from "@/chat/fan-out";

/** The result of one plugin hook: its value, or the error it threw. */
export type PluginHookOutcome<T> =
  | { error: unknown; plugin: PluginRegistration }
  | { plugin: PluginRegistration; value: T };

/**
 * Run one hook of each plugin at once. `start` gives the call for a plugin,
 * or nothing when the plugin has no such hook. The outcomes keep plugin
 * order, so budgets and output order do not depend on which hook ends first.
 */
export async function runPluginHooksAtOnce<T>(
  plugins: readonly PluginRegistration[],
  start: (plugin: PluginRegistration) => (() => Promise<T> | T) | undefined,
): Promise<PluginHookOutcome<T>[]> {
  const limit = pLimit(FAN_OUT_CONCURRENCY);
  return await Promise.all(
    plugins.flatMap((plugin) => {
      const run = start(plugin);
      return run
        ? [
            limit(run).then(
              (value): PluginHookOutcome<T> => ({ plugin, value }),
              (error: unknown): PluginHookOutcome<T> => ({ error, plugin }),
            ),
          ]
        : [];
    }),
  );
}
