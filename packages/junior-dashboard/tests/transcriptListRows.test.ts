import { describe, expect, it } from "vitest";
import {
  rowIndexForSeq,
  transcriptListRows,
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

function subagentEntry(seq: number): RenderedTranscriptEntry {
  return {
    key: `subagent:child-${seq}`,
    kind: "subagent",
    part: {
      childConversationId: `child-${seq}`,
      id: `child-${seq}:${seq}`,
      status: "completed",
      subagentKind: "agent",
      type: "subagent",
    },
    seq,
  };
}

function messageEntry(seq: number): RenderedTranscriptEntry {
  return {
    key: `${seq}:message:0`,
    kind: "message",
    message: {
      parts: [{ type: "text", text: "Done." }],
      role: "assistant",
      sourceSeq: seq,
    },
    seq,
  };
}

describe("transcriptListRows", () => {
  it("groups each run of child agents and keeps a lone child agent as its card", () => {
    const rows = transcriptListRows({
      entries: [
        subagentEntry(1),
        subagentEntry(2),
        subagentEntry(3),
        messageEntry(4),
        subagentEntry(5),
      ],
      keyPrefix: "c",
      knownActivityKeys: new Map(),
    });

    expect(
      rows.map((row) => ({
        keys:
          row.kind === "subagents"
            ? row.entries.map((entry) => entry.key)
            : undefined,
        kind: row.kind,
        seq: "seq" in row ? row.seq : undefined,
      })),
    ).toEqual([
      {
        keys: ["subagent:child-1", "subagent:child-2", "subagent:child-3"],
        kind: "subagents",
        seq: 3,
      },
      { keys: undefined, kind: "entry", seq: 4 },
      { keys: undefined, kind: "entry", seq: 5 },
    ]);
  });
});
