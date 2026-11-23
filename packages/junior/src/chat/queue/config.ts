import { toOptionalTrimmed } from "@/chat/optional-string";

/** Settings for the Vercel Queues client. */
export interface QueueConfig {
  /** Vercel Queues API base URL, for a local queue server. */
  apiUrl?: string;
}

function readApiUrl(value: string | undefined): string | undefined {
  const raw = toOptionalTrimmed(value);
  if (raw === undefined) {
    return undefined;
  }
  const protocol = URL.parse(raw)?.protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("JUNIOR_QUEUE_API_URL must be an http or https URL");
  }
  return raw;
}

/** Read queue settings from environment variables. */
export function readQueueConfig(env: NodeJS.ProcessEnv): QueueConfig {
  const apiUrl = readApiUrl(env["JUNIOR_QUEUE_API_URL"]);
  return apiUrl ? { apiUrl } : {};
}
