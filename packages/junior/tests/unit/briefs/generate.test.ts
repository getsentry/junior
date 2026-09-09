import { describe, expect, it } from "vitest";
import { generateBrief } from "@/chat/briefs/generate";
import type { BriefInput } from "@/chat/briefs/input";

const VERBATIM_URL = "https://example.com/runbook";
const LATE_URL = "https://example.com/late";
const INVENTED_URL = "https://example.com/invented";
const CODE_CHANGE_URL = "https://github.com/getsentry/junior/pull/123";
const RESOURCE_URL = "https://sentry.example.com/issues/123";

function input(): BriefInput {
  return {
    conversationId: "conversation-1",
    title: "Fix the release pipeline",
    visibility: "public",
    location: { provider: "slack", channelName: "builds" },
    entries: [
      {
        index: 1,
        role: "user",
        author: "Ada",
        text: `Use the runbook at ${VERBATIM_URL}.`,
        createdAtMs: 1,
        turnId: "turn-1",
      },
      {
        index: 2,
        role: "assistant",
        text: "The release pipeline is fixed.",
        createdAtMs: 2,
        turnId: "turn-1",
      },
      {
        index: 9,
        role: "user",
        text: `Later evidence: ${LATE_URL}`,
        createdAtMs: 9,
        turnId: "turn-2",
      },
    ],
    codeChanges: [
      {
        repository: "getsentry/junior",
        number: 123,
        title: "Fix release pipeline",
        url: CODE_CHANGE_URL,
        state: "open",
      },
    ],
    resources: [
      {
        label: "Release incident",
        url: RESOURCE_URL,
        status: "warning",
      },
    ],
  };
}

describe("generateBrief", () => {
  it("caps content, builds search text, and keeps only supported evidence", async () => {
    const generation = await generateBrief({
      input: input(),
      throughIndex: 2,
      prompt: "Write a Brief.",
      model: "test/model",
      completeObject: async () => ({
        costUsd: 0.0123,
        object: {
          summary: "s".repeat(700),
          intent: "i".repeat(500),
          outcome: { status: "done", text: "o".repeat(700) },
          decisions: Array.from({ length: 25 }, (_, index) => ({
            text: `Decision ${index} ${"x".repeat(500)}`,
            by: "Ada",
          })),
          openDecisions: Array.from({ length: 25 }, (_, index) => ({
            text: `Open ${index}`,
          })),
          facts: Array.from({ length: 35 }, (_, index) => `Fact ${index}`),
          keywords: Array.from(
            { length: 15 },
            (_, index) => `KEYWORD-${index}`,
          ),
          urls: [
            { label: "Runbook", url: VERBATIM_URL },
            { label: "Code change", url: CODE_CHANGE_URL },
            { label: "Resource", url: RESOURCE_URL },
            { label: "Late", url: LATE_URL },
            { label: "Invented", url: INVENTED_URL },
          ],
        },
      }),
    });

    expect(generation.throughIndex).toBe(2);
    expect(generation.costUsd).toBe(0.0123);
    expect(generation.brief.summary).toHaveLength(600);
    expect(generation.brief.intent).toHaveLength(400);
    expect(generation.brief.outcome.text).toHaveLength(600);
    expect(generation.brief.decisions).toHaveLength(20);
    expect(generation.brief.decisions[0]?.text).toHaveLength(400);
    expect(generation.brief.openDecisions).toHaveLength(20);
    expect(generation.brief.facts).toHaveLength(30);
    expect(generation.brief.keywords).toHaveLength(12);
    expect(generation.brief.keywords[0]).toBe("keyword-0");
    expect(generation.brief.links).toEqual([
      {
        kind: "code_change",
        label: "getsentry/junior#123 · Fix release pipeline",
        status: "open",
        url: CODE_CHANGE_URL,
      },
      {
        kind: "resource",
        label: "Release incident",
        status: "warning",
        url: RESOURCE_URL,
      },
      { kind: "url", label: "Runbook", url: VERBATIM_URL },
    ]);
    expect(generation.evidence).toEqual({
      citedUrlCount: 5,
      codeChangeCount: 1,
      droppedUrls: [LATE_URL, INVENTED_URL],
      keptUrlCount: 3,
      resourceCount: 1,
    });
    expect(generation.searchText).toContain("Fix the release pipeline");
    expect(generation.searchText).toContain("Decision 0");
    expect(generation.searchText).toContain("Release incident");
    expect(generation.searchText).not.toContain("Use the runbook at");
  });

  it("keeps messages before filling the budget with newest tool results", async () => {
    const toolEntries: BriefInput["entries"] = Array.from(
      { length: 40 },
      (_, index) => ({
        index: index + 2,
        role: "tool",
        author: "search",
        text: `tool-${index}:${"x".repeat(1_600)}`,
        createdAtMs: index + 2,
        turnId: "turn-1",
      }),
    );
    const longInput: BriefInput = {
      ...input(),
      entries: [
        {
          index: 1,
          role: "user",
          text: `user:${"u".repeat(5_000)}`,
          createdAtMs: 1,
          turnId: "turn-1",
        },
        ...toolEntries,
        {
          index: 100,
          role: "assistant",
          text: `assistant:${"a".repeat(5_000)}`,
          createdAtMs: 100,
          turnId: "turn-1",
        },
      ],
    };
    let capturedPrompt = "";

    await generateBrief({
      input: longInput,
      throughIndex: 100,
      prompt: "Write a Brief.",
      model: "test/model",
      completeObject: async (request) => {
        capturedPrompt = request.prompt;
        return {
          object: {
            summary: "Summary",
            intent: "Intent",
            outcome: { status: "done", text: "Done" },
            decisions: [],
            openDecisions: [],
            facts: [],
            keywords: [],
            urls: [],
          },
        };
      },
    });

    const match = capturedPrompt.match(/<brief-input>\n(.+)\n<\/brief-input>/s);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match?.[1] ?? "{}") as {
      entries: BriefInput["entries"];
      omitted: { messages: number; toolResults: number };
    };
    const messages = payload.entries.filter((entry) => entry.role !== "tool");
    const tools = payload.entries.filter((entry) => entry.role === "tool");

    expect(match?.[1]?.length).toBeLessThanOrEqual(60_000);
    expect(payload.omitted.messages).toBe(0);
    expect(payload.omitted.toolResults).toBeGreaterThan(0);
    expect(messages).toHaveLength(2);
    expect(messages.map((entry) => entry.text.length)).toEqual([4_000, 4_000]);
    expect(messages.every((entry) => entry.text.endsWith("…"))).toBe(true);
    expect(tools.some((entry) => entry.text.startsWith("tool-39:"))).toBe(true);
    expect(tools.some((entry) => entry.text.startsWith("tool-0:"))).toBe(false);
    expect(payload.entries.map((entry) => entry.index)).toEqual(
      [...payload.entries].map((entry) => entry.index).sort((a, b) => a - b),
    );
  });
});
