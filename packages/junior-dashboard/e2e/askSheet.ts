import { expect, type Locator } from "@playwright/test";

/**
 * Return where a transcript record's ask shows. A phone shows the record as
 * one line, and a tap opens the ask in a sheet.
 */
export async function openAsk(record: Locator, phone: boolean) {
  if (!phone) return record;
  // A tap on the record's corner, away from its title, opens it too.
  await record.click({ position: { x: 4, y: 4 } });
  const sheet = record.page().getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}
