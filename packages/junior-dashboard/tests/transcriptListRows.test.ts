import { describe, expect, it } from "vitest";
import {
  rowIndexForSeq,
  type TranscriptListRow,
  UNREAD_MARKER_KEY,
} from "../src/client/conversations/transcriptListRows";
import type { RenderedTranscriptEntry } from "../src/client/conversations/transcriptRenderModel";

function entryRow(seq: number): TranscriptListRow {
  const key = `entry-${seq}`;
  return {
    entry: { key } as RenderedTranscriptEntry,
    key,
    kind: "entry",
    seq,
  };
}

describe("rowIndexForSeq", () => {
  it("finds rows after a New marker in the middle of the list", () => {
    // The marker is the first row the search reads.
    const rows = [
      entryRow(0),
      entryRow(1),
      { key: UNREAD_MARKER_KEY, kind: "unread_marker" } as const,
      entryRow(2),
      entryRow(3),
    ];
    expect(rowIndexForSeq(rows, 1)).toBe(1);
    expect(rowIndexForSeq(rows, 2)).toBe(3);
    expect(rowIndexForSeq(rows, 3)).toBe(4);
    expect(rowIndexForSeq(rows, 4)).toBe(5);
  });

  it("finds the first row after a New marker at the top", () => {
    const rows = [
      { key: UNREAD_MARKER_KEY, kind: "unread_marker" } as const,
      entryRow(5),
      entryRow(6),
      entryRow(7),
    ];
    expect(rowIndexForSeq(rows, 5)).toBe(1);
  });
});
