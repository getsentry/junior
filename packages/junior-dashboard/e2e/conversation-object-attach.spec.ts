import {
  CONVERSATION_ID,
  DOC_URL,
  viewAsParticipant,
  waitForResolvedLinks,
} from "./object-links-fixture";
import { desktop, screenshot } from "./screenshot";
import { expect, test } from "./test";

test("a participant attaches a Google Doc from its hover card", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await viewAsParticipant(page);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  await waitForResolvedLinks(page);
  const doc = page.getByRole("link", { name: /Release 4\.2 checklist/ });
  await doc.hover();
  const docCard = page.getByRole("region", {
    name: "Google Doc: Release 4.2 checklist",
  });
  const attach = docCard.getByRole("button", { name: "Attach" });
  await expect(attach).toBeVisible();
  await screenshot(page, "conversation-object-attach", {
    lightTheme: true,
    view: "desktop",
  });

  const request = page.waitForRequest(
    (candidate) =>
      candidate.method() === "POST" &&
      new URL(candidate.url()).pathname ===
        `/api/conversations/${encodeURIComponent(CONVERSATION_ID)}/annotations`,
  );
  await attach.click();
  // Only the link goes to the API, never the card text.
  expect((await request).postDataJSON()).toEqual({ url: DOC_URL });
  await expect(docCard).toContainText("Attached");
  await expect(attach).toHaveCount(0);
  await screenshot(page, "conversation-object-attached", {
    lightTheme: true,
    view: "desktop",
  });

  // After a reload, Linked work lists the link. It has no facts, so the
  // transcript still shows the live card, as attached.
  await page.reload();
  await expect(
    page
      .getByTestId("conversation-side-panel")
      .getByRole("link", { name: /Release 4\.2 checklist/ }),
  ).toBeVisible();
  const transcript = page.getByTestId("conversation-transcript");
  for (const name of [/Release 4\.2 go\/no-go/, /#proj-release/]) {
    await expect(transcript.getByRole("link", { name })).toBeVisible();
  }
  await transcript
    .getByRole("link", { name: /Release 4\.2 checklist/ })
    .hover();
  await expect(docCard).toContainText("Morgan Lee");
  await expect(docCard).toContainText("Attached");
});

test("a participant sees no Attach slot on the row of a saved object", async ({
  page,
  dashboard,
}) => {
  await viewAsParticipant(page);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  await waitForResolvedLinks(page);
  const card = page.getByRole("region", {
    name: "Pull request: Pin the release train to payments 4.2",
  });
  await expect(card).toBeVisible();
  await expect(card.getByText("Attached", { exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Attach" })).toHaveCount(0);
});

test("the row of a link that an Attach saved shows as attached", async ({
  page,
  dashboard,
}) => {
  const now = new Date().toISOString();
  const url = "https://github.com/getsentry/payments/pull/91";
  await viewAsParticipant(page, [
    {
      kind: "resource_link",
      key: "getsentry/payments#91",
      label: url,
      objectType: "code_change",
      plugin: "github",
      url,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  await waitForResolvedLinks(page);
  const card = page.getByRole("region", {
    name: "Pull request: Pin the release train to payments 4.2",
  });
  await expect(card.getByText("Attached", { exact: true })).toBeVisible();
});

test("a Doc attached by another link shows as attached", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const now = new Date().toISOString();
  await viewAsParticipant(page, [
    {
      kind: "resource_link",
      key: "1MockReleaseChecklist_0123456789",
      label: `${DOC_URL}?usp=sharing`,
      objectType: "document",
      plugin: "google",
      url: `${DOC_URL}?usp=sharing`,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  await waitForResolvedLinks(page);
  await page
    .getByTestId("conversation-transcript")
    .getByRole("link", { name: /Release 4\.2 checklist/ })
    .hover();
  const docCard = page.getByRole("region", {
    name: "Google Doc: Release 4.2 checklist",
  });
  await expect(docCard).toContainText("Attached");
  await expect(docCard.getByRole("button", { name: "Attach" })).toHaveCount(0);
});

test("Linked work shows an attached link's title only to a viewer who can open it", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const now = new Date().toISOString();
  // An attached link saves no title: its label is the link.
  await viewAsParticipant(page, [
    {
      kind: "resource_link",
      key: "1MockReleaseChecklist_0123456789",
      label: DOC_URL,
      objectType: "document",
      plugin: "google",
      url: DOC_URL,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  const linkedWork = page.getByTestId("conversation-side-panel");
  await expect(
    linkedWork.getByRole("link", { name: /Release 4\.2 checklist/ }),
  ).toBeVisible();
  await screenshot(page, "conversation-attached-linked-work", {
    lightTheme: true,
    view: "desktop",
  });

  // A viewer who cannot open the Doc gets no card, so the row is the link.
  await page.route(
    (url) => url.pathname === "/api/objects",
    (route) => route.fulfill({ json: { objects: [] } }),
  );
  await page.reload();
  await expect(linkedWork.getByRole("link", { name: DOC_URL })).toBeVisible();
  await expect(linkedWork).not.toContainText("Release 4.2 checklist");
  await screenshot(page, "conversation-attached-linked-work-denied", {
    lightTheme: true,
    view: "desktop",
  });
});
