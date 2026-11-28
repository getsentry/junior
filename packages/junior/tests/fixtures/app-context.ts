import { onTestFinished } from "vitest";
import {
  createAppContext,
  installAppContext,
  type AppContext,
  type AppContextInput,
} from "@/app/context";
import { getChatConfig } from "@/chat/config";
import { resolveAppPaths } from "@/chat/discovery";
import { importAppContextModules } from "./app-context-modules";

/**
 * Install a fresh app context for the current test, built like createApp
 * builds it, from the test's config unless `input` gives one. The previous
 * context comes back when the test ends, and this one closes.
 */
export function useAppContext(
  input: Partial<AppContextInput> = {},
): AppContext {
  const context = createAppContext({
    config: getChatConfig(),
    env: process.env,
    paths: resolveAppPaths(),
    ...input,
  });
  const previous = installAppContext(context);
  onTestFinished(async () => {
    installAppContext(previous);
    await context.close();
  });
  return context;
}

/**
 * Install a fresh app context for the current test into the module copy that
 * dynamic imports see now. Use it after a module reset and `vi.doMock`, so
 * the context and the modules under test share the mocks.
 */
export async function useFreshAppContext(
  input: Partial<AppContextInput> = {},
): Promise<AppContext> {
  const { build, install } = await importAppContextModules();
  const context = build(input);
  const previous = install(context);
  onTestFinished(async () => {
    install(previous);
    await context.close();
  });
  return context;
}
