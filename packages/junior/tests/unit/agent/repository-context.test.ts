import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@/chat/sentry";
import { createRepositoryInstructionsContext } from "@/chat/agent/repository-context";
import type { PiMessage } from "@/chat/pi/messages";
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
    let messages: PiMessage[] = [];
    const context = createRepositoryInstructionsContext({
      capture: async () => current,
      commit: async () => {},
      hasSandbox: () => true,
      promptContextContentParts: [],
      promptHistoryMessages: [],
      setMessages(next) {
        messages = next;
      },
      shouldPromptAgent: true,
    });

    await context.applyUpdate([]);
    current = instructions("v2", "Use the new formatter.");
    const updated = await context.applyUpdate([]);

    expect(updated).toBe(true);
    expect(JSON.stringify(messages)).toContain("Use the new formatter.");
  });

  it("removes AGENTS.md instructions when repository context disappears", async () => {
    let current: RepositoryInstructions | undefined = instructions(
      "v1",
      "Use pnpm.",
    );
    let messages: PiMessage[] = [];
    const context = createRepositoryInstructionsContext({
      capture: async () => current,
      commit: async () => {},
      hasSandbox: () => true,
      promptContextContentParts: [],
      promptHistoryMessages: [],
      setMessages(next) {
        messages = next;
      },
      shouldPromptAgent: true,
    });

    await context.applyUpdate([]);
    current = undefined;
    const updated = await context.applyUpdate([]);

    expect(updated).toBe(true);
    expect(JSON.stringify(messages)).toContain(
      "The previously provided AGENTS.md instructions no longer apply.",
    );
  });

  describe("refresh telemetry", () => {
    const outcomes: unknown[] = [];
    let client: ReturnType<typeof Sentry.init>;

    beforeAll(() => {
      client = Sentry.init({
        dsn: "https://public@example.com/1",
        tracesSampleRate: 1,
        defaultIntegrations: false,
        transport: () => ({
          send: async () => ({ statusCode: 200 }),
          flush: async () => true,
        }),
      });
      client?.on("spanEnd", (span) => {
        const json = Sentry.spanToJSON(span);
        if (
          json.attributes?.["sentry.op"] ===
          "agent.repository_instructions.refresh"
        ) {
          outcomes.push(json.attributes["app.repository_instructions.outcome"]);
        }
      });
    });

    afterAll(async () => {
      await client?.close();
    });

    it("records whether each refresh changed model-visible AGENTS.md", async () => {
      const sequence: Array<RepositoryInstructions | undefined> = [
        undefined,
        instructions("v1", "Use pnpm."),
        instructions("v1", "Use pnpm."),
        instructions("v2", "Use the new formatter."),
        undefined,
      ];
      let current: RepositoryInstructions | undefined;
      const context = createRepositoryInstructionsContext({
        capture: async () => current,
        commit: async () => {},
        hasSandbox: () => true,
        promptContextContentParts: [],
        promptHistoryMessages: [],
        setMessages() {},
        shouldPromptAgent: true,
      });

      for (const next of sequence) {
        current = next;
        await context.applyUpdate([]);
      }

      expect(outcomes).toEqual([
        "none",
        "added",
        "unchanged",
        "updated",
        "removed",
      ]);
    });
  });
});
