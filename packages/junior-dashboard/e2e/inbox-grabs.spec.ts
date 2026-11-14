import {
  grab,
  license,
  mockReviewItems,
  rowHead,
  viewer,
} from "./inbox-fixture";
import { expect, test } from "./test";

// An ask that names the viewer and someone else. The server lets the
// viewer take it, but To do offers no take.
const shared = {
  ...license,
  assignees: [
    viewer,
    {
      displayName: "Morgan Lee",
      email: "morgan@example.com",
      userId: "u-morgan",
    },
  ],
  canTake: true,
};

test("To do lists only asks that name the viewer, with no take", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page, { automations: () => 0, open: [shared, grab] });
  await page.goto(`${dashboard.baseURL}/`);
  const todo = page.getByRole("region", { name: "To do" });
  await rowHead(todo, shared.title).click();
  const asks = todo.getByRole("region", { name: /: asks$/ });
  await expect(asks.getByRole("radio").first()).toBeVisible();
  await expect(asks.getByRole("button", { name: /take/i })).toHaveCount(0);

  // The ask for Everyone is up for grabs instead.
  const grabs = page.getByRole("region", { name: "Up for grabs" });
  await expect(rowHead(grabs, grab.title)).toBeVisible();
  await expect(todo.getByText(grab.title)).toHaveCount(0);
});

test("I'll take it moves an ask from Up for grabs to To do", async ({
  dashboard,
  page,
}) => {
  const actions = await mockReviewItems(page, {
    automations: () => 0,
    open: [grab],
  });
  await page.goto(`${dashboard.baseURL}/`);
  const grabs = page.getByRole("region", { name: "Up for grabs" });
  await rowHead(grabs, grab.title).click();
  await grabs.getByRole("button", { name: "I'll take it" }).click();
  await expect
    .poll(() => actions)
    .toEqual([{ body: { action: "take" }, id: grab.id }]);
  const todo = page.getByRole("region", { name: "To do" });
  await expect(rowHead(todo, grab.title)).toBeVisible();
  // The section leaves once nothing is up for grabs.
  await expect(grabs).toHaveCount(0);
});

test("the Inbox badge leaves out Up for grabs", async ({ dashboard, page }) => {
  await mockReviewItems(page, {
    automations: () => 0,
    open: [license, grab],
  });
  await page.goto(`${dashboard.baseURL}/`);
  await expect(
    page.getByRole("region", { name: "Up for grabs" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: /^Inbox/ }),
  ).toHaveAccessibleName("Inbox, 1 waiting");
  await expect(page).toHaveTitle("(1) Inbox - Junior");
});
