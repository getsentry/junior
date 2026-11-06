import { expect, test } from "./test";
import {
  mockReadPositionConversation,
  recordPageRequests,
} from "./read-position-fixture";
import { screenshot } from "./screenshot";

test("opens links outside the loaded rows from the page around them", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const mock = await mockReadPositionConversation(page, {
    eventCount: 120,
    lastReadSeq: 10,
  });
  mock.pagedDetail = true;
  mock.turnStartSeq = 30;
  const pageRequests = recordPageRequests(page);
  const linked = page.getByRole("complementary", {
    name: "Event details",
    exact: true,
  });
  // One request reads the page around the linked event. Nothing pages
  // toward it, and the page around the read position is not read. Pages
  // next to it then load as the reader nears them.
  await page.goto(
    `${dashboard.baseURL}/conversations/${mock.conversationId}?event=70`,
  );
  await expect(linked).toContainText("Transcript message 70 ");
  const log = page.getByRole("region", { name: "Conversation event log" });
  await expect(
    log.getByRole("button", { name: "Event 70: message", exact: true }),
  ).toBeInViewport();
  await screenshot(page, "conversation-link-opens-around-event");
  expect(
    pageRequests.filter((query) => !/^\?(after|before)=/.test(query)),
  ).toEqual(["?event=70"]);

  // A Turn link opens at the event that started the Turn.
  pageRequests.length = 0;
  await page.goto(
    `${dashboard.baseURL}/conversations/${mock.conversationId}?turn=turn-30`,
  );
  await expect(page).toHaveURL(/[?&]event=30(&|$)/);
  await expect(
    log.getByRole("button", { name: "Event 30: turn_lifecycle", exact: true }),
  ).toBeInViewport();
  expect(
    pageRequests.filter((query) => !/^\?(after|before)=/.test(query)),
  ).toEqual(["?turn=turn-30"]);

  // A link that the server cannot find is dropped.
  await page.goto(
    `${dashboard.baseURL}/conversations/${mock.conversationId}?turn=turn-missing`,
  );
  await expect(page).not.toHaveURL(/[?&](turn|event)=/);
  await expect(linked).toBeHidden();
});

test("opens a link that the cached latest page holds at its row", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const mock = await mockReadPositionConversation(page, {
    eventCount: 120,
    lastReadSeq: 10,
  });
  mock.pagedDetail = true;
  const pageRequests = recordPageRequests(page);
  // A hover caches the latest page, which holds event 100.
  await page.goto(dashboard.baseURL);
  const prefetched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      `/api/conversations/${mock.conversationId}`,
  );
  await page
    .getByRole("link", { name: /Read position/ })
    .first()
    .hover();
  await prefetched;
  await page.evaluate((url) => {
    history.pushState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/conversations/${mock.conversationId}?event=100`);
  await expect(
    page.getByRole("complementary", { name: "Event details", exact: true }),
  ).toContainText("Transcript message 100 ");
  await expect(
    page
      .getByRole("region", { name: "Conversation event log" })
      .getByRole("button", { name: "Event 100: message", exact: true }),
  ).toBeInViewport();
  // The link wins over the read position, so no page around it loads.
  expect(pageRequests.filter((query) => query.startsWith("?around="))).toEqual(
    [],
  );
});

test("opens at the latest event when a link at open fails", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const mock = await mockReadPositionConversation(page, {
    eventCount: 120,
    lastReadSeq: 119,
  });
  mock.pagedDetail = true;
  // A hover caches the latest page, so it shows while the link loads.
  await page.goto(dashboard.baseURL);
  const prefetched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      `/api/conversations/${mock.conversationId}`,
  );
  await page
    .getByRole("link", { name: /Read position/ })
    .first()
    .hover();
  await prefetched;
  await page.evaluate((url) => {
    history.pushState(null, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/conversations/${mock.conversationId}?turn=turn-missing`);
  await expect(page).not.toHaveURL(/[?&](turn|event)=/);
  await expect(
    page
      .getByRole("region", { name: "Conversation event log" })
      .getByRole("button", { name: "Event 119: message", exact: true }),
  ).toBeInViewport();
  await screenshot(page, "conversation-failed-link-opens-at-latest");
});

test("opens a memory outside the loaded rows from the page around it", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const mock = await mockReadPositionConversation(page, {
    eventCount: 120,
    lastReadSeq: 119,
  });
  mock.pagedDetail = true;
  // The shared memory mock says that event 13 captured two memories.
  mock.memoryCaptureSeq = 13;
  const pageRequests = recordPageRequests(page);
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText("Transcript message 119 ")).toBeVisible();

  const details = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  await details
    .getByRole("button", { name: "1 recalled · 2 captured" })
    .click();
  await details
    .getByRole("listitem")
    .filter({ hasText: "Dashboard transcript events should remain" })
    .getByRole("button", { name: "Go to message" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Captured 2 memories" }),
  ).toBeVisible();
  expect(pageRequests).toEqual(["?event=13"]);
  await screenshot(page, "conversation-memory-opens-around-event");
});
