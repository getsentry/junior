import { z } from "zod";
import {
  destinationVisibilitySchema,
  dispatchOptionsSchema,
  replyAttributionSchema,
} from "./schemas.js";

export type DestinationVisibility = z.output<
  typeof destinationVisibilitySchema
>;
export type DispatchOptions = z.output<typeof dispatchOptionsSchema>;
/** Compact destination-visible context explaining what produced a reply. */
export type ReplyAttribution = z.output<typeof replyAttributionSchema>;

export interface DispatchResult {
  id: string;
  status: "created" | "already_exists";
}

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
