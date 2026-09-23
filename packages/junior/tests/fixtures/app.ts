import { createApp, type JuniorAppOptions } from "@/app";

/**
 * Build the production app for tests that run Turns.
 *
 * Memory adds recall and extraction model calls to every Turn, so it stays off
 * unless a test passes `memory`. Tests about `createApp()` itself call it
 * directly.
 */
export async function createTestApp(
  options: JuniorAppOptions = {},
): ReturnType<typeof createApp> {
  return await createApp({
    ...options,
    memory: options.memory ?? { enabled: false },
  });
}
