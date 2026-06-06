import type { DispatchOptions } from "@sentry/junior-plugin-api";
import type { BoundDispatchOptions } from "./types";
import { verifySlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { isDmChannel } from "@/chat/slack/client";
import { isSlackConversationId, isSlackTeamId } from "@/chat/slack/ids";
import { isActorUserId } from "@/chat/services/requester-identity";

const MAX_DISPATCH_INPUT_LENGTH = 32_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_KEY_LENGTH = 128;
const MAX_METADATA_VALUE_LENGTH = 512;

function hasOnlyDestinationKeys(destination: Record<string, unknown>): boolean {
  return Object.keys(destination).every(
    (key) => key === "platform" || key === "teamId" || key === "channelId",
  );
}

/** Validate plugin-provided dispatch options before core persists them. */
export function validateDispatchOptions(options: DispatchOptions): void {
  const candidate = options as Partial<DispatchOptions> | undefined;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Dispatch options are required");
  }
  if (
    typeof candidate.idempotencyKey !== "string" ||
    !candidate.idempotencyKey.trim()
  ) {
    throw new Error("Dispatch idempotencyKey is required");
  }
  if (candidate.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error("Dispatch idempotencyKey exceeds the maximum length");
  }
  const destination = candidate.destination as
    | Partial<DispatchOptions["destination"]>
    | undefined;
  if (
    !destination ||
    typeof destination !== "object" ||
    destination.platform !== "slack"
  ) {
    throw new Error("Dispatch destination platform must be slack");
  }
  if (!hasOnlyDestinationKeys(destination)) {
    throw new Error("Dispatch destination must not include unknown fields");
  }
  if (
    typeof destination.teamId !== "string" ||
    !isSlackTeamId(destination.teamId)
  ) {
    throw new Error("Dispatch destination teamId must be a Slack team id");
  }
  if (
    typeof destination.channelId !== "string" ||
    !isSlackConversationId(destination.channelId)
  ) {
    throw new Error(
      "Dispatch destination channelId must be a Slack channel id",
    );
  }
  if (typeof candidate.input !== "string" || !candidate.input.trim()) {
    throw new Error("Dispatch input is required");
  }
  if (candidate.input.length > MAX_DISPATCH_INPUT_LENGTH) {
    throw new Error("Dispatch input exceeds the maximum length");
  }
  const credentialSubject = candidate.credentialSubject;
  if (credentialSubject !== undefined) {
    if (!credentialSubject || typeof credentialSubject !== "object") {
      throw new Error("Dispatch credentialSubject type must be user");
    }
    if (credentialSubject.type !== "user") {
      throw new Error("Dispatch credentialSubject type must be user");
    }
    if (!isActorUserId(credentialSubject.userId)) {
      throw new Error("Dispatch credentialSubject userId is required");
    }
    if (credentialSubject.allowedWhen !== "private-direct-conversation") {
      throw new Error(
        "Dispatch credentialSubject allowedWhen must be private-direct-conversation",
      );
    }
    if (!isDmChannel(destination.channelId)) {
      throw new Error(
        "Dispatch credentialSubject requires a private direct Slack destination",
      );
    }
  }
  const metadata = candidate.metadata;
  const entries: [string, unknown][] = [];
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("Dispatch metadata values must be strings");
    }
    entries.push(...Object.entries(metadata));
  }
  if (entries.length > MAX_METADATA_KEYS) {
    throw new Error("Dispatch metadata has too many keys");
  }
  for (const [key, value] of entries) {
    if (!key.trim() || typeof value !== "string") {
      throw new Error("Dispatch metadata values must be strings");
    }
    if (key.length > MAX_METADATA_KEY_LENGTH) {
      throw new Error("Dispatch metadata key exceeds the maximum length");
    }
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new Error("Dispatch metadata value exceeds the maximum length");
    }
  }
}

/** Verify runtime-owned access requirements for delegated dispatch credentials. */
export async function verifyDispatchCredentialSubjectAccess(
  options: BoundDispatchOptions,
): Promise<void> {
  if (!options.credentialSubject) {
    return;
  }

  const verified = verifySlackDirectCredentialSubject({
    channelId: options.destination.channelId,
    teamId: options.destination.teamId,
    subject: options.credentialSubject,
  });
  if (!verified) {
    throw new Error(
      "Dispatch credentialSubject must match the private direct Slack destination",
    );
  }
}
