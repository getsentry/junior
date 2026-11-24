import type { Locator } from "@playwright/test";
import { desktop, mobile, screenshot } from "../screenshot";
import { expect, test } from "../test";

const ASK = "I need your go-ahead before I roll out to every region.";

/** Whether `first` comes before `second` in the document. */
async function precedes(first: Locator, second: Locator) {
  const handle = await second.elementHandle();
  return first.evaluate(
    (node, other) =>
      Boolean(
        other &&
        node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    handle,
  );
}

test.describe("new UI", () => {
  for (const view of [desktop, mobile]) {
    test(`an Inbox question shows its question, then Junior's message, then the form (${view.name})`, async ({
      dashboard,
      page,
    }) => {
      await page.setViewportSize(view);
      const actions: unknown[] = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/actions")) {
          actions.push(request.postDataJSON());
        }
      });
      // The mock's own question, which waits on the viewer.
      await page.goto(`${dashboard.baseURL}/inbox?view=inbox&item=qa-rollout`);
      const row = page
        .locator("[data-inbox-row]")
        .filter({ hasText: "Approve the payments-v42 rollout" });
      const question = row.getByRole("region", { name: "Question" });
      await expect(question).toContainText(
        "Roll out payments-v42 to every region?",
      );
      const message = row.getByRole("region", { name: "Junior's message" });
      await expect(message).toContainText(ASK);
      expect(await precedes(question, message)).toBe(true);
      const hold = row.getByRole("button", { name: "Hold", exact: true });
      expect(await precedes(message, hold)).toBe(true);
      // The row's head and Related link the subject, so no preview card
      // repeats it.
      await expect(row.locator("[data-subject-card]")).toHaveCount(0);
      await expect(
        row
          .getByRole("region", { name: "Related" })
          .getByRole("link", { name: "Hold the payments-v42 deploy" }),
      ).toBeVisible();
      await screenshot(page, "inbox-question-card", {
        lightTheme: true,
        view: view.name,
      });

      // A click picks; Send answers.
      await hold.click();
      await expect(hold).toHaveAttribute("aria-pressed", "true");
      expect(actions).toEqual([]);
      await row.getByRole("button", { name: "Send", exact: true }).click();
      await expect
        .poll(() => actions)
        .toEqual([{ action: "submit", answer: { values: { go: ["Hold"] } } }]);
    });
  }
});
