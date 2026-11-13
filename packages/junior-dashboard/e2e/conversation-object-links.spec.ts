import type { Page } from "@playwright/test";
import { desktop, screenshot } from "./screenshot";
import { expect, test } from "./test";

// The mock release Conversation saves Annotations for these pull requests,
// and its last reply links to them.
const CONVERSATION_ID = "slack:CQA456:1770021600.000600";

const DOC_URL =
  "https://docs.google.com/document/d/1MockReleaseChecklist_0123456789/edit";

// The mock viewer is not a participant of the release Conversation. Make
// them one, so the cards can attach.
async function viewAsParticipant(
  page: Page,
  extraAnnotations: unknown[] = [],
): Promise<void> {
  await page.route(
    (url) =>
      url.pathname ===
      `/api/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
    async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      await route.fulfill({
        json: {
          ...detail,
          // Linked work lists the newest Annotation first.
          annotations: [...extraAnnotations, ...(detail.annotations ?? [])],
          isParticipant: true,
        },
        response,
      });
    },
  );
}

// Resolved links render again when their cards arrive, which drops an
// earlier hover. Wait for all of them before a hover.
async function waitForResolvedLinks(page: Page): Promise<void> {
  for (const name of [
    /Release 4\.2 checklist/,
    /Release 4\.2 go\/no-go/,
    /#proj-release/,
  ]) {
    await expect(page.getByRole("link", { name })).toBeVisible();
  }
}

test("links to saved objects show as a chip, a hover card, and a card", async ({
  page,
  dashboard,
}) => {
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  // A bare URL in a sentence is a chip with the label and status.
  const chip = page.getByRole("link", {
    name: /getsentry\/junior#2201 · Draft/,
  });
  await expect(chip).toHaveAttribute(
    "href",
    "https://github.com/getsentry/junior/pull/2201",
  );
  await expect(
    page.getByText("https://github.com/getsentry/junior/pull/2201"),
  ).toHaveCount(0);

  // A bare URL on its own line is the full card.
  await expect(
    page.getByRole("region", {
      name: "Pull request: Pin the release train to payments 4.2",
    }),
  ).toBeVisible();

  await waitForResolvedLinks(page);
  // A labeled link keeps its text and previews the card on hover.
  await page.getByRole("link", { name: "relay fix" }).hover();
  await expect(
    page.getByRole("region", { name: /getsentry\/relay#44/ }),
  ).toBeVisible();
  await screenshot(page, "conversation-object-links", {
    lightTheme: true,
    view: "desktop",
  });
});

test("links without an Annotation resolve to a chip and a hover card", async ({
  page,
  dashboard,
}) => {
  // The screenshot uses this size. A resize would move the chip from under
  // the pointer and close the hover card.
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  // The reply links to another Conversation that has no saved Annotation.
  const chip = page.getByRole("link", {
    name: /Investigate checkout latency · Running/,
  });
  await expect(chip).toHaveAttribute(
    "href",
    `https://junior.example.com/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
  );
  await expect(page.getByRole("link", { name: /Morgan Lee/ })).toBeVisible();

  await waitForResolvedLinks(page);
  await chip.hover();
  await expect(
    page.getByRole("region", {
      name: "Conversation: Investigate checkout latency",
    }),
  ).toBeVisible();
  await screenshot(page, "conversation-resolved-object-links", {
    lightTheme: true,
    view: "desktop",
  });
});

test("Google Doc and Calendar links resolve to chips and hover cards", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  const event = page.getByRole("link", { name: /Release 4\.2 go\/no-go/ });
  await expect(event).toHaveAttribute(
    "href",
    /^https:\/\/www\.google\.com\/calendar\/event\?eid=/,
  );
  await waitForResolvedLinks(page);
  await event.hover();
  const eventCard = page.getByRole("region", {
    name: "Calendar event: Release 4.2 go/no-go",
  });
  await expect(eventCard).toContainText("Mon, Feb 2, 15:00 – 15:30 PST");
  await expect(eventCard).toContainText("Decide go or no-go for 4.2.");
  await screenshot(page, "conversation-google-calendar-link", {
    lightTheme: true,
    view: "desktop",
  });

  await page.mouse.move(0, 0);
  await expect(eventCard).toBeHidden();
  const doc = page.getByRole("link", { name: /Release 4\.2 checklist/ });
  await doc.hover();
  const docCard = page.getByRole("region", {
    name: "Google Doc: Release 4.2 checklist",
  });
  await expect(docCard).toContainText("Morgan Lee");
  await expect(docCard).toContainText("Run these steps in order");
  // Only a participant can attach the object.
  await expect(docCard.getByRole("button", { name: "Attach" })).toHaveCount(0);
  await screenshot(page, "conversation-google-document-link", {
    lightTheme: true,
    view: "desktop",
  });
});

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

test("one request asks for the cards of every link in a message", async ({
  page,
  dashboard,
}) => {
  const personUrl = "https://junior.example.com/people/dev%40example.com";
  const conversationUrl = `https://junior.example.com/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`;
  // Move the two links of the reply apart, so that only one is in view.
  await page.route(
    (url) => url.pathname.startsWith("/api/conversations/"),
    async (route) => {
      const response = await route.fetch();
      const text = await response.text();
      const body = text.replace(
        " picks up ",
        ` picks up\\n\\n${"More release notes.\\n\\n".repeat(80)}`,
      );
      await route.fulfill({ body, response });
    },
  );
  const requests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/objects") requests.push(url);
  });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  await expect(page.getByText("More release notes.").first()).toBeAttached();
  await expect(
    page
      .getByRole("link", { name: /Investigate checkout latency · Running/ })
      .or(page.getByRole("link", { name: /Morgan Lee/ }))
      .first(),
  ).toBeVisible();

  const asked = requests.filter((url) =>
    url.searchParams
      .getAll("url")
      .some((link) => link === personUrl || link === conversationUrl),
  );
  expect(asked).toHaveLength(1);
  expect(asked[0]!.searchParams.getAll("url")).toEqual(
    expect.arrayContaining([personUrl, conversationUrl]),
  );
});

test("a Slack message link resolves to a chip and a hover card", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  const chip = page.getByRole("link", { name: /#proj-release/ });
  await expect(chip).toHaveAttribute(
    "href",
    "https://acme.slack.com/archives/CQA456/p1770021700000100",
  );
  await waitForResolvedLinks(page);
  await chip.hover();
  const card = page.getByRole("region", {
    name: /^Message: Release notes are ready for review/,
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Morgan Lee");
  await screenshot(page, "conversation-slack-message-link", {
    lightTheme: true,
    view: "desktop",
  });
});
