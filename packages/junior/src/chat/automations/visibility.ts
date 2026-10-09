/**
 * Automation visibility controls who can find and edit an Automation in the
 * dashboard. By default it follows the Destination. The creator can override
 * it. The override does not change Conversation visibility: run transcripts
 * stay inside the Destination boundary.
 */
import { z } from "zod";

export const automationVisibilitySchema = z.enum(["private", "public"]);

export type AutomationVisibility = z.output<typeof automationVisibilitySchema>;

/** Return the visibility that access checks use. A missing Destination is private. */
export function effectiveAutomationVisibility(
  override: AutomationVisibility | null | undefined,
  destinationVisibility: string | null | undefined,
): AutomationVisibility {
  return (
    override ?? (destinationVisibility === "public" ? "public" : "private")
  );
}

/** Label shown instead of a private Destination name to people outside it. */
export const PRIVATE_DESTINATION_LABEL = "Private channel";
