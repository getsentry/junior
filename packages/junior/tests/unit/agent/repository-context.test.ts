import { describe, expect, it } from "vitest";
import { createRepositoryInstructionsContext } from "@/chat/agent/repository-context";
import type { RepositoryInstructions } from "@/chat/repository-instructions";

const instructions = (
  fingerprint: string,
  text: string,
): RepositoryInstructions => ({
  directory: "/vercel/sandbox/repo",
  fingerprint,
  sources: [{ path: "/vercel/sandbox/repo/AGENTS.md", content: text }],
  text,
});

describe("createRepositoryInstructionsContext", () => {
  it("applies changed AGENTS.md instructions before the next sample", async () => {
    let current = instructions("v1", "Use pnpm.");
    const context = createRepositoryInstructionsContext({
      capture: async () => current,
      hasSandbox: () => true,
      promptContextContentParts: [],
      setMessages() {},
      shouldPromptAgent: true,
    });

    await context.applyUpdate(undefined, {
      messages: [],
      systemPrompt: "system",
      tools: [],
    });
    current = instructions("v2", "Use the new formatter.");
    const update = await context.applyUpdate(undefined, {
      messages: [],
      systemPrompt: "system",
      tools: [],
    });

    expect(JSON.stringify(update)).toContain("Use the new formatter.");
  });

  it("removes AGENTS.md instructions when repository context disappears", async () => {
    let current: RepositoryInstructions | undefined = instructions(
      "v1",
      "Use pnpm.",
    );
    const context = createRepositoryInstructionsContext({
      capture: async () => current,
      hasSandbox: () => true,
      promptContextContentParts: [],
      setMessages() {},
      shouldPromptAgent: true,
    });

    await context.applyUpdate(undefined, {
      messages: [],
      systemPrompt: "system",
      tools: [],
    });
    current = undefined;
    const update = await context.applyUpdate(undefined, {
      messages: [],
      systemPrompt: "system",
      tools: [],
    });

    expect(JSON.stringify(update)).toContain(
      "The previously provided AGENTS.md instructions no longer apply.",
    );
  });
});
