import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  test("an open Inbox card shows its facts behind Details", async ({
    dashboard,
    page,
  }) => {
    // The mock's own question, which links the rollback Conversation.
    await page.goto(`${dashboard.baseURL}/inbox?view=inbox&item=qa-rollout`);
    const card = page.getByRole("region", {
      exact: true,
      name: "Approve the payments-v42 rollout",
    });
    const details = card.getByRole("button", { name: "Details" });
    // Closed, the facts do not mount.
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await expect(card.getByRole("region", { name: "Details" })).toHaveCount(0);

    await details.click();
    await expect(details).toHaveAttribute("aria-expanded", "true");
    const facts = card.getByRole("region", { name: "Details" });
    await expect(facts).toMatchAriaSnapshot(`
      - term: Assignees
      - definition:
        - link "Dashboard User":
          - /url: /people/dev%40example.com
      - term: Added
      - definition: 26 minutes ago
      - term: Added by
      - definition:
        - link "Roll out payments-v42":
          - /url: /conversations/internal%3Aquestion-qa?turn=qa-turn-rollout
      - term: Visibility
      - definition: Public
      - term: Linked conversations
      - definition:
        - list:
          - listitem:
            - link "Roll out payments-v42":
              - /url: /conversations/internal%3Aquestion-qa
          - listitem:
            - link "Checkout latency triage":
              - /url: /conversations/slack%3ACQA123%3A1770000000.000100
    `);
    await facts.getByRole("link", { name: "Checkout latency triage" }).click();
    await expect(page).toHaveURL(
      /\/conversations\/slack%3ACQA123%3A1770000000\.000100$/,
    );
  });

  test("an Automation's alert names its Automation as what added it", async ({
    dashboard,
    page,
  }) => {
    await page.goto(
      `${dashboard.baseURL}/inbox?view=inbox&item=qa-alert-operations-digest`,
    );
    const card = page.getByRole("region", {
      exact: true,
      name: "Daily operations digest",
    });
    await card.getByRole("button", { name: "Details" }).click();
    await expect(card.getByRole("definition").filter({ hasText: "Automation" }))
      .toMatchAriaSnapshot(`
      - definition:
        - link "Automation":
          - /url: /automations/scheduled-2
    `);
  });
});
