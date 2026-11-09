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

function subagentEntry(
  seq: number,
  childKind: "thread" | "task" = "task",
): RenderedTranscriptEntry {
  return {
    key: `subagent:child-${seq}`,
    kind: "subagent",
    part: {
      childConversationId: `child-${seq}`,
      id: `child-${seq}:${seq}`,
      status: "completed",
      childKind,
      subagentKind: "agent",
      type: "subagent",
    },
    seq,
  };
}

function messageEntry(
  seq: number,
  role: "assistant" | "user" = "assistant",
): RenderedTranscriptEntry {
  return {
    key: `${seq}:message:0`,
    kind: "message",
    message: {
      parts: [{ type: "text", text: "Done." }],
      role,
      sourceSeq: seq,
    },
    seq,
  };
}

function toolEntry(seq: number, name = "bash"): RenderedTranscriptEntry {
  return {
    key: `${seq}:tool:0`,
    kind: "tool",
    part: {
      id: `call-${seq}`,
      name,
      output: JSON.stringify({ item: { id: `item-${seq}` } }),
      status: "completed",
      type: "tool_call",
    },
    seq,
  } as RenderedTranscriptEntry;
}

function rowSummary(rows: TranscriptListRow[]) {
  return rows.map((row) => ({
    keys:
      row.kind === "tasks" || row.kind === "activity"
        ? row.entries.map((entry) => entry.key)
        : row.kind === "entry"
          ? [row.entry.key]
          : undefined,
    kind: row.kind,
    seq: "seq" in row ? row.seq : undefined,
  }));
}

describe("transcriptListRows", () => {
  it("collapses each run of Tasks to one row and keeps each Thread as its own row", () => {
    const rows = transcriptListRows({
      entries: [
        subagentEntry(1),
        subagentEntry(2),
        subagentEntry(3, "thread"),
        subagentEntry(4),
        messageEntry(5),
        subagentEntry(6),
      ],
      keyPrefix: "c",
      knownActivityKeys: new Map(),
    });

    expect(
      rows.map((row) => ({
        keys:
          row.kind === "tasks"
            ? row.entries.map((entry) => entry.key)
            : row.kind === "entry"
              ? [row.entry.key]
              : undefined,
        kind: row.kind,
        seq: "seq" in row ? row.seq : undefined,
      })),
    ).toEqual([
      {
        keys: ["subagent:child-1", "subagent:child-2"],
        kind: "tasks",
        seq: 2,
      },
      { keys: ["subagent:child-3"], kind: "entry", seq: 3 },
      { keys: ["subagent:child-4"], kind: "tasks", seq: 4 },
      { keys: ["5:message:0"], kind: "entry", seq: 5 },
      { keys: ["subagent:child-6"], kind: "tasks", seq: 6 },
    ]);
  });

  it("moves a question that Junior asked to the end of its Turn", () => {
    const rows = transcriptListRows({
      entries: [
        messageEntry(1, "user"),
        toolEntry(2),
        toolEntry(3, "addReviewItem"),
        toolEntry(4),
        messageEntry(5),
        messageEntry(6, "user"),
        toolEntry(7, "addReviewItem"),
      ],
      keyPrefix: "c",
      knownActivityKeys: new Map(),
    });

    // The activity around the ask stays one row, and the moved rows keep
    // seq order.
    expect(rowSummary(rows)).toEqual([
      { keys: ["1:message:0"], kind: "entry", seq: 1 },
      { keys: ["2:tool:0", "4:tool:0"], kind: "activity", seq: 4 },
      { keys: ["5:message:0"], kind: "entry", seq: 5 },
      { keys: ["3:tool:0"], kind: "entry", seq: 5 },
      { keys: ["6:message:0"], kind: "entry", seq: 6 },
      { keys: ["7:tool:0"], kind: "entry", seq: 6 },
    ]);
  });
});
