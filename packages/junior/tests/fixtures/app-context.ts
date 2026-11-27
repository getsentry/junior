import { onTestFinished } from "vitest";
import {
  createAppContext,
  installAppContext,
  type AppContext,
} from "@/app/context";

/**
 * Install a fresh app context for the current test, built like createApp
 * builds it. The previous context comes back when the test ends, so tests set
 * plugins without mutating the installed context.
 */
export function useAppContext(
  input: Parameters<typeof createAppContext>[0] = {},
): AppContext {
  const context = createAppContext(input);
  const previous = installAppContext(context);
  onTestFinished(() => {
    installAppContext(previous);
  });
  return context;
}
