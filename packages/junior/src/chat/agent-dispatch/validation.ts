import type { BoundDispatchOptions, DispatchOptions } from "./types";
import { verifySlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { isDmChannel } from "@/chat/slack/client";
import { isSlackConversationId, isSlackTeamId } from "@/chat/slack/ids";
import { isActorUserId } from "@/chat/services/requester-identity";

const MAX_DISPATCH_INPUT_LENGTH = 32_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_KEY_LENGTH = 128;
const MAX_METADATA_VALUE_LENGTH = 512;

/** Validate plugin-provided dispatch options before core persists them. */
export function validateDispatchOptions(options: DispatchOptions): void {
  if (!options.idempotencyKey.trim()) {
    throw new Error("Dispatch idempotencyKey is required");
  }
  if (options.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error("Dispatch idempotencyKey exceeds the maximum length");
  }
  if (options.destination.platform !== "slack") {
    throw new Error("Dispatch destination platform must be slack");
  }
  if (!isSlackTeamId(options.destination.teamId)) {
    throw new Error("Dispatch destination teamId must be a Slack team id");
  }
  if (!isSlackConversationId(options.destination.channelId)) {
    throw new Error(
      "Dispatch destination channelId must be a Slack channel id",
    );
  }
  if (!options.input.trim()) {
    throw new Error("Dispatch input is required");
  }
  if (options.input.length > MAX_DISPATCH_INPUT_LENGTH) {
    throw new Error("Dispatch input exceeds the maximum length");
  }
  if (options.credentialSubject) {
    if (options.credentialSubject.type !== "user") {
      throw new Error("Dispatch credentialSubject type must be user");
    }
    if (!isActorUserId(options.credentialSubject.userId)) {
      throw new Error("Dispatch credentialSubject userId is required");
    }
    if (
      options.credentialSubject.allowedWhen !== "private-direct-conversation"
    ) {
      throw new Error(
        "Dispatch credentialSubject allowedWhen must be private-direct-conversation",
      );
    }
    if (!isDmChannel(options.destination.channelId)) {
      throw new Error(
        "Dispatch credentialSubject requires a private direct Slack destination",
      );
    }
  }
  const metadata = options.metadata ?? {};
  const entries = Object.entries(metadata);
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
