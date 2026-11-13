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
    /Junior 4\.2 launch demo/,
  ]) {
    await expect(page.getByRole("link", { name }).first()).toBeVisible();
  }
}

// The paragraph of the release reply that links to six kinds of objects.
function linksParagraph(page: Page) {
  return page.locator("p", { hasText: "Deployment is ready." });
}

test("links to saved objects show as a titled link, a hover card, and a card", async ({
  page,
  dashboard,
}) => {
  await page.route("**/api/images/payments-91-after**", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  // A bare URL in a sentence is a plain link with the title, and no status.
  const link = page.getByRole("link", {
    name: "getsentry/junior#2201",
    exact: true,
  });
  await expect(link).toHaveAttribute(
    "href",
    "https://github.com/getsentry/junior/pull/2201",
  );
  await expect(
    page.getByText("https://github.com/getsentry/junior/pull/2201"),
  ).toHaveCount(0);

  // A bare URL on its own line is the full card. Its description images
  // load through the Junior image route, never from their own host.
  const card = page.getByRole("region", {
    name: "Pull request: Pin the release train to payments 4.2",
  });
  await expect(card).toBeVisible();
  // The reply links to it on its own line twice, so the second is a link.
  await expect(card).toHaveCount(1);
  await expect(
    page.getByRole("link", {
      name: "Pin the release train to payments 4.2 (#91)",
    }),
  ).toBeVisible();
  const before = card.getByRole("img", { name: "Description image 1" });
  await expect(before).toHaveAttribute(
    "src",
    "/api/images/payments-91-before?w=320",
  );
  await expect(before).toHaveAttribute(
    "srcset",
    "/api/images/payments-91-before?w=320 1x, /api/images/payments-91-before?w=640 2x",
  );
  // The image route answers 404 to a viewer who cannot see the source.
  // That image does not render.
  await expect(
    card.getByRole("img", { name: "Description image 2" }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      before.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);

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

test("links without an Annotation resolve to plain links, a person chip, and a hover card", async ({
  page,
  dashboard,
}) => {
  // The screenshot uses this size. A resize would move the link from under
  // the pointer and close the hover card.
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  // The reply links to another Conversation that has no saved Annotation.
  const link = page.getByRole("link", {
    name: "Investigate checkout latency",
    exact: true,
  });
  await expect(link).toHaveAttribute(
    "href",
    `https://junior.example.com/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
  );
  await waitForResolvedLinks(page);

  // Only the person keeps a chip: its icon is the one icon in the
  // paragraph. The other links show no icon, status, or outbound mark.
  const paragraph = linksParagraph(page);
  const person = paragraph.getByRole("link", { name: "Morgan Lee" });
  await expect(person.locator("svg, img")).toHaveCount(1);
  await expect(paragraph.locator("svg, img")).toHaveCount(1);
  await expect(paragraph).not.toContainText("·");
  await expect(paragraph).not.toContainText("Running");

  await link.hover();
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

test("Google Doc and Calendar links resolve to links and hover cards", async ({
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
      .getByRole("link", { name: "Investigate checkout latency", exact: true })
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

test("a Slack message link resolves to a link, a card, and a hover card", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  const link = linksParagraph(page).getByRole("link", {
    name: "#proj-release",
  });
  await expect(link).toHaveAttribute(
    "href",
    "https://acme.slack.com/archives/CQA456/p1770021700000100",
  );
  // The reply also links to it on its own line, which shows the card.
  const card = page.getByRole("region", {
    name: /^Message: Release notes are ready for review/,
  });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Morgan Lee");
  await waitForResolvedLinks(page);
  await link.hover();
  await expect(card).toHaveCount(2);
  await screenshot(page, "conversation-slack-message-link", {
    lightTheme: true,
    view: "desktop",
  });
});

test("a public web page link resolves to a link, a card, and a hover card", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  // A bare URL on its own line is the full card, with its thumbnail.
  const post = page.getByRole("region", {
    name: "Web page: What's new in Release 4.2",
  });
  await expect(post).toContainText("Example Blog");
  await expect(post.locator("img")).toHaveJSProperty("complete", true);
  await screenshot(page, "conversation-web-page-card", {
    lightTheme: true,
    target: post,
    view: "desktop",
  });

  // A video on its own line shows only its thumbnail.
  const thumbnail = page.getByRole("img", { name: "Junior 4.2 launch demo" });
  await expect(thumbnail).toHaveAttribute("src", /^\/api\/images\//);
  await expect(
    page.getByRole("link").filter({ has: thumbnail }),
  ).toHaveAttribute("href", "https://www.youtube.com/watch?v=MockLaunchDemo");

  const link = linksParagraph(page).getByRole("link", {
    name: "Junior 4.2 launch demo",
  });
  await expect(link).toHaveAttribute(
    "href",
    "https://www.youtube.com/watch?v=MockLaunchDemo",
  );
  await waitForResolvedLinks(page);
  await link.hover();
  const card = page.getByRole("region", {
    name: "Web page: Junior 4.2 launch demo",
  });
  await expect(card).toContainText("YouTube");
  await expect(card.locator("img")).toHaveAttribute("src", /^\/api\/images\//);
  await screenshot(page, "conversation-web-page-link", {
    lightTheme: true,
    view: "desktop",
  });
});

test("a hover card opens only after a short delay", async ({
  page,
  dashboard,
}) => {
  await page.clock.install();
  await page.setViewportSize(desktop);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(CONVERSATION_ID)}`,
  );
  await waitForResolvedLinks(page);
  const link = linksParagraph(page).getByRole("link", {
    name: "Release 4.2 checklist",
  });
  const card = page.getByRole("region", {
    name: "Google Doc: Release 4.2 checklist",
  });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await link.hover();
  // A pointer that only passes over the link opens no card.
  await page.clock.runFor(250);
  await expect(card).toBeHidden();
  await page.clock.runFor(200);
  await expect(card).toBeVisible();
});
