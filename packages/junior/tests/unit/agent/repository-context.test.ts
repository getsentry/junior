import { describe, expect, it } from "vitest";
import {
  createRepositoryInstructionsContext,
  type AgentsInstructionsTransition,
} from "@/chat/agent/repository-context";
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
  it("emits loaded then replaced transitions when AGENTS.md changes", async () => {
    const transitions: AgentsInstructionsTransition[] = [];
    let current = instructions("v1", "Use pnpm.");
    const context = createRepositoryInstructionsContext({
      capture: async () => current,
      hasSandbox: () => true,
      onTransition: async (transition) => {
        transitions.push(transition);
      },
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
    await context.applyUpdate(undefined, {
      messages: [],
      systemPrompt: "system",
      tools: [],
    });

    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({
      action: "loaded",
      directory: "/vercel/sandbox/repo",
      fingerprint: "v1",
      sources: [
        {
          content: "Use pnpm.",
          path: "/vercel/sandbox/repo/AGENTS.md",
        },
      ],
    });
    expect(transitions[1]).toMatchObject({
      action: "replaced",
      fingerprint: "v2",
    });
  });

  it("emits cleared when repository instructions disappear", async () => {
    const transitions: AgentsInstructionsTransition[] = [];
    let current: RepositoryInstructions | undefined = instructions(
      "v1",
      "Use pnpm.",
    );
    const context = createRepositoryInstructionsContext({
      capture: async () => current,
      hasSandbox: () => true,
      onTransition: async (transition) => {
        transitions.push(transition);
      },
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
    await context.applyUpdate(undefined, {
      messages: [],
      systemPrompt: "system",
      tools: [],
    });

    expect(transitions.at(-1)).toEqual({
      action: "cleared",
      fingerprint: "cleared",
      sources: [],
    });
  });
});
