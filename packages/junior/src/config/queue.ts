// The queue group: the Vercel Queues API.
import * as z from "zod";
import { toOptionalTrimmed } from "@/chat/optional-string";
import type { Env } from "@/config/fields";

function isHttpUrl(value: string): boolean {
  const protocol = URL.parse(value)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

/** Vercel Queues settings. */
export const queueSchema = z
  .strictObject({
    /** Vercel Queues API base URL, for a local queue server. */
    apiUrl: z
      .string()
      .refine(isHttpUrl, "must be an http or https URL")
      .optional(),
  })
  .prefault({});

/** Env var that sets each queue field, for error messages. */
export const queueEnvNames: Record<string, string> = {
  "queue.apiUrl": "JUNIOR_QUEUE_API_URL",
};

function parseQueueApiUrl(rawValue: string | undefined): string | undefined {
  const value = toOptionalTrimmed(rawValue);
  if (value === undefined || isHttpUrl(value)) {
    return value;
  }
  throw new Error("JUNIOR_QUEUE_API_URL must be an http or https URL");
}

/** Read the queue group from env. */
export function readQueueEnv(env: Env) {
  return { apiUrl: parseQueueApiUrl(env["JUNIOR_QUEUE_API_URL"]) };
}
