import * as Sentry from "@sentry/nextjs";

export interface ObservabilityContext {
  platform?: string;
  requestId?: string;
  slackThreadId?: string;
  slackUserId?: string;
  slackChannelId?: string;
  workflowRunId?: string;
  assistantUserName?: string;
  modelId?: string;
  skillName?: string;
}

function contextToAttributes(context: ObservabilityContext): Record<string, unknown> {
  return {
    platform: context.platform,
    "request.id": context.requestId,
    "messaging.system": context.platform === "slack" ? "slack" : context.platform,
    "messaging.conversation.id": context.slackThreadId,
    "messaging.channel.id": context.slackChannelId,
    "enduser.id": context.slackUserId,
    "workflow.run.id": context.workflowRunId,
    "assistant.user.name": context.assistantUserName,
    "gen_ai.request.model": context.modelId,
    "skill.name": context.skillName
  };
}

function contextToSpanAttributes(context: ObservabilityContext): Record<string, string> {
  const attrs = contextToAttributes(context);
  return Object.fromEntries(
    Object.entries(attrs).filter(([, value]) => typeof value === "string" && value.length > 0)
  ) as Record<string, string>;
}

function setScopeContext(scope: Sentry.Scope, context: ObservabilityContext): void {
  if (context.platform) scope.setTag("platform", context.platform);
  if (context.requestId) scope.setTag("request.id", context.requestId);
  if (context.slackThreadId) scope.setTag("messaging.conversation.id", context.slackThreadId);
  if (context.slackUserId) scope.setTag("enduser.id", context.slackUserId);
  if (context.slackChannelId) scope.setTag("messaging.channel.id", context.slackChannelId);
  if (context.workflowRunId) scope.setTag("workflow.run.id", context.workflowRunId);
  if (context.assistantUserName) scope.setTag("assistant.user.name", context.assistantUserName);
  if (context.modelId) scope.setTag("gen_ai.request.model", context.modelId);
  if (context.skillName) scope.setTag("skill.name", context.skillName);

  scope.setContext("junior", contextToAttributes(context));
}

export function captureException(error: unknown, context: ObservabilityContext = {}): void {
  Sentry.withScope((scope) => {
    setScopeContext(scope, context);
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    Sentry.captureException(normalizedError);
  });
}

function logWithLevel(
  level: "info" | "warn" | "error",
  message: string,
  attributes: Record<string, unknown> = {}
): void {
  const loggerApi = (Sentry as unknown as { logger?: Record<string, (msg: string, attrs?: Record<string, unknown>) => void> })
    .logger;
  const fn = loggerApi?.[level];
  if (typeof fn === "function") {
    fn(message, attributes);
    return;
  }

  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) scope.setExtra(key, value);
    }
    const sentryLevel = level === "warn" ? "warning" : level;
    Sentry.captureMessage(message, sentryLevel);
  });
}

export function logInfo(message: string, context: ObservabilityContext = {}, attributes: Record<string, unknown> = {}): void {
  logWithLevel("info", message, { ...contextToAttributes(context), ...attributes });
}

export function logWarn(message: string, context: ObservabilityContext = {}, attributes: Record<string, unknown> = {}): void {
  logWithLevel("warn", message, { ...contextToAttributes(context), ...attributes });
}

export function logError(message: string, context: ObservabilityContext = {}, attributes: Record<string, unknown> = {}): void {
  logWithLevel("error", message, { ...contextToAttributes(context), ...attributes });
}

export function setTags(context: ObservabilityContext = {}): void {
  if (context.platform) Sentry.setTag("platform", context.platform);
  if (context.requestId) Sentry.setTag("request.id", context.requestId);
  if (context.slackThreadId) Sentry.setTag("messaging.conversation.id", context.slackThreadId);
  if (context.slackUserId) Sentry.setTag("enduser.id", context.slackUserId);
  if (context.slackChannelId) Sentry.setTag("messaging.channel.id", context.slackChannelId);
  if (context.workflowRunId) Sentry.setTag("workflow.run.id", context.workflowRunId);
  if (context.assistantUserName) Sentry.setTag("assistant.user.name", context.assistantUserName);
  if (context.modelId) Sentry.setTag("gen_ai.request.model", context.modelId);
  if (context.skillName) Sentry.setTag("skill.name", context.skillName);
}

export async function withSpan<T>(
  name: string,
  op: string,
  context: ObservabilityContext,
  callback: () => Promise<T>
): Promise<T> {
  return Sentry.startSpan(
    {
      name,
      op,
      attributes: contextToSpanAttributes(context)
    },
    callback
  );
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
