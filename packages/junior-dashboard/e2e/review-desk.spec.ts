import type { Page } from "@playwright/test";
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

async function mockReviewItems(page: Page) {
  const actions: { body: unknown; id: string }[] = [];
  const items = [rollout, license, audit];
  await page.route("**/api/review-items**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/review-items/, "");
    if (path === "/count") return route.fulfill({ json: { mine: 3 } });
    if (path === "" || path === "/") return route.fulfill({ json: { items } });
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
