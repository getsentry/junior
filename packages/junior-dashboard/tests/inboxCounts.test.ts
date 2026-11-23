import type { InboxItemPayload } from "@sentry/junior/api/schema";
import { describe, expect, it } from "vitest";

import { inboxCounts } from "../src/client/inbox/inboxCounts";
import { NOW_MS } from "../src/mock-reporting/fixtures";
import { readMockInboxItems } from "../src/mock-reporting/inbox-items";

const [template] = readMockInboxItems(NOW_MS, {});

function ask(
  id: string,
  type: "decision" | "other" | "prQuestion",
): InboxItemPayload {
  return {
    ...template!,
    assignedToEveryone: false,
    canAct: true,
    id,
    kind: "action",
    request:
      type === "other" ? undefined : { fields: [], question: `Approve ${id}?` },
    status: "open",
    subject:
      type === "prQuestion"
        ? {
            id: `https://github.com/getsentry/junior/pull/${id}`,
            objectType: "code_change",
            title: id,
            url: `https://github.com/getsentry/junior/pull/${id}`,
          }
        : undefined,
  };
}

describe("inboxCounts", () => {
  it("keeps the Other asks that To do shows while later pages hold pull request questions", () => {
    const loaded = [ask("decision-1", "decision"), ask("todo-1", "other")];
    // Two unloaded pull request questions: the server counts each as a
    // code change and as a decision.
    const counts = inboxCounts({
      hasMore: true,
      known: loaded,
      loaded,
      server: { codeChanges: 2, decisions: 3, needsViewer: 4 },
      todo: loaded,
    });
    expect(counts).toEqual({ all: 4, decisions: 1, other: 1, prs: 2 });
  });

  it("adds the types up to All", () => {
    const loaded = [
      ask("decision-1", "decision"),
      ask("pr-1", "prQuestion"),
      ask("todo-1", "other"),
    ];
    const counts = inboxCounts({
      hasMore: false,
      known: loaded,
      loaded,
      server: undefined,
      todo: loaded,
    });
    expect(counts).toEqual({ all: 3, decisions: 1, other: 1, prs: 1 });
  });
});
