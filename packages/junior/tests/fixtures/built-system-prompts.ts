import { vi } from "vitest";

/**
 * Mock `#junior/system-prompts` as a `juniorNitro()` build with no plugins
 * renders it. A test that mocks `#junior/config` acts as a build, and a build
 * has both modules, so it mocks this one too.
 */
export function mockBuiltSystemPrompts(botName = "junior"): void {
  vi.doMock("#junior/system-prompts", async () => {
    const { buildSystemPromptTable } =
      await import("@/chat/system-prompt-table");
    return { systemPrompts: await buildSystemPromptTable([], botName) };
  });
}
