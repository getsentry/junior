import { describe, expect, it } from "vitest";
import {
  rowIndexBeforeSeq,
  rowIndexForSeq,
  liveActivityIndex,
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

describe("rowIndexBeforeSeq", () => {
  it("finds the reply, not the question moved after it", () => {
    const moved = { ...entryRow(3), key: "ask" };
    const rows = [
      entryRow(1),
      entryRow(3),
      { key: UNREAD_MARKER_KEY, kind: "unread_marker" } as const,
      moved,
      entryRow(9),
    ];
    expect(rowIndexBeforeSeq(rows, 5)).toBe(1);
    expect(rowIndexBeforeSeq(rows, 2)).toBe(0);
    expect(rowIndexBeforeSeq(rows, 1)).toBeUndefined();
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

function toolEntry(
  seq: number,
  name = "bash",
  itemId = `item-${seq}`,
): RenderedTranscriptEntry {
  return {
    key: `${seq}:tool:0`,
    kind: "tool",
    part: {
      id: `call-${seq}`,
      name,
      output: JSON.stringify({ item: { id: itemId } }),
      status: "completed",
      type: "tool_call",
    },
    seq,
  };
}

function captureEntry(seq: number): RenderedTranscriptEntry {
  return {
    key: `${seq}:event:0`,
    kind: "structured_event",
    part: {
      name: "memories_captured",
      namespace: "memory",
      presentation: { title: "1 memory captured" },
      turnId: `turn-${seq}`,
      type: "structured_event",
      version: 1,
    },
    seq,
  };
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
  it("moves the Tasks of a Turn under its reply, so its activity stays one row", () => {
    const rows = transcriptListRows({
      entries: [
        messageEntry(0, "user"),
        toolEntry(1, "spawnAgent"),
        subagentEntry(2),
        toolEntry(3),
        subagentEntry(4, "thread"),
        subagentEntry(5),
        messageEntry(6),
        messageEntry(7, "user"),
        subagentEntry(8),
      ],
      keyPrefix: "c",
      knownActivityKeys: new Map(),
    });

    expect(rowSummary(rows)).toEqual([
      { keys: ["0:message:0"], kind: "entry", seq: 0 },
      { keys: ["1:tool:0", "3:tool:0"], kind: "activity", seq: 3 },
      { keys: ["subagent:child-4"], kind: "entry", seq: 4 },
      { keys: ["6:message:0"], kind: "entry", seq: 6 },
      { keys: ["7:message:0"], kind: "entry", seq: 7 },
      // With no reply yet, the Tasks get their own row.
      { keys: ["subagent:child-8"], kind: "tasks", seq: 8 },
    ]);
    const reply = rows[3]!;
    expect(
      reply.kind === "entry" && reply.tasks?.map((task) => task.key),
    ).toEqual(["subagent:child-2", "subagent:child-5"]);
    expect(liveActivityIndex(rows)).toBeUndefined();
    // A running Turn keeps its activity live above its Tasks row.
    expect(liveActivityIndex(rows.slice(0, 2))).toBe(1);
    expect(liveActivityIndex([...rows.slice(0, 2), rows.at(-1)!])).toBe(1);
    // A Thread card at the end of the running Turn does not hide it.
    expect(liveActivityIndex(rows.slice(0, 3))).toBe(1);
  });

  it("moves a question that Junior asked to the end of its Turn", () => {
    const rows = transcriptListRows({
      entries: [
        messageEntry(1, "user"),
        toolEntry(2),
        toolEntry(3, "addInboxItem"),
        toolEntry(4),
        messageEntry(5),
        messageEntry(6, "user"),
        toolEntry(7, "addInboxItem"),
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

  it("shows an item that Junior asked twice once, at its last ask", () => {
    const rows = transcriptListRows({
      entries: [
        messageEntry(1, "user"),
        toolEntry(2, "addInboxItem", "item-a"),
        toolEntry(3, "addInboxItem", "item-a"),
        messageEntry(4),
        messageEntry(5, "user"),
        toolEntry(6, "addInboxItem", "item-b"),
        messageEntry(7),
        messageEntry(8, "user"),
        toolEntry(9, "addInboxItem", "item-b"),
      ],
      keyPrefix: "c",
      knownActivityKeys: new Map(),
    });

    expect(rowSummary(rows)).toEqual([
      { keys: ["1:message:0"], kind: "entry", seq: 1 },
      { keys: ["4:message:0"], kind: "entry", seq: 4 },
      { keys: ["3:tool:0"], kind: "entry", seq: 4 },
      { keys: ["5:message:0"], kind: "entry", seq: 5 },
      { keys: ["7:message:0"], kind: "entry", seq: 7 },
      { keys: ["8:message:0"], kind: "entry", seq: 8 },
      { keys: ["9:tool:0"], kind: "entry", seq: 8 },
    ]);
  });

  it("puts the New marker before a moved ask that is unread", () => {
    const rows = transcriptListRows({
      entries: [
        messageEntry(1, "user"),
        messageEntry(2),
        toolEntry(3, "addInboxItem"),
      ],
      keyPrefix: "c",
      knownActivityKeys: new Map(),
      unread: { afterSeq: 2, throughSeq: 3 },
    });

    expect(rowSummary(rows)).toEqual([
      { keys: ["1:message:0"], kind: "entry", seq: 1 },
      { keys: ["2:message:0"], kind: "entry", seq: 2 },
      { keys: undefined, kind: "unread_marker", seq: undefined },
      { keys: ["3:tool:0"], kind: "entry", seq: 2 },
    ]);
  });

  it("puts the New marker before a read reply whose Tasks are unread", () => {
    const rows = transcriptListRows({
      entries: [messageEntry(1, "user"), messageEntry(2), subagentEntry(3)],
      keyPrefix: "c",
      knownActivityKeys: new Map(),
      unread: { afterSeq: 2, throughSeq: 3 },
    });

    expect(rowSummary(rows)).toEqual([
      { keys: ["1:message:0"], kind: "entry", seq: 1 },
      { keys: undefined, kind: "unread_marker", seq: undefined },
      { keys: ["2:message:0"], kind: "entry", seq: 3 },
    ]);
  });

  it("drops memory capture events, so the activity around them stays one row", () => {
    const rows = transcriptListRows({
      entries: [
        messageEntry(1, "user"),
        toolEntry(2),
        captureEntry(3),
        toolEntry(4),
        messageEntry(5),
        captureEntry(6),
        messageEntry(7, "user"),
        captureEntry(8),
      ],
      keyPrefix: "c",
      knownActivityKeys: new Map(),
    });

    expect(rowSummary(rows)).toEqual([
      { keys: ["1:message:0"], kind: "entry", seq: 1 },
      { keys: ["2:tool:0", "4:tool:0"], kind: "activity", seq: 4 },
      { keys: ["5:message:0"], kind: "entry", seq: 5 },
      { keys: ["7:message:0"], kind: "entry", seq: 7 },
    ]);
  });
});
