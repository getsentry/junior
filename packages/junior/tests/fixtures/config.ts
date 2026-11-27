import { onTestFinished } from "vitest";
import {
  getChatConfig,
  installChatConfig,
  type ChatConfig,
} from "@/chat/config";
import { loadConfig, type ConfigInput } from "@/config";
import type { Env } from "@/config/fields";
import { SUITE_EXPERIMENTAL } from "./experimental-setup";

/**
 * Install config for the current test, resolved like createApp does: options
 * over `process.env` over defaults. The previous config comes back when the
 * test ends, so tests set config without writing env or mutating `botConfig`.
 * `env` sets or unsets vars over `process.env`, for tests of env parsing.
 * Experimental features default to the suite's.
 */
export function useConfig(options: ConfigInput = {}, env: Env = {}): void {
  const previous = installChatConfig(
    loadConfig({
      env: { ...process.env, ...env },
      options: { experimental: SUITE_EXPERIMENTAL, ...options },
    }),
  );
  onTestFinished(() => {
    installChatConfig(previous);
  });
}

/**
 * Replace groups of the installed config for the current test, for example
 * after createApp installed its own. The previous config comes back when the
 * test ends.
 */
export function patchConfig(patch: Partial<ChatConfig>): void {
  const previous = installChatConfig({ ...getChatConfig(), ...patch });
  onTestFinished(() => {
    installChatConfig(previous);
  });
}
