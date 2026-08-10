/** Local CLI adapter for the shared conversation-only turn runtime. */
import {
  createLocalSource,
  localDestinationSchema,
  type LocalDestination,
} from "@sentry/junior-plugin-api";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  runConversationOnlyTurn,
  type ConversationOnlyReply,
  type ConversationOnlyToolInvocation,
  type ConversationOnlyToolResult,
} from "@/chat/runtime/conversation-only";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { PiMessage } from "@/chat/pi/messages";
import type { OAuthAuthorization } from "@/chat/oauth-authorization";
import type { SandboxEgressSignalTransport } from "@/chat/sandbox/egress/signals";
import type { ConversationTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import { logException } from "@/chat/logging";
import { randomUUID } from "node:crypto";

export interface LocalAgentTurnInput {
  conversationId: string;
  message: string;
}

export type LocalAgentReply = ConversationOnlyReply;
export type LocalToolInvocation = ConversationOnlyToolInvocation;
export type LocalToolResult = ConversationOnlyToolResult;

export interface LocalAgentTurnDeps {
  agentRunner: AgentRunner;
  /** Complete local OAuth callback lifecycle; omit to disable interactive auth. */
  authorization?: OAuthAuthorization & {
    cancel: () => void;
    wait: () => Promise<void>;
  };
  /** Post-delivery checkpoint write. */
  saveTurnCheckpoint?: typeof saveTurnCheckpoint;
  deliverReply: (reply: LocalAgentReply) => Promise<void>;
  sandboxEgressSignals?: SandboxEgressSignalTransport;
  /** Pre-agent durable Pi projection boundary. */
  loadPiMessages?: (args: {
    conversationId: string;
  }) => Promise<PiMessage[] | undefined>;
  /** Injectable failure capture boundary for deterministic runtime integration tests. */
  logException?: typeof logException;
  /** Canonical lifecycle writer; defaults to the production SQL service. */
  turnLifecycle?: ConversationTurnLifecycle;
  now?: () => number;
  onStatus?: (status: string) => void | Promise<void>;
  onToolInvocation?: (invocation: LocalToolInvocation) => void | Promise<void>;
  onToolResult?: (result: LocalToolResult) => void | Promise<void>;
}

export interface LocalAgentTurnResult {
  conversationId: string;
  outcome: AgentRunResult["diagnostics"]["outcome"];
}

function localDestination(conversationId: string): LocalDestination {
  const parsed = localDestinationSchema.safeParse({
    platform: "local",
    conversationId,
  });
  if (!parsed.success) {
    throw new Error("Invalid local conversation id");
  }
  return parsed.data;
}

/** Run one local CLI message through the shared conversation-only runtime. */
export async function runLocalAgentTurn(
  input: LocalAgentTurnInput,
  deps: LocalAgentTurnDeps,
): Promise<LocalAgentTurnResult> {
  if (!deps.deliverReply) {
    throw new Error("Local reply delivery is required");
  }
  const destination = localDestination(input.conversationId);
  return await runConversationOnlyTurn(
    {
      actor: {
        fullName: "Local CLI",
        platform: "local",
        userId: "local-cli",
        userName: "local",
      },
      conversationId: input.conversationId,
      destination,
      message: input.message,
      source: createLocalSource(destination.conversationId),
      surface: "internal",
    },
    {
      acceptReply: deps.deliverReply,
      agentRunner: deps.agentRunner,
      createRunId: () => `local-run-${randomUUID()}`,
      createTurnId: () => `local-turn-${randomUUID()}`,
      eventNamePrefix: "local",
      authorization: deps.authorization,
      loadPiMessages: deps.loadPiMessages,
      logException: deps.logException,
      now: deps.now,
      onStatus: deps.onStatus,
      onToolInvocation: deps.onToolInvocation,
      onToolResult: deps.onToolResult,
      sandboxEgressSignals: deps.sandboxEgressSignals,
      saveTurnCheckpoint: deps.saveTurnCheckpoint,
      turnLifecycle: deps.turnLifecycle,
    },
  );
}
