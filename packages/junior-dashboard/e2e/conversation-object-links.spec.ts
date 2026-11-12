import { desktop, screenshot } from "./screenshot";
import { expect, test } from "./test";

// The mock release Conversation saves Annotations for these pull requests,
// and its last reply links to them.
const CONVERSATION_ID = "slack:CQA456:1770021600.000600";

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

  // Resolved links render again when their cards arrive, which drops an
  // earlier hover. Wait for them first.
  await expect(
    page.getByRole("link", { name: /Release 4\.2 checklist/ }),
  ).toBeVisible();
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
  await event.hover();
  const eventCard = page.getByRole("region", {
    name: "Calendar event: Release 4.2 go/no-go",
  });
  await expect(eventCard).toContainText("Mon, Feb 2, 15:00 – 15:30 PST");
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
  await screenshot(page, "conversation-google-document-link", {
    lightTheme: true,
    view: "desktop",
  });
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
