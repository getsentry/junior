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

function setScopeContext(scope: Sentry.Scope, context: ObservabilityContext): void {
  if (context.platform) scope.setTag("platform", context.platform);
  if (context.requestId) scope.setTag("request_id", context.requestId);
  if (context.slackThreadId) scope.setTag("slack.thread_id", context.slackThreadId);
  if (context.slackUserId) scope.setTag("slack.user_id", context.slackUserId);
  if (context.slackChannelId) scope.setTag("slack.channel_id", context.slackChannelId);
  if (context.workflowRunId) scope.setTag("workflow.run_id", context.workflowRunId);
  if (context.assistantUserName) scope.setTag("assistant.user_name", context.assistantUserName);
  if (context.modelId) scope.setTag("ai.model_id", context.modelId);
  if (context.skillName) scope.setTag("skill.name", context.skillName);

  scope.setContext("junior", {
    platform: context.platform,
    requestId: context.requestId,
    slackThreadId: context.slackThreadId,
    slackUserId: context.slackUserId,
    slackChannelId: context.slackChannelId,
    workflowRunId: context.workflowRunId,
    assistantUserName: context.assistantUserName,
    modelId: context.modelId,
    skillName: context.skillName
  });
}

export function captureException(error: unknown, context: ObservabilityContext = {}): void {
  Sentry.withScope((scope) => {
    setScopeContext(scope, context);
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    Sentry.captureException(normalizedError);
  });
}

export function setTags(context: ObservabilityContext = {}): void {
  if (context.platform) Sentry.setTag("platform", context.platform);
  if (context.requestId) Sentry.setTag("request_id", context.requestId);
  if (context.slackThreadId) Sentry.setTag("slack.thread_id", context.slackThreadId);
  if (context.slackUserId) Sentry.setTag("slack.user_id", context.slackUserId);
  if (context.slackChannelId) Sentry.setTag("slack.channel_id", context.slackChannelId);
  if (context.workflowRunId) Sentry.setTag("workflow.run_id", context.workflowRunId);
  if (context.assistantUserName) Sentry.setTag("assistant.user_name", context.assistantUserName);
  if (context.modelId) Sentry.setTag("ai.model_id", context.modelId);
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
      attributes: {
        platform: context.platform,
        request_id: context.requestId,
        slack_thread_id: context.slackThreadId,
        slack_user_id: context.slackUserId,
        slack_channel_id: context.slackChannelId,
        workflow_run_id: context.workflowRunId,
        assistant_user_name: context.assistantUserName,
        ai_model_id: context.modelId,
        skill_name: context.skillName
      }
    },
    callback
  );
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
