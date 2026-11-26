import { onTestFinished } from "vitest";
import { installChatConfig } from "@/chat/config";
import { loadConfig, type ConfigInput } from "@/config";

/**
 * Install config for the current test, resolved like createApp does: options
 * over `process.env` over defaults. The previous config comes back when the
 * test ends, so tests set config without writing env or mutating `botConfig`.
 */
export function useConfig(options: ConfigInput = {}): void {
  const previous = installChatConfig(loadConfig({ env: process.env, options }));
  onTestFinished(() => {
    installChatConfig(previous);
  });
}
