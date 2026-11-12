import { screenshot } from "./screenshot";
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
