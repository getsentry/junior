/**
 * Real images for tests that send one to Junior. The vision model reads the
 * pixels, so a test can ask for a fact that only the image has.
 */
import { readFileSync } from "node:fs";

/** The number that `ticketScreenshotPng()` shows. */
export const TICKET_NUMBER = "4729";

/** A PNG that shows the text "Ticket #4729" in black on white. */
export function ticketScreenshotPng(): Buffer {
  return readFileSync(new URL("./images/ticket-4729.png", import.meta.url));
}
