import type { Page } from "@playwright/test";
import { screenshot } from "./screenshot";
import { expect, test } from "./test";

const viewer = {
  displayName: "Dashboard User",
  email: "dev@example.com",
  userId: "u-dev",
};

const base = {
  addedByConversationId: "slack:CREVIEW:1770003600.000200",
  assignedToEveryone: false,
  assignees: [viewer],
  canAct: true,
  canTake: false,
  conversationIds: [],
  createdAt: "2026-08-07T08:00:00.000Z",
  kind: "action" as const,
  status: "open" as const,
  updatedAt: "2026-08-07T08:30:00.000Z",
  visibility: "public" as const,
};

const rollout = {
  ...base,
  body: "Canary error rate is flat.",
  id: "item-rollout",
  request: {
    question: "Roll out payments-v42?",
    fields: [
      {
        id: "go",
        kind: "choice",
        label: "Rollout",
        options: [{ label: "Roll out" }, { label: "Hold" }],
      },
    ],
  },
  title: "Approve the payments-v42 rollout",
};

const license = {
  ...base,
  body: "The acme entry changed its license.",
  id: "item-license",
  request: {
    question: "Does acme still meet the definition?",
    fields: [
      {
        id: "decision",
        kind: "choice",
        label: "Decision",
        options: [{ label: "Approve" }, { label: "Reject" }],
      },
      { id: "reason", kind: "text", label: "Reason" },
    ],
  },
  title: "Review the acme license entry",
};

const audit = {
  ...license,
  id: "item-audit",
  title: "Review the globex license entry",
};

const prReady = {
  ...base,
  body: "Junior opened a pull request for the payments retry fix.",
  id: "item-pr-ready",
  kind: "notice" as const,
  subject: {
    id: "acme/payments#42",
    title: "fix(payments): Retry declined webhooks",
    url: "https://github.com/acme/payments/pull/42",
  },
  title: "Pull request ready for review",
};

const answered = {
  ...license,
  answer: {
    requestId: "request-initech",
    values: { decision: ["Approve"], reason: ["MIT license, no change."] },
  },
  body: "The initech entry changed its license.",
  closedAt: "2026-08-07T09:00:00.000Z",
  closedBy: viewer,
  id: "item-initech",
  status: "done" as const,
  title: "Review the initech license entry",
};

async function mockReviewItems(page: Page) {
  const actions: { body: unknown; id: string }[] = [];
  const open = [rollout, license, audit, prReady];
  const archived = [answered];
  const items = [...open, ...archived];
  await page.route("**/api/review-items**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/review-items/, "");
    if (path === "/count") return route.fulfill({ json: { mine: 3 } });
    if (path === "" || path === "/") {
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      const list =
        url.searchParams.get("archived") === "true" ? archived : open;
      return route.fulfill({
        json: { items: list.filter((i) => i.title.toLowerCase().includes(q)) },
      });
    }
    const action = path.match(/^\/([^/]+)\/actions$/);
    if (action) {
      actions.push({
        body: route.request().postDataJSON(),
        id: decodeURIComponent(action[1]!),
      });
      return route.fulfill({ json: { ok: true } });
    }
    const item = items.find((i) => i.id === decodeURIComponent(path.slice(1)));
    return item
      ? route.fulfill({ json: item })
      : route.fulfill({ json: { error: "Not found" }, status: 404 });
  });
  return actions;
}

test("each review item gets a fresh answer form", async ({
  dashboard,
  page,
}) => {
  const actions = await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/review?item=${license.id}`);
  const detail = page.getByRole("article");
  await expect(
    detail.getByRole("heading", { name: license.title }),
  ).toBeVisible();

  // A choice on one item must not carry over to the next item.
  await detail.getByRole("radio", { name: "Approve" }).click();
  await expect(detail.getByRole("radio", { name: "Approve" })).toBeChecked();
  await page.getByRole("link", { name: new RegExp(audit.title) }).click();
  await expect(
    detail.getByRole("heading", { name: audit.title }),
  ).toBeVisible();
  await expect(
    detail.getByRole("radio", { name: "Approve" }),
  ).not.toBeChecked();

  // A sent answer must not lock the form of the next item.
  await page.getByRole("link", { name: new RegExp(rollout.title) }).click();
  await detail.getByRole("button", { name: "Roll out" }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({
    body: { action: "submit", answer: { values: { go: ["Roll out"] } } },
    id: rollout.id,
  });
  await page.getByRole("link", { name: new RegExp(license.title) }).click();
  await expect(
    detail.getByRole("heading", { name: license.title }),
  ).toBeVisible();
  await detail.getByRole("radio", { name: "Reject" }).click();
  await detail.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => actions.length).toBe(2);
  expect(actions[1]).toMatchObject({
    body: { action: "submit", answer: { values: { decision: ["Reject"] } } },
    id: license.id,
  });
});

test("the review desk lists open items, search results, and archived items", async ({
  dashboard,
  page,
}) => {
  await mockReviewItems(page);
  await page.goto(`${dashboard.baseURL}/review`);
  const detail = page.getByRole("article");
  await expect(
    detail.getByRole("heading", { name: rollout.title }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: new RegExp(prReady.title) }),
  ).toBeVisible();
  await screenshot(page, "review-desk", { lightTheme: true });

  await page.getByLabel("Search review items").fill("acme");
  await expect(page).toHaveURL(/[?&]q=acme/);
  await expect(
    page.getByRole("link", { name: new RegExp(audit.title) }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: new RegExp(license.title) }),
  ).toBeVisible();
  await screenshot(page, "review-desk-search", { view: "desktop" });
  await page.getByLabel("Search review items").fill("");
  await expect(page).not.toHaveURL(/[?&]q=/);

  await page.getByRole("button", { name: "Show archived" }).click();
  await expect(page).toHaveURL(/[?&]archived=true/);
  await expect(
    detail.getByRole("heading", { name: answered.title }),
  ).toBeVisible();
  await screenshot(page, "review-desk-archived");
});
