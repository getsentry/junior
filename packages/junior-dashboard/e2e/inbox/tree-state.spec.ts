import { mockInboxItems } from "./inbox-fixture";
import { screenshot } from "../screenshot";
import { expect, test } from "../test";
import { mockConversationDetail, mockFeedPage } from "../mock-reports";

test.describe("new UI", () => {
  test("one icon shows what each tree waits on", async ({
    dashboard,
    page,
  }) => {
    // The API derives each state from the whole tree for the viewer.
    const release = "slack:CQA456:1770021600.000600";
    const treeStates: Record<string, object> = {
      [release]: { treeState: "working", watching: true },
      "slack:CQA456:1770025200.000700": { treeState: "needs_input" },
      "internal:dashboard-qa": { treeState: "done", watching: true },
      // Their mock questions wait, but here their trees are done.
      "internal:question-qa": { treeState: "done" },
      "slack:CQA456:1770028800.000900": { treeState: "done" },
    };
    await page.route(/\/api\/conversations(\?.*)?$/, async (route) => {
      const feed = await mockFeedPage(route);
      return route.fulfill({
        json: {
          ...feed,
          conversations: feed.conversations.map(
            (conversation: { conversationId: string }) => {
              const state = treeStates[conversation.conversationId];
              return state ? { ...conversation, ...state } : conversation;
            },
          ),
        },
      });
    });
    await page.route(
      new RegExp(`/api/conversations/${encodeURIComponent(release)}(\\?.*)?$`),
      async (route) => {
        const detail = await mockConversationDetail(route);
        return route.fulfill({
          json: { ...detail, treeState: "working" },
        });
      },
    );
    await mockInboxItems(page);
    await page.goto(`${dashboard.baseURL}/inbox`);
    const inFlight = page.getByRole("list", { name: "In flight" });
    const flightRow = (title: RegExp) =>
      inFlight
        .getByRole("listitem")
        .filter({ has: page.getByRole("link", { name: title }) });
    // The root is idle, but a Task under it works, so it is in flight.
    await expect(
      flightRow(/Package release and self-update/).getByRole("status", {
        name: "Working",
      }),
    ).toBeVisible();
    await expect(
      flightRow(/Quarterly reliability review/).getByRole("img", {
        name: "Needs input",
      }),
    ).toBeVisible();
    // A done tree that watches for an Event or a Timer shows an eye.
    const watching = flightRow(/Dashboard QA edge cases/).getByRole("img", {
      name: "Watching for an event",
    });
    await expect(watching).toBeVisible();
    // A pin shows its pin only while its tree waits on nothing.
    // The Inbox lists only what needs the viewer, so pin from Conversations.
    await page.goto(`${dashboard.baseURL}/inbox?view=conversations`);
    const list = page.getByRole("region", {
      exact: true,
      name: "Conversations",
    });
    await list.getByRole("link", { name: /^Roll out payments-v42/ }).hover();
    await list
      .getByRole("button", { name: "Pin Roll out payments-v42" })
      .click();
    // The focused button shows the row actions in some runs, and a re-render
    // drops the focus in others. The shot is of the tree icons, so blur it.
    await list
      .getByRole("button", { name: "Unpin Roll out payments-v42" })
      .blur();
    await expect(
      flightRow(/Roll out payments-v42/).getByRole("img", { name: "Pinned" }),
    ).toBeVisible();
    // A done tree that is not pinned is not in flight.
    await expect(inFlight.getByRole("listitem")).toHaveCount(5);
    await screenshot(page, "inbox-tree-state", { lightTheme: true });

    // Each Conversation row shows the same one icon.
    const row = list
      .getByRole("listitem")
      .filter({
        has: page.getByRole("link", { name: /^Quarterly reliability review/ }),
      })
      .first();
    const meta = row.locator('[data-inbox-slot="meta"]').first();
    await expect(meta.getByRole("img", { name: "Needs input" })).toBeVisible();

    // So does the Conversation header.
    await flightRow(/Package release and self-update/)
      .getByRole("link")
      .click();
    await expect(page).toHaveURL(/\/conversations\/slack%3ACQA456/);
    await expect(
      page
        .locator("header")
        .filter({
          has: page.getByRole("heading", {
            name: "Package release and self-update",
          }),
        })
        .getByRole("status", { name: "Working" }),
    ).toBeVisible();
    await screenshot(page, "inbox-tree-state-header", {
      lightTheme: true,
      view: "desktop",
    });
  });
});
