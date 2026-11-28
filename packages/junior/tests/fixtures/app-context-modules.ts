import type { AppContext, AppContextInput } from "@/app/context";

/**
 * Load the app context modules that a dynamic import sees now, so a context
 * that `build` makes shares the test's `vi.doMock` calls, also after a module
 * reset. `build` makes it like createApp does, from the test's config, and
 * `install` puts it into that same module copy.
 */
export async function importAppContextModules(): Promise<{
  build: (input?: Partial<AppContextInput>) => AppContext;
  install: (context: AppContext | undefined) => AppContext | undefined;
}> {
  // Import one at a time: parallel imports can load a module that a test
  // mocks with an async `vi.doMock` factory before the mock.
  const { createAppContext, installAppContext } = await import("@/app/context");
  const { getChatConfig } = await import("@/chat/config");
  const { resolveAppPaths } = await import("@/chat/discovery");
  return {
    build: (input = {}) =>
      createAppContext({
        config: getChatConfig(),
        env: process.env,
        paths: resolveAppPaths(),
        ...input,
      }),
    install: installAppContext,
  };
}
