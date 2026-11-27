import { describe, expect, it } from "vitest";

import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { inboxStackActions } from "../src/client/inbox/inboxRowActs";
import { readMockInboxItems } from "../src/mock-reporting/inbox-items";

const items = readMockInboxItems(Date.now(), {});

/** An open item that the viewer can act on, with this Dismiss note. */
function openItem(index: number, dismissNote?: string): InboxItemPayload {
  const item = items[index]!;
  const { dismissNote: _note, ...subject } = item.subject;
  return {
    ...item,
    canAct: true,
    status: "open",
    subject: dismissNote ? { ...subject, dismissNote } : subject,
    todoId: undefined,
  };
}

function stackActions(stacked: InboxItemPayload[]) {
  return inboxStackActions({
    act: (async () => {}) as never,
    expandedKey: "",
    items: stacked,
    keys: stacked.map((item) => item.id),
    snooze: () => {},
    stackKey: "stack",
    title: "Stack",
  });
}

describe("inbox stack actions", () => {
  it("say each other change that the stack's Dismiss makes", () => {
    const reviewer = "Also removes you from the reviewers on GitHub.";
    const assignee = "Also unassigns you on GitHub.";
    expect(
      stackActions([
        openItem(0, reviewer),
        openItem(1),
        openItem(2, reviewer),
        openItem(3, assignee),
      ]).dismissNote,
    ).toBe(`${reviewer} ${assignee}`);
    expect(stackActions([openItem(0), openItem(1)])).not.toHaveProperty(
      "dismissNote",
    );
  });
});
