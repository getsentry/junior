import { z } from "zod";
import {
  destinationVisibilitySchema,
  dispatchOptionsSchema,
  identityDispatchOptionsSchema,
  replyAttributionSchema,
  taskOutcomeSchema,
} from "./schemas";

export type DestinationVisibility = z.output<
  typeof destinationVisibilitySchema
>;
export type DispatchOptions = z.output<typeof dispatchOptionsSchema>;
export type IdentityDispatchOptions = z.output<
  typeof identityDispatchOptionsSchema
>;
/** Compact destination-visible context explaining what produced a reply. */
export type ReplyAttribution = z.output<typeof replyAttributionSchema>;
export type TaskOutcome = z.output<typeof taskOutcomeSchema>;

export interface DispatchResult {
  id: string;
  status: "created" | "already_exists";
}

/**
 * Result of an Identity dispatch. `not_linked` means core found no current
 * Slack member linked to the Identity, so it started no work.
 */
export type IdentityDispatchResult = DispatchResult | { status: "not_linked" };

export interface Dispatch {
  errorMessage?: string;
  id: string;
  resultMessageTs?: string;
  status:
    | "pending"
    | "running"
    | "awaiting_resume"
    | "completed"
    | "failed"
    | "blocked";
}
