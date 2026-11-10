import { githubPlugin } from "@sentry/junior-github";
import { vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { createAutomationTool } from "@/chat/automations/tools/create";
import { automationToolContext } from "@/chat/automations/tool-access";
import { createSlackSource, type SlackActor } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { upsertIdentity } from "@/chat/identities/sql";
import { readActorIdentity } from "@/chat/plugins/viewer";
import type { ToolRuntimeContext } from "@/chat/tools/types";

export const teamId = `TEVENT${Date.now()}`;
/**
 * Enable the GitHub plugin, so the tools and ingest use the same event
 * catalog. Call `vi.unstubAllEnvs()` after the test.
 */
export async function useGitHubEvents(): Promise<void> {
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
  await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
}

/** Build the source and actor for an Automation tool call. */
export function context(
  userId = "U123",
  channelId = "C123",
  sourceVisibility: "private" | "public" = channelId.startsWith("C")
    ? "public"
    : "private",
  threadTs?: string,
  workspaceTeamId = teamId,
): ToolRuntimeContext {
  const destination = {
    platform: "slack" as const,
    teamId: workspaceTeamId,
    channelId,
  };
  const actor: SlackActor = {
    platform: "slack",
    teamId: workspaceTeamId,
    userId,
  };
  return {
    conversationId: "test:event-annotations",
    actor,
    // Slack turns store the actor identity before tools run.
    resolveActorIdentity: async () => {
      await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "slack",
        providerTenantId: workspaceTeamId,
        providerSubjectId: userId,
      });
      return await readActorIdentity(actor);
    },
    destination,
    source: createSlackSource({
      teamId: destination.teamId,
      channelId: destination.channelId,
      ...(threadTs ? { threadTs } : undefined),
      visibility: sourceVisibility,
    }),
    userText: "Create a task for review feedback.",
    turnTools: turnBehavior({
      kind: "root",
      personInput: true,
      automationRun: false,
    }).tools,
  } as ToolRuntimeContext;
}

/** Execute a tool with parsed input and a retry-stable call identity. */
export async function execute<TInput>(
  tool: {
    execute?: (input: TInput, options: { toolCallId?: string }) => unknown;
    prepareArguments?: (input: unknown) => TInput;
  },
  input: unknown,
  toolCallId = "event-automation-call",
) {
  if (!tool.execute) throw new Error("tool execute function missing");
  const prepared = tool.prepareArguments?.(input) ?? input;
  return await tool.execute(prepared as TInput, {
    toolCallId,
  });
}

/** Build the review event that `createTask` Automations match. */
export function changesRequestedEvent(eventKey: string) {
  return {
    eventKey,
    eventType: "pull_request.review.changes_requested",
    occurredAtMs: Date.now(),
    namespace: "github",
    identifier: "getsentry/junior#1174",
    trustedSummary: "A reviewer requested changes.",
    data: { repo: "getsentry/junior", pullRequest: 1174 },
  };
}

/** Create an event Automation through its production tool. */
export async function createTask(
  instruction: string,
  toolCallId?: string,
  events = ["pull_request.review.changes_requested"],
  taskContext = context(),
  credentialMode?: "creator" | "system",
) {
  return (await execute(
    createAutomationTool(automationToolContext(taskContext), getEventCatalog()),
    {
      instruction,
      outcomes: [],
      credential_mode: credentialMode,
      trigger: {
        type: "event",
        namespace: "github",
        label: "GitHub PR getsentry/junior#1174",
        events,
        match: { repo: "getsentry/junior", pull_request: 1174 },
      },
    },
    toolCallId ?? instruction,
  )) as { automation: { id: string } };
}
