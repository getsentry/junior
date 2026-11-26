import { onTestFinished } from "vitest";
import { installChatConfig } from "@/chat/config";
import { loadConfig, type ConfigInput } from "@/config";
import type { Env } from "@/config/fields";

/**
 * Install config for the current test, resolved like createApp does: options
 * over `process.env` over defaults. The previous config comes back when the
 * test ends, so tests set config without writing env or mutating `botConfig`.
 * `env` sets or unsets vars over `process.env`, for tests of env parsing.
 */
export function useConfig(options: ConfigInput = {}, env: Env = {}): void {
  const previous = installChatConfig(
    loadConfig({ env: { ...process.env, ...env }, options }),
  );
  onTestFinished(() => {
    installChatConfig(previous);
  });
}
