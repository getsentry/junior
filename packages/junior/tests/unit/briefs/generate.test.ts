import { describe, expect, it } from "vitest";
import { generateBrief } from "@/chat/briefs/generate";
import type { BriefInput } from "@/chat/briefs/input";

const VERBATIM_URL = "https://example.com/runbook";
const LATE_URL = "https://example.com/late";
const INVENTED_URL = "https://example.com/invented";

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
        url: "https://github.com/getsentry/junior/pull/123",
        state: "open",
      },
    ],
    resources: [
      {
        label: "Release incident",
        url: "https://sentry.example.com/issues/123",
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
        url: "https://github.com/getsentry/junior/pull/123",
      },
      {
        kind: "resource",
        label: "Release incident",
        status: "warning",
        url: "https://sentry.example.com/issues/123",
      },
      { kind: "url", label: "Runbook", url: VERBATIM_URL },
    ]);
    expect(generation.evidence).toEqual({
      citedUrlCount: 3,
      codeChangeCount: 1,
      droppedUrls: [LATE_URL, INVENTED_URL],
      keptUrlCount: 1,
      resourceCount: 1,
    });
    expect(generation.searchText).toContain("Fix the release pipeline");
    expect(generation.searchText).toContain("Decision 0");
    expect(generation.searchText).toContain("Release incident");
    expect(generation.searchText).not.toContain("Use the runbook at");
  });
});
