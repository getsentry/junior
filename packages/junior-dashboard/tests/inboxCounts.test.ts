import type { InboxItemPayload } from "@sentry/junior/api/schema";
import { describe, expect, it } from "vitest";

import { inboxCounts } from "../src/client/inbox/inboxCounts";
import { NOW_MS } from "../src/mock-reporting/fixtures";
import { readMockInboxItems } from "../src/mock-reporting/inbox-items";

const [template] = readMockInboxItems(NOW_MS, {});

function ask(
  id: string,
  type: "decision" | "other" | "prQuestion" | "todo",
): InboxItemPayload {
  return {
    ...template!,
    assignedToEveryone: false,
    canAct: true,
    id,
    kind: "action",
    request:
      type === "other" || type === "todo"
        ? undefined
        : { fields: [], question: `Approve ${id}?` },
    status: "open",
    subject:
      type === "prQuestion"
        ? {
            id: `https://github.com/getsentry/junior/pull/${id}`,
            kind: "question",
            objectType: "code_change",
            url: `https://github.com/getsentry/junior/pull/${id}`,
          }
        : { id, kind: type === "todo" ? "todo" : "agent" },
    todoId: type === "todo" ? 1 : undefined,
  };
}

describe("inboxCounts", () => {
  it("keeps the Other asks that To do shows while later pages hold pull request questions", () => {
    const loaded = [ask("decision-1", "decision"), ask("resume-1", "other")];
    // Two unloaded pull request questions: the server counts each as a
    // code change and as a decision.
    const counts = inboxCounts({
      hasMore: true,
      known: loaded,
      loaded,
      server: { codeChanges: 2, decisions: 3, needsViewer: 4, todos: 0 },
      todo: loaded,
    });
    expect(counts).toEqual({
      all: 4,
      decisions: 1,
      other: 1,
      prs: 2,
      todos: 0,
    });
  });

  it("counts the To-dos on later pages as To-dos, not Other", () => {
    const loaded = [ask("todo-1", "todo"), ask("resume-1", "other")];
    const counts = inboxCounts({
      hasMore: true,
      known: loaded,
      loaded,
      server: { codeChanges: 0, decisions: 0, needsViewer: 4, todos: 3 },
      todo: loaded,
    });
    expect(counts).toEqual({
      all: 4,
      decisions: 0,
      other: 1,
      prs: 0,
      todos: 3,
    });
  });

  it("adds the types up to All", () => {
    const loaded = [
      ask("decision-1", "decision"),
      ask("pr-1", "prQuestion"),
      ask("resume-1", "other"),
      ask("todo-1", "todo"),
    ];
    const counts = inboxCounts({
      hasMore: false,
      known: loaded,
      loaded,
      server: undefined,
      todo: loaded,
    });
    expect(counts).toEqual({
      all: 4,
      decisions: 1,
      other: 1,
      prs: 1,
      todos: 1,
    });
  });
});
