import { defineJuniorPlugin } from "@sentry/junior-plugin-api";

export * from "@sentry/junior/memory";
export type { MemoryOptions as MemoryPluginOptions } from "@sentry/junior/memory";

/**
 * Keep old app plugin sets valid while Memory runs in core.
 *
 * @deprecated Remove this registration and configure `createApp({ memory })`.
 */
export function memoryPlugin(
  options: import("@sentry/junior/memory").MemoryOptions = {},
) {
  return Object.assign(
    defineJuniorPlugin({
      manifest: {
        name: "memory",
        displayName: "Memory",
        description: "Compatibility marker for core Memory",
      },
      packageName: "@sentry/junior-memory",
    }),
    { coreMemoryOptions: { ...options } },
  );
}
