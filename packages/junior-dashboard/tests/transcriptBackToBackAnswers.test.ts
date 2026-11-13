import { describe, expect, it } from "vitest";
import { backToBackAnswerItemIds } from "../src/client/conversations/transcriptBackToBackAnswers";
import {
  UNREAD_MARKER_KEY,
  type TranscriptListRow,
} from "../src/client/conversations/transcriptListRows";
import type { RenderedTranscriptEntry } from "../src/client/conversations/transcriptRenderModel";

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

describe("backToBackAnswerItemIds", () => {
  it("finds an answer that comes directly after its question", () => {
    expect(backToBackAnswerItemIds([ask("a"), answer("a")])).toEqual(
      new Set(["a"]),
    );
  });

  it("skips answers that another row separates from their question", () => {
    // Two questions, then their answers in order: only the second question
    // sits directly above an answer, and that answer is for the first one.
    const rows = [ask("a"), ask("b"), answer("a"), answer("b")];
    expect(backToBackAnswerItemIds(rows)).toEqual(new Set());
    expect(
      backToBackAnswerItemIds([
        ask("a"),
        { key: UNREAD_MARKER_KEY, kind: "unread_marker" },
        answer("a"),
      ]),
    ).toEqual(new Set());
  });

  it("skips a take and a relayed Event change", () => {
    expect(
      backToBackAnswerItemIds([ask("a"), answer("a", { kind: "taken" })]),
    ).toEqual(new Set());
    expect(
      backToBackAnswerItemIds([
        ask("a"),
        answer("a", { eventType: "pull_request.checks.failed" }),
      ]),
    ).toEqual(new Set());
  });
});
