import { beforeEach } from "vitest";
import type { ChatConfig } from "@/chat/config";
import type { loadConfig as LoadConfig } from "@/config";

/**
 * Production leaves experimental features off. The suite opts in so coverage
 * exercises the real wiring path without an env flag.
 */
export const SUITE_EXPERIMENTAL = {
  "passive-routing": true,
} as const;

// Like the config that `getChatConfig()` loads when nothing is installed, but
// with the suite's experimental features. It loads on the first read, so env
// that a test sets before that read still applies.
function lazySuiteConfig(loadConfig: typeof LoadConfig): ChatConfig {
  let config: ChatConfig | undefined;
  const load = (): ChatConfig =>
    (config ??= loadConfig({
      env: process.env,
      options: { experimental: SUITE_EXPERIMENTAL },
    }));
  return new Proxy({} as ChatConfig, {
    get: (_target, key) => load()[key as keyof ChatConfig],
    has: (_target, key) => key in load(),
    ownKeys: () => Object.keys(load()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(load(), key);
      return descriptor && { ...descriptor, configurable: true };
    },
  });
}

// Import at test time, so a test file's `vi.mock` of a config dependency
// applies to config too. A test file that mocks `@/chat/config` whole owns
// its config, and one whose mocks cannot load config does not read it.
beforeEach(async () => {
  const modules = await Promise.all([
    import("@/chat/config"),
    import("@/config"),
  ]).catch(() => undefined);
  if (!modules) return;
  const [chatConfig, { loadConfig }] = modules;
  if ("installChatConfig" in chatConfig) {
    chatConfig.installChatConfig(lazySuiteConfig(loadConfig));
  }
});
