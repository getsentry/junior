import { AsyncLocalStorage } from "node:async_hooks";

export type LogAttributeValue = string | number | boolean | string[];
export type LogAttributes = Record<string, LogAttributeValue>;

/** Provider-neutral correlation data inherited by logs and spans in an operation. */
export interface LogContext {
  conversationId?: string;
  platform?: string;
  requestId?: string;
  messageConversationId?: string;
  destinationName?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  runId?: string;
  actorType?: string;
  actorId?: string;
  assistantUserName?: string;
  modelId?: string;
  skillName?: string;
  httpMethod?: string;
  httpPath?: string;
  urlFull?: string;
  userAgent?: string;
}

/** Async context domain consumed directly by LogTape. */
export const logContextStorage = new AsyncLocalStorage<LogAttributes>();

function definedAttributes(
  attributes: Record<string, unknown>,
): LogAttributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, LogAttributeValue] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean" ||
        (Array.isArray(entry[1]) &&
          entry[1].every((value) => typeof value === "string")),
    ),
  );
}

/** Convert provider-neutral domain context to stable telemetry attributes. */
export function logContextToAttributes(context: LogContext): LogAttributes {
  return definedAttributes({
    "gen_ai.conversation.id": context.conversationId,
    "app.platform": context.platform,
    "app.request.id": context.requestId,
    "messaging.system":
      context.platform === "slack" ? "slack" : context.platform,
    "messaging.message.conversation_id": context.messageConversationId,
    "messaging.destination.name": context.destinationName,
    "enduser.id": context.userId,
    "enduser.pseudo.id": context.userName,
    "app.run.id": context.runId,
    "app.actor.type": context.actorType,
    "app.actor.id": context.actorId,
    "gen_ai.agent.name": context.assistantUserName,
    "gen_ai.request.model": context.modelId,
    "app.skill.name": context.skillName,
    "http.request.method": context.httpMethod,
    "url.path": context.httpPath,
    "url.full": context.urlFull,
    "user_agent.original": context.userAgent,
  });
}

/** Run an operation with merged context, restoring its parent on completion. */
export function runWithLogContext<T>(
  context: LogContext,
  callback: () => T,
): T {
  return logContextStorage.run(
    {
      ...logContextStorage.getStore(),
      ...logContextToAttributes(context),
    },
    callback,
  );
}

/** Read the attributes bound to the current operation. */
export function getBoundLogAttributes(): LogAttributes {
  return logContextStorage.getStore() ?? {};
}
