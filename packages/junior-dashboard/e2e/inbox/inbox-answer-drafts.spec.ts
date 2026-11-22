import { license, mockInboxItems } from "./inbox-fixture";
import { expect, test } from "../test";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  test("a row keeps unsent answers after it collapses or reloads", async ({
    dashboard,
    page,
  }) => {
    const actions = await mockInboxItems(page, { open: [license] });
    await page.goto(`${dashboard.baseURL}/`);
    const asks = page.getByRole("region", { name: /: asks$/ });
    const question = asks.getByRole("region", { name: license.title });
    const expand = () =>
      page
        .getByRole("region", { name: "To do" })
        .locator('[aria-controls^="inbox-row-"]')
        .first()
        .click();

    await expand();
    await question.getByRole("radio", { name: "Approve" }).click();
    await question.getByLabel("Reason").fill("MIT license, no");
    // A click in empty page space collapses the row.
    await page.mouse.click(5, 700);
    await expect(asks).toHaveCount(0);

    await expand();
    await expect(
      question.getByRole("radio", { name: "Approve" }),
    ).toBeChecked();
    await expect(question.getByLabel("Reason")).toHaveValue("MIT license, no");

    await page.reload();
    await expand();
    await expect(
      question.getByRole("radio", { name: "Approve" }),
    ).toBeChecked();
    await expect(question.getByLabel("Reason")).toHaveValue("MIT license, no");

    await question.getByLabel("Reason").fill("MIT license, no change.");
    // The row drops the item at once. The draft clears when the server
    // accepts the answer.
    const accepted = page.waitForResponse((response) =>
      response.url().includes(`/api/inbox-items/${license.id}/actions`),
    );
    await question.getByRole("button", { name: "Send" }).click();
    await accepted;
    await expect.poll(() => actions.length).toBe(1);
    expect(actions[0]).toMatchObject({
      body: {
        action: "submit",
        answer: {
          values: {
            decision: ["Approve"],
            reason: ["MIT license, no change."],
          },
        },
      },
      id: license.id,
    });
    await expect(question).toHaveCount(0);
    // Served open again, the item shows an empty form.
    await mockInboxItems(page, { open: [license] });
    await page.reload();
    await expand();
    await expect(
      question.getByRole("radio", { name: "Approve" }),
    ).not.toBeChecked();
    await expect(question.getByLabel("Reason")).toHaveValue("");
  });
});
