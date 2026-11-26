import type { InboxItemPayload } from "@sentry/junior/api/schema";
import { describe, expect, it } from "vitest";

import { inboxItemKind } from "../src/client/inbox/inboxModel";
function pullRequestAsk(
  subject: Partial<InboxItemPayload["subject"]>,
): InboxItemPayload {
  // Only the fields that name the kind.
  return {
    kind: "action",
    status: "open",
    subject: {
      id: "91",
      kind: "github:pull_request",
      label: "Pull request",
      objectType: "code_change",
      url: "https://github.com/getsentry/junior/pull/91",
      ...subject,
    },
    title: "Review requested · #91",
  } as InboxItemPayload;
}

describe("inboxItemKind", () => {
  it("names a pull request ask by its live label", () => {
    const item = pullRequestAsk({
      label: "Ready to merge",
      object: { title: "Fix it" } as InboxItemPayload["subject"]["object"],
    });
    expect(inboxItemKind(item)).toBe("Ready to merge");
  });

  it("names a pull request ask by its title when GitHub can't be read", () => {
    expect(inboxItemKind(pullRequestAsk({}))).toBe("Review requested");
  });
});
