import { conversationMenuRow } from "./conversationMenu";
import { expect, test } from "./test";
import { mobile, screenshot } from "./screenshot";

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const TIMER_INTENT = "Remind Morgan to confirm the rollback window.";
const ALERT_INTENT = "Post when the checkout p95 alert resolves.";

test("lists a Conversation's Watches in Work and cancels one", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
  );
  const work = page
    .getByRole("complementary", { name: "Conversation details", exact: true })
    .getByRole("region", { exact: true, name: "Work" });
  const timer = work.getByRole("listitem").filter({ hasText: TIMER_INTENT });
  const alert = work.getByRole("listitem").filter({ hasText: ALERT_INTENT });
  await expect(timer).toBeVisible();
  await expect(alert).toBeVisible();
  // A Watch waits, so it shows the waiting icon and no line under it.
  await expect(timer.getByRole("img", { name: "Waiting" })).toBeVisible();
  await screenshot(page, "conversation-details-watches", {
    lightTheme: true,
    target: work,
    view: "desktop",
  });

  const cancelled = page.waitForResponse(
    (response) => response.request().method() === "DELETE",
  );
  await work.getByRole("button", { name: `Change ${TIMER_INTENT}` }).click();
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  await expect(timer).toHaveCount(0);
  await cancelled;
  // Work reads the server again, so the cancel stays.
  await page.reload();
  await expect(alert).toBeVisible();
  await expect(timer).toHaveCount(0);
});

test("shows Watches in the mobile details sheet", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: mobile.height, width: mobile.width });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
  );
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await conversationMenuRow(page, "Conversation details").click();
  const details = page.getByRole("dialog", { name: "Conversation details" });
  await expect(
    details.getByRole("button", { name: `Change ${TIMER_INTENT}` }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: `Change ${ALERT_INTENT}` }),
  ).toBeVisible();
  await screenshot(page, "conversation-details-watches", {
    lightTheme: true,
    view: "mobile",
  });
});

test("shows no row menu to a viewer who does not take part", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
  );
  const work = page
    .getByRole("complementary", { name: "Conversation details", exact: true })
    .getByRole("region", { exact: true, name: "Work" });
  await expect(
    work.getByText("Check whether CI recovered after the retry."),
  ).toBeVisible();
  await expect(work.getByRole("button", { name: /^Change / })).toHaveCount(0);
});
