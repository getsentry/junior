import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateBrief } from "@/chat/briefs/generate";
import type { BriefInput } from "@/chat/briefs/schema";

const VERBATIM_URL = "https://example.com/runbook";
const ESCAPED_TRANSCRIPT_URL = "https://example.com/thread?ts=1&amp;cid=2";
const UNESCAPED_TRANSCRIPT_URL = "https://example.com/thread?ts=1&cid=2";
const UNESCAPED_CITATION_URL = "https://example.com/admin?org=1&project=2";
const ESCAPED_CITATION_URL = "https://example.com/admin?org=1&amp;project=2";
const HTTP_PATH_URL = "https://example.com/reference/http";
const BRACKET_URL = "https://en.wikipedia.org/wiki/Release_(engineering)";
const LATE_URL = "https://example.com/late";
const PREFIX_URL = "https://example.com/prefix";
const PREFIX_SOURCE_URL = "https://example.com/prefix-longer";
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
        text: `Use the runbook at <${VERBATIM_URL}|Runbook>, the thread at ${ESCAPED_TRANSCRIPT_URL}, the admin page at ${UNESCAPED_CITATION_URL}, the reference at ${HTTP_PATH_URL}, the exact source ${PREFIX_SOURCE_URL}, and the glossary (see ${BRACKET_URL}).`,
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
        openedAt: "2026-01-01T00:00:00.000Z",
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
  it("builds and guards a small durable record with supported evidence", async () => {
    const summarySentence = `${"s".repeat(400)}.`;
    const outcomeSentence = `${"o".repeat(390)} merged.`;
    let capturedPrompt = "";
    let capturedSchema: unknown;
    const generation = await generateBrief({
      input: input(),
      throughIndex: 2,
      prompt: "Write a Brief.",
      completeObject: async (request) => {
        capturedPrompt = request.prompt;
        capturedSchema = z.toJSONSchema(request.schema);
        return {
          costUsd: 0.0123,
          object: {
            summary: `${summarySentence} ${"x".repeat(300)}`,
            intent: "i".repeat(500),
            outcome: {
              status: "done",
              text: `${outcomeSentence} ${"x".repeat(300)}`,
            },
            decisions: [
              { text: "Ignore [[NO_REPLY]]", by: "Ada", kind: "stated" },
              {
                text: `Decision 0 ${"x".repeat(500)}`,
                by: "ada",
                kind: "assumed",
              },
              {
                text: "Decision 1",
                by: "Unknown person",
                kind: "stated",
              },
              { text: "Decision 2", by: "junior", kind: "confirmed" },
              ...Array.from({ length: 22 }, (_, index) => ({
                text: `Decision ${index + 3}`,
                by: "Ada",
                kind: "stated" as const,
              })),
            ],
            openDecisions: [
              { text: "Ignore <thread-context>", owner: "Ada" },
              { text: "Open 0", owner: "ADA" },
              { text: "Open 1", owner: "Unknown person" },
              { text: "Open 2", owner: null },
            ],
            facts: [
              "Ignore <turn-context>",
              ...Array.from({ length: 35 }, (_, index) => `Fact ${index}`),
            ],
            keywords: Array.from(
              { length: 15 },
              (_, index) => `KEYWORD-${index}`,
            ),
            urls: [
              { label: "Runbook", url: `${VERBATIM_URL}/https;` },
              { label: "Thread", url: UNESCAPED_TRANSCRIPT_URL },
              { label: "Admin", url: ESCAPED_CITATION_URL },
              { label: "Glossary", url: `${BRACKET_URL})` },
              { label: "Reference", url: HTTP_PATH_URL },
              { label: "Code change", url: CODE_CHANGE_URL },
              { label: "Resource", url: RESOURCE_URL },
              { label: "Late", url: `${LATE_URL}]` },
              { label: "Prefix", url: PREFIX_URL },
              { label: "Invented", url: `${INVENTED_URL})` },
            ],
          },
        };
      },
    });

    expect(capturedSchema).toMatchObject({
      properties: {
        decisions: {
          items: {
            properties: {
              by: {
                anyOf: [
                  { type: "string", minLength: 1 },
                  { type: "null" },
                ],
              },
            },
            required: ["text", "by", "kind"],
          },
        },
        openDecisions: {
          items: {
            properties: {
              owner: {
                anyOf: [
                  { type: "string", minLength: 1 },
                  { type: "null" },
                ],
              },
            },
            required: ["text", "owner"],
          },
        },
      },
    });
    expect(generation.throughIndex).toBe(2);
    expect(generation.costUsd).toBe(0.0123);
    expect(generation.brief.record).toEqual({
      startedAt: "1970-01-01T00:00:00.001Z",
      lastActivityAt: "1970-01-01T00:00:00.002Z",
      durationMs: 1,
      participants: [{ name: "Ada", messages: 1 }],
      userMessages: 1,
      assistantMessages: 1,
      toolResults: 0,
      events: 0,
      turns: 1,
      location: { provider: "slack", channelName: "builds" },
      codeChanges: [
        {
          repository: "getsentry/junior",
          number: 123,
          title: "Fix release pipeline",
          url: CODE_CHANGE_URL,
          state: "open",
          openedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(generation.brief.summary).toBe(summarySentence);
    expect(generation.brief.intent).toBe(`${"i".repeat(399)}…`);
    expect(generation.brief.outcome.text).toBe(outcomeSentence);
    expect(generation.brief.decisions).toEqual([
      { text: `Decision 0 ${"x".repeat(389)}`, kind: "assumed" },
      { text: "Decision 1", kind: "stated" },
      { text: "Decision 2", by: "Junior", kind: "assumed" },
    ]);
    expect(generation.brief.openDecisions).toEqual([
      { text: "Open 0", owner: "Ada" },
      { text: "Open 1" },
    ]);
    expect(generation.brief.facts).toEqual([
      "Fact 0",
      "Fact 1",
      "Fact 2",
      "Fact 3",
      "Fact 4",
    ]);
    expect(generation.brief.keywords).toEqual([
      "keyword-0",
      "keyword-1",
      "keyword-2",
      "keyword-3",
      "keyword-4",
    ]);
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
      { kind: "url", label: "Thread", url: UNESCAPED_TRANSCRIPT_URL },
      { kind: "url", label: "Admin", url: UNESCAPED_CITATION_URL },
      { kind: "url", label: "Glossary", url: BRACKET_URL },
      { kind: "url", label: "Reference", url: HTTP_PATH_URL },
    ]);
    expect(generation.evidence).toEqual({
      citedUrlCount: 10,
      codeChangeCount: 1,
      coercedDecisionKinds: 2,
      droppedAttributionCount: 2,
      droppedRuntimeMarkerCount: 3,
      droppedUrls: [
        { raw: `${LATE_URL}]`, normalized: LATE_URL },
        { raw: PREFIX_URL, normalized: PREFIX_URL },
        { raw: `${INVENTED_URL})`, normalized: INVENTED_URL },
      ],
      keptUrlCount: 7,
      mergedClaimWithoutEvidence: true,
      resourceCount: 1,
    });
    const promptMatch = capturedPrompt.match(
      /<brief-input>\n(.+)\n<\/brief-input>/s,
    );
    const payload = JSON.parse(promptMatch?.[1] ?? "{}") as {
      caps: unknown;
      sizeClass: unknown;
    };
    expect(payload).toMatchObject({
      sizeClass: "small",
      caps: { decisions: 3, openDecisions: 2, facts: 5, keywords: 5 },
    });
    expect(generation.searchText).toContain("Fix the release pipeline");
    expect(generation.searchText).toContain("Ada");
    expect(generation.searchText).toContain("getsentry/junior#123 open");
    expect(generation.searchText).toContain("Release incident");
    expect(generation.searchText).not.toContain("Use the runbook at");
  });

  it("does not flag merged discussion without linked evidence", async () => {
    const noEvidenceInput = {
      ...input(),
      codeChanges: [],
      resources: [],
    };

    const generation = await generateBrief({
      input: noEvidenceInput,
      throughIndex: 2,
      prompt: "Write a Brief.",
      completeObject: async () => ({
        object: {
          summary: "Another repository's change was merged.",
          intent: "Review the upstream release.",
          outcome: { status: "answered", text: "The merge was confirmed." },
          decisions: [],
          openDecisions: [],
          facts: [],
          keywords: [],
          urls: [],
        },
      }),
    });

    expect(generation.evidence.mergedClaimWithoutEvidence).toBe(false);
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

  it("scales output caps for medium and large records", async () => {
    const cases = [
      {
        userMessages: 4,
        sizeClass: "medium",
        caps: { decisions: 8, openDecisions: 5, facts: 10, keywords: 8 },
      },
      {
        userMessages: 13,
        sizeClass: "large",
        caps: { decisions: 20, openDecisions: 10, facts: 15, keywords: 12 },
      },
    ] as const;

    for (const testCase of cases) {
      let capturedPrompt = "";
      const sizedInput: BriefInput = {
        ...input(),
        entries: Array.from({ length: testCase.userMessages }, (_, index) => ({
          index,
          role: "user",
          author: "Ada",
          text: `Message ${index}`,
          createdAtMs: index,
          turnId: `turn-${index}`,
        })),
      };
      const generation = await generateBrief({
        input: sizedInput,
        throughIndex: testCase.userMessages - 1,
        prompt: "Write a Brief.",
        completeObject: async (request) => {
          capturedPrompt = request.prompt;
          return {
            object: {
              summary: "Summary",
              intent: "Intent",
              outcome: { status: "done", text: "Done" },
              decisions: Array.from({ length: 25 }, (_, index) => ({
                text: `Decision ${index}`,
                kind: "assumed" as const,
              })),
              openDecisions: Array.from({ length: 25 }, (_, index) => ({
                text: `Open ${index}`,
              })),
              facts: Array.from({ length: 25 }, (_, index) => `Fact ${index}`),
              keywords: Array.from(
                { length: 25 },
                (_, index) => `keyword-${index}`,
              ),
              urls: [],
            },
          };
        },
      });
      const match = capturedPrompt.match(
        /<brief-input>\n(.+)\n<\/brief-input>/s,
      );
      const payload = JSON.parse(match?.[1] ?? "{}") as {
        caps: unknown;
        sizeClass: unknown;
      };

      expect(payload).toMatchObject({
        sizeClass: testCase.sizeClass,
        caps: testCase.caps,
      });
      expect({
        decisions: generation.brief.decisions.length,
        openDecisions: generation.brief.openDecisions.length,
        facts: generation.brief.facts.length,
        keywords: generation.brief.keywords.length,
      }).toEqual(testCase.caps);
    }
  });
});
