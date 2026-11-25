import { Toast } from "@base-ui/react/toast";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { InboxItemActions } from "../src/client/inbox/InboxItemActions";
import { readMockInboxItems } from "../src/mock-reporting/inbox-items";

const items = readMockInboxItems(Date.now(), {});
// A notice that links nothing, so its card shows only its actions.
const { related: _related, request: _request, ...first } = items[0]!;
const item: InboxItemPayload = {
  ...first,
  canTake: true,
  kind: "notice",
};

function render(
  props: { dismiss?: boolean; take?: string | false },
  shown: InboxItemPayload = item,
) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <Toast.Provider>
          <InboxItemActions item={shown} {...props} />
        </Toast.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function buttons(
  props: { dismiss?: boolean; take?: string | false },
  shown: InboxItemPayload = item,
) {
  // A button's label is the text after its icon.
  return [
    ...render(props, shown).matchAll(/<button[^>]*>(.*?)<\/button>/g),
  ].map(([, content]) => content!.split(">").at(-1));
}

describe("inbox item actions", () => {
  it("shows Take and Dismiss unless the caller leaves them out", () => {
    // Snooze loads after the card, so a static render leaves it out.
    expect(buttons({})).toEqual(["Take", "Dismiss"]);
    expect(buttons({ dismiss: false, take: "Take it" })).toEqual(["Take it"]);
    expect(buttons({ dismiss: false, take: false })).toEqual([]);
  });

  it("lets a reader of a public question answer it, but not dismiss it", () => {
    const question = items.find(
      (candidate) => candidate.request && candidate.status === "open",
    )!;
    const reader = {
      ...question,
      canAct: false,
      canAnswer: true,
      canTake: false,
    };
    const shown = buttons({}, reader);
    expect(shown).toContain("Send");
    expect(shown).not.toContain("Dismiss");
    expect(shown).not.toContain("Take");
    expect(render({}, { ...reader, canAnswer: false })).toContain(
      "Only an assignee can act on this item.",
    );
  });
});
