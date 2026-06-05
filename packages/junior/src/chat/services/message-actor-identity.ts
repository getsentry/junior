import type { Author, Message } from "chat";
import {
  normalizeActorIdentity,
  normalizeActorUserId,
  slackActorIdentity,
  type ActorIdentityInput,
  type SlackActorProfile,
} from "@/chat/services/requester-identity";

const messageActors = new WeakMap<Message, ActorIdentityInput>();

function canonicalUserId(author: Author, identity: ActorIdentityInput): string {
  const authorUserId = normalizeActorUserId(author.userId);
  const identityUserId = normalizeActorUserId(identity.userId);
  if (authorUserId && identityUserId && authorUserId !== identityUserId) {
    throw new Error("Message actor identity user id mismatch");
  }
  const userId = authorUserId ?? identityUserId;
  if (!userId) {
    throw new Error("Message actor identity requires a user id");
  }
  return userId;
}

function actorIdentityFromAuthor(
  author: Author,
): ActorIdentityInput | undefined {
  const userId = normalizeActorUserId(author.userId);
  return userId ? { userId } : undefined;
}

function applyIdentityToAuthor(
  author: Author,
  identity: ActorIdentityInput,
): void {
  if (!identity.userId) {
    throw new Error("Message actor identity requires a user id");
  }
  author.userId = identity.userId;
  author.userName = identity.userName ?? "";
  author.fullName = identity.fullName ?? "";
}

/** Bind canonical actor identity to a Chat SDK message for downstream consumers. */
export function bindMessageActorIdentity(
  message: Message,
  identity: ActorIdentityInput,
): ActorIdentityInput {
  const userId = canonicalUserId(message.author, identity);
  const normalized = normalizeActorIdentity(identity, userId);
  if (!normalized?.userId) {
    throw new Error("Message actor identity requires a user id");
  }
  messageActors.set(message, normalized);
  applyIdentityToAuthor(message.author, normalized);
  return normalized;
}

/** Return canonical actor identity for a message without trusting adapter display fallbacks. */
export function getMessageActorIdentity(
  message: Message,
): ActorIdentityInput | undefined {
  return messageActors.get(message) ?? actorIdentityFromAuthor(message.author);
}

/** Resolve and bind Slack profile-backed actor identity for one message. */
export async function ensureSlackMessageActorIdentity(
  message: Message,
  lookupSlackUser: (
    userId: string,
  ) => Promise<SlackActorProfile | null | undefined>,
): Promise<ActorIdentityInput> {
  const existing = messageActors.get(message);
  if (existing) {
    return existing;
  }
  const userId = normalizeActorUserId(message.author.userId);
  if (!userId) {
    throw new Error("Slack message actor identity requires a user id");
  }
  return bindMessageActorIdentity(
    message,
    slackActorIdentity(userId, await lookupSlackUser(userId)),
  );
}
