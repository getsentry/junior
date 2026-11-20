import { expect, test } from "./test";
import { mobile, screenshot } from "./screenshot";

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const TIMER_INTENT = "Remind Morgan to confirm the rollback window.";
const ALERT_INTENT = "Post when the checkout p95 alert resolves.";

test("lists a Conversation's Watches and cancels one", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
  );
  const details = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  const timer = details.getByRole("button", {
    name: `${TIMER_INTENT} fires in 25 minutes`,
  });
  const alert = details.getByRole("button", {
    name: `${ALERT_INTENT} expires in 3 days`,
  });
  await expect(timer).toBeVisible();
  await expect(alert).toBeVisible();
  await screenshot(page, "conversation-details-watches", {
    lightTheme: true,
    target: details,
    view: "desktop",
  });

  await details.getByRole("button", { name: `Cancel ${TIMER_INTENT}` }).click();
  await expect(timer).toHaveCount(0);
  // The list reads the server again, so the cancel stays.
  await page.reload();
  await expect(alert).toBeVisible();
  await expect(timer).toHaveCount(0);

  // A failed cancel brings the Watch back.
  let failCancel = () => {};
  const cancelFails = new Promise<void>((resolve) => {
    failCancel = resolve;
  });
  await page.route("**/watches/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await cancelFails;
    await route.fulfill({ json: { error: "Cancel failed." }, status: 500 });
  });
  await details.getByRole("button", { name: `Cancel ${ALERT_INTENT}` }).click();
  await expect(alert).toHaveCount(0);
  failCancel();
  await expect(alert).toBeVisible();
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
  await page
    .getByRole("menuitem", { name: "Conversation details", exact: true })
    .click();
  const details = page.getByRole("dialog", { name: "Conversation details" });
  await expect(
    details.getByRole("button", { name: `Cancel ${TIMER_INTENT}` }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: `Cancel ${ALERT_INTENT}` }),
  ).toBeVisible();
  await screenshot(page, "conversation-details-watches", {
    lightTheme: true,
    view: "mobile",
  });
});

test("shows no Cancel to a viewer who does not take part", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent("internal:dashboard-qa")}`,
  );
  const details = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  await expect(
    details.getByRole("button", {
      name: "Check whether CI recovered after the retry. fires in 2 hours",
    }),
  ).toBeVisible();
  await expect(details.getByRole("button", { name: /^Cancel / })).toHaveCount(
    0,
  );
});
