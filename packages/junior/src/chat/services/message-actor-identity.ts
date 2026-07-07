import type { Author, Message } from "chat";
import {
  createActor,
  createSlackActor,
  isActorUserId,
  parseActorUserId,
  type SlackActor,
  type SlackActorProfile,
  type UserActor,
} from "@/chat/actor";

const messageActors = new WeakMap<Message, UserActor>();
interface MessageAuthorIdentity {
  email?: string;
  fullName?: string;
  userId: string;
  userName?: string;
}

type MessageActorIdentity = UserActor | MessageAuthorIdentity;

function canonicalUserId(author: Author, actor: UserActor): string {
  const authorUserId = parseActorUserId(author.userId);
  if (authorUserId && authorUserId !== actor.userId) {
    throw new Error("Message actor user id mismatch");
  }
  const userId = authorUserId ?? actor.userId;
  if (!userId) {
    throw new Error("Message actor requires a user id");
  }
  return userId;
}

function actorFromAuthor(author: Author): MessageActorIdentity | undefined {
  const userId = parseActorUserId(author.userId);
  return userId ? { userId } : undefined;
}

function applyActorToAuthor(author: Author, actor: UserActor): void {
  if (!isActorUserId(actor.userId)) {
    throw new Error("Message actor requires a user id");
  }
  author.userId = actor.userId;
  author.userName = actor.userName ?? "";
  author.fullName = actor.fullName ?? "";
}

/** Preserve runtime-owned identity on Chat SDK messages before persistence. */
export function bindMessageActorIdentity(
  message: Message,
  actor: UserActor,
): UserActor {
  const userId = canonicalUserId(message.author, actor);
  const currentActor = createActor(actor, {
    platform: actor.platform,
    ...(actor.platform === "slack" ? { teamId: actor.teamId } : {}),
    userId,
  });
  if (!currentActor) {
    throw new Error("Message actor requires a user id");
  }
  messageActors.set(message, currentActor);
  applyActorToAuthor(message.author, currentActor);
  return currentActor;
}

/** Read message identity without promoting adapter display fallbacks. */
export function getMessageActorIdentity(
  message: Message,
): MessageActorIdentity | undefined {
  return messageActors.get(message) ?? actorFromAuthor(message.author);
}

/** Attach Slack display fields only after the author id is exact. */
export async function ensureSlackMessageActorIdentity(
  message: Message,
  teamId: string,
  lookupSlackUser: (
    teamId: string,
    userId: string,
  ) => Promise<SlackActorProfile | null | undefined>,
): Promise<SlackActor> {
  const existing = messageActors.get(message);
  if (existing) {
    if (existing.platform !== "slack") {
      throw new Error("Slack message actor identity requires a Slack actor");
    }
    return existing;
  }
  const userId = parseActorUserId(message.author.userId);
  if (!userId) {
    throw new Error("Slack message actor identity requires a user id");
  }
  const actor = bindMessageActorIdentity(
    message,
    createSlackActor(teamId, userId, await lookupSlackUser(teamId, userId)),
  );
  if (actor.platform !== "slack") {
    throw new Error("Slack message actor identity requires a Slack actor");
  }
  return actor;
}
