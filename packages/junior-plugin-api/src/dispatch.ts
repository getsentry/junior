import { z } from "zod";
import { dispatchOptionsSchema } from "./schemas";

export type DispatchOptions = z.output<typeof dispatchOptionsSchema>;

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
