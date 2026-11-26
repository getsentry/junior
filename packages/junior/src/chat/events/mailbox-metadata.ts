import { objectTypeSchema, type ObjectType } from "@sentry/junior-plugin-api";
import type { CredentialSubject } from "@/chat/credentials/context";
import type { EventTaskFacts } from "@/chat/events/notification";

// Keep this module light: a module that only reads mailbox metadata imports
// it, not the Event delivery code and what that loads.

/** Resource-event metadata stored on plain mailbox input. */
export type EventMailboxMetadata = {
  kind: "event";
  event: {
    eventKey: string;
    eventType: string;
    namespace: string;
    identifier: string;
    /** Watch that matched the Event. Core Events without a Watch omit it. */
    subscriptionId?: string;
    objectType?: ObjectType | undefined;
    /** Omitted on mailbox input created before summaries were stored separately. */
    trustedSummary?: string;
    /** What an agent update says happened, such as `completed`. */
    status?: string;
  };
  /** Signed timer creator subject. Verified before the Turn uses it. */
  credentialSubject?: CredentialSubject;
  /**
   * Watch task facts. A batch of several Events uses them to write one
   * message. Input without them keeps its own text.
   */
  task?: EventTaskFacts;
} & Record<string, unknown>;

/** Whether mailbox metadata is a plain event wake. */
export function isEventMailboxMetadata(
  value: unknown,
): value is EventMailboxMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "event") {
    return false;
  }
  const event = record["event"];
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }
  const fields = event as Record<string, unknown>;
  return (
    typeof fields["eventKey"] === "string" &&
    typeof fields["eventType"] === "string" &&
    typeof fields["namespace"] === "string" &&
    typeof fields["identifier"] === "string" &&
    (fields["subscriptionId"] === undefined ||
      typeof fields["subscriptionId"] === "string") &&
    (fields["objectType"] === undefined ||
      objectTypeSchema.safeParse(fields["objectType"]).success) &&
    (fields["trustedSummary"] === undefined ||
      typeof fields["trustedSummary"] === "string") &&
    (fields["status"] === undefined || typeof fields["status"] === "string")
  );
}
