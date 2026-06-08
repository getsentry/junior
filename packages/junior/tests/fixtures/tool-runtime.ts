import type { Static, TSchema } from "@sinclair/typebox";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { ToolDefinition } from "@/chat/tools/definition";
import {
  getSlackToolContext,
  type SlackToolContext,
} from "@/chat/tools/slack/context";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

interface TestToolStateOptions {
  artifactState?: ThreadArtifactsState;
  currentListId?: string;
}

/**
 * Create the default sandbox for tests that should not exercise sandbox I/O.
 */
export function createUnavailableSandbox(): SandboxWorkspace {
  const fail = () => {
    throw new Error(
      "Unexpected sandbox access. Provide a test sandbox fixture for this behavior.",
    );
  };

  return {
    readFileToBuffer: fail,
    runCommand: fail,
  };
}

/**
 * Create a typed tool runtime context for direct tool contract tests.
 */
export function createTestToolRuntimeContext(
  overrides: Partial<ToolRuntimeContext> = {},
): ToolRuntimeContext {
  const hasChannelId = Object.prototype.hasOwnProperty.call(
    overrides,
    "channelId",
  );
  const channelId = hasChannelId ? overrides.channelId : "C123";
  const slackOverrides = overrides as Partial<ToolRuntimeContext> & {
    destinationChannelId?: string;
    deliveryChannelId?: string;
    messageTs?: string;
    sourceChannelId?: string;
    threadTs?: string;
  };
  const sourceChannelId = slackOverrides.sourceChannelId ?? channelId;
  const destinationChannelId =
    slackOverrides.destinationChannelId ??
    slackOverrides.deliveryChannelId ??
    channelId;
  const defaultSource = sourceChannelId
    ? ({
        platform: "slack" as const,
        teamId: "T123",
        channelId: sourceChannelId,
        ...(slackOverrides.messageTs
          ? { messageTs: slackOverrides.messageTs }
          : {}),
        ...(slackOverrides.threadTs
          ? { threadTs: slackOverrides.threadTs }
          : {}),
      } as const)
    : ({
        platform: "local" as const,
        conversationId: "local:test:tool_runtime",
      } as const);
  const defaultDestination = destinationChannelId
    ? ({
        platform: "slack" as const,
        teamId: "T123",
        channelId: destinationChannelId,
      } as const)
    : ({
        platform: "local" as const,
        conversationId: "local:test:tool_runtime",
      } as const);
  return {
    channelId,
    destination: overrides.destination ?? defaultDestination,
    sandbox: createUnavailableSandbox(),
    source: overrides.source ?? defaultSource,
    ...(slackOverrides.messageTs ? { messageTs: slackOverrides.messageTs } : {}),
    ...(sourceChannelId ? { sourceChannelId } : {}),
    ...(sourceChannelId ? { teamId: "T123" } : {}),
    ...(slackOverrides.threadTs ? { threadTs: slackOverrides.threadTs } : {}),
    ...overrides,
  } as ToolRuntimeContext;
}

/**
 * Create Slack-specific context for direct Slack tool contract tests.
 */
export function createTestSlackToolContext(
  overrides: Partial<ToolRuntimeContext> = {},
): SlackToolContext {
  const context = getSlackToolContext(createTestToolRuntimeContext(overrides));
  if (!context) {
    throw new Error("Expected Slack test tool context");
  }
  return context;
}

/**
 * Create in-memory tool state with operation-result dedupe support.
 */
export function createTestToolState(
  options: TestToolStateOptions = {},
): ToolState {
  const operationResultCache = new Map<string, unknown>();
  const artifactState: ThreadArtifactsState = {
    listColumnMap: {},
    ...options.artifactState,
  };

  return {
    artifactState,
    patchArtifactState: (patch) => {
      Object.assign(artifactState, patch);
    },
    getCurrentListId: () => options.currentListId,
    getOperationResult: <T>(operationKey: string): T | undefined =>
      operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey, result) => {
      operationResultCache.set(operationKey, result);
    },
  };
}

/**
 * Execute a tool with typed input and the default direct-test options.
 */
export async function executeTestTool<TInputSchema extends TSchema>(
  toolDefinition: ToolDefinition<TInputSchema>,
  input: Static<TInputSchema>,
): Promise<any> {
  if (!toolDefinition.execute) {
    throw new Error("tool execute function missing");
  }

  return await toolDefinition.execute(input, {});
}
