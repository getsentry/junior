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

/** Async attribute domain consumed directly by LogTape. */
export const logContextStorage = new AsyncLocalStorage<LogAttributes>();

/** Typed context domain retained for consumers such as native Sentry scope fields. */
const typedLogContextStorage = new AsyncLocalStorage<LogContext>();

function definedLogContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as LogContext;
}

function definedAttributes(
  attributes: Record<string, string | undefined>,
): LogAttributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
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
  attributes: LogAttributes,
  callback: () => T,
): T {
  return typedLogContextStorage.run(
    {
      ...typedLogContextStorage.getStore(),
      ...definedLogContext(context),
    },
    () =>
      logContextStorage.run(
        { ...logContextStorage.getStore(), ...attributes },
        callback,
      ),
  );
}

/** Run an operation with raw attributes, restoring its parent on completion. */
export function runWithLogAttributes<T>(
  attributes: LogAttributes,
  callback: () => T,
): T {
  return logContextStorage.run(
    { ...logContextStorage.getStore(), ...attributes },
    callback,
  );
}

/** Merge raw attributes into the current scoped operation. */
export function updateLogAttributes(attributes: LogAttributes): void {
  const current = logContextStorage.getStore();
  if (current) {
    Object.assign(current, attributes);
  }
}

/** Merge context and attributes into the current scoped operation. */
export function updateLogContext(
  context: LogContext,
  attributes: LogAttributes,
): void {
  const currentContext = typedLogContextStorage.getStore();
  if (currentContext) {
    Object.assign(currentContext, definedLogContext(context));
  }
  const currentAttributes = logContextStorage.getStore();
  if (currentAttributes) {
    Object.assign(currentAttributes, attributes);
  }
}

/** Read the typed context bound to the current operation. */
export function getBoundLogContext(): LogContext {
  return typedLogContextStorage.getStore() ?? {};
}

/** Read the attributes bound to the current operation. */
export function getBoundLogAttributes(): LogAttributes {
  return logContextStorage.getStore() ?? {};
}
