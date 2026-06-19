import { defineJuniorPlugin } from "@sentry/junior-plugin-api";

/** Create Junior's trusted long-term memory plugin registration. */
export function createMemoryPlugin() {
  return defineJuniorPlugin({
    database: {},
    manifest: {
      name: "memory",
      displayName: "Memory",
      description: "Long-term Junior memory storage and recall",
    },
    packageName: "@sentry/junior-memory",
  });
}

export const memoryPlugin = createMemoryPlugin();
