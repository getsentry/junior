import type { Author, Message } from "chat";
import {
  createRequester,
  createSlackRequester,
  isActorUserId,
  parseActorUserId,
  type Requester,
  type SlackRequesterProfile,
} from "@/chat/requester";

const messageActors = new WeakMap<Message, Requester>();
interface MessageAuthorIdentity {
  email?: string;
  fullName?: string;
  userId: string;
  userName?: string;
}

type MessageActorIdentity = Requester | MessageAuthorIdentity;

function canonicalUserId(author: Author, requester: Requester): string {
  const authorUserId = parseActorUserId(author.userId);
  if (authorUserId && authorUserId !== requester.userId) {
    throw new Error("Message requester user id mismatch");
  }
  const userId = authorUserId ?? requester.userId;
  if (!userId) {
    throw new Error("Message requester requires a user id");
  }
  return userId;
}

function requesterFromAuthor(author: Author): MessageActorIdentity | undefined {
  const userId = parseActorUserId(author.userId);
  return userId ? { userId } : undefined;
}

function applyRequesterToAuthor(author: Author, requester: Requester): void {
  if (!isActorUserId(requester.userId)) {
    throw new Error("Message requester requires a user id");
  }
  author.userId = requester.userId;
  author.userName = requester.userName ?? "";
  author.fullName = requester.fullName ?? "";
}

/** Preserve runtime-owned identity on Chat SDK messages before persistence. */
export function bindMessageActorIdentity(
  message: Message,
  requester: Requester,
): Requester {
  const userId = canonicalUserId(message.author, requester);
  const actorRequester = createRequester(requester, {
    teamId: requester.teamId,
    userId,
  });
  if (!actorRequester) {
    throw new Error("Message requester requires a user id");
  }
  messageActors.set(message, actorRequester);
  applyRequesterToAuthor(message.author, actorRequester);
  return actorRequester;
}

/** Read message identity without promoting adapter display fallbacks. */
export function getMessageActorIdentity(
  message: Message,
): MessageActorIdentity | undefined {
  return messageActors.get(message) ?? requesterFromAuthor(message.author);
}

/** Attach Slack display fields only after the author id is exact. */
export async function ensureSlackMessageActorIdentity(
  message: Message,
  teamId: string,
  lookupSlackUser: (
    teamId: string,
    userId: string,
  ) => Promise<SlackRequesterProfile | null | undefined>,
): Promise<Requester> {
  const existing = messageActors.get(message);
  if (existing) {
    return existing;
  }
  const userId = parseActorUserId(message.author.userId);
  if (!userId) {
    throw new Error("Slack message actor identity requires a user id");
  }
  return bindMessageActorIdentity(
    message,
    createSlackRequester(teamId, userId, await lookupSlackUser(teamId, userId)),
  );
}
