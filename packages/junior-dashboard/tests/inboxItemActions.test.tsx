import { Toast } from "@base-ui/react/toast";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InboxItemActions } from "../src/client/inbox/InboxItemActions";
import { readMockInboxItems } from "../src/mock-reporting/inbox-items";

const [seed] = readMockInboxItems(Date.now(), {});
const item = { ...seed!, canTake: true, kind: "notice" as const };

function buttons(props: { dismiss?: boolean; take?: string | false }) {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Toast.Provider>
        <InboxItemActions item={item} {...props} />
      </Toast.Provider>
    </QueryClientProvider>,
  );
  // A button's label is the text after its icon.
  return [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(
    ([, content]) => content!.split(">").at(-1),
  );
}

describe("inbox item actions", () => {
  it("shows Take, Snooze, and Dismiss unless the caller leaves them out", () => {
    expect(buttons({})).toEqual(["Take", "Snooze", "Dismiss"]);
    expect(buttons({ dismiss: false, take: "Take it" })).toEqual(["Take it"]);
    expect(buttons({ dismiss: false, take: false })).toEqual([]);
  });
});
