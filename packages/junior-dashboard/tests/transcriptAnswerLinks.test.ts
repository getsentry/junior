import { describe, expect, it } from "vitest";
import { transcriptAnswerLinks } from "../src/client/conversations/TranscriptAnswerLinks";
import {
  UNREAD_MARKER_KEY,
  type TranscriptListRow,
} from "../src/client/conversations/transcriptListRows";
import type { RenderedTranscriptEntry } from "../src/client/conversations/transcriptRenderModel";

// Each case passes only the entry fields it reads.
// oxlint-disable-next-line anti-slop/no-object-parameters
function row(key: string, entry: object): TranscriptListRow {
  return {
    entry: { key, ...entry } as RenderedTranscriptEntry,
    key,
    kind: "entry",
  };
}

function ask(itemId: string): TranscriptListRow {
  return row(`ask-${itemId}`, {
    kind: "tool",
    part: {
      name: "addReviewItem",
      output: { item: { id: itemId } },
      status: "completed",
    },
  });
}

function answer(
  itemId: string,
  options: { eventType?: string; kind?: "submitted" | "taken" } = {},
): TranscriptListRow {
  return row(`answer-${itemId}`, {
    kind: "message",
    message: {
      eventType: options.eventType,
      reviewItemChanges: [
        { kind: options.kind ?? "submitted", reviewItemId: itemId },
      ],
      role: "user",
    },
  });
}

const marker = { key: UNREAD_MARKER_KEY, kind: "unread_marker" } as const;

describe("transcriptAnswerLinks", () => {
  it("links each answer to its question across the rows between them", () => {
    expect(transcriptAnswerLinks([ask("a"), marker, answer("a")])).toEqual([
      { answerIndex: 2, askIndex: 0, itemId: "a", lane: 0 },
    ]);
  });

  it("puts overlapping links on different lanes and reuses a free lane", () => {
    const rows = [
      ask("a"),
      ask("b"),
      answer("a"),
      answer("b"),
      ask("c"),
      answer("c"),
    ];
    expect(transcriptAnswerLinks(rows)).toEqual([
      { answerIndex: 2, askIndex: 0, itemId: "a", lane: 0 },
      { answerIndex: 3, askIndex: 1, itemId: "b", lane: 1 },
      { answerIndex: 5, askIndex: 4, itemId: "c", lane: 0 },
    ]);
  });

  it("skips a take, an Event relay, and an answer with no question row", () => {
    expect(
      transcriptAnswerLinks([
        ask("a"),
        answer("a", { kind: "taken" }),
        answer("a", { eventType: "pull_request.checks.failed" }),
        answer("b"),
      ]),
    ).toEqual([]);
  });
});
