import { expect } from "vitest";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  getLatestMcpAuthSessionForUserProvider,
  getMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { listTurnSummaries } from "@/chat/task-execution/checkpoint";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  CONVERSATION_ID,
  loadConversationState,
  streamScript,
} from "./conversation-work";
import { completeMcpOauthCallbackRoute } from "./mcp-oauth-callback-harness";
import {
  EVAL_MCP_AUTH_PROVIDER,
  EVAL_MCP_NO_AUTH_PROVIDER,
} from "../msw/handlers/eval-mcp-auth";

/** Canonical Eval Auth tool name used by orchestration suites. */
export const EVAL_AUTH_TOOL_NAME = "mcp__eval-auth__budget-echo";

/** Search connects the auth MCP provider; missing credentials park for auth. */
export function streamMcpSearch(replyAfterConnect: string) {
  return streamScript(
    {
      tool: "searchMcpTools",
      args: { provider: EVAL_MCP_AUTH_PROVIDER, query: "budget echo" },
    },
    replyAfterConnect,
  );
}

/** Search discloses the tool before the same turn calls it. */
export function streamMcpSearchAndCall(replyAfterCall: string) {
  return streamScript(
    {
      tool: "searchMcpTools",
      args: { provider: EVAL_MCP_AUTH_PROVIDER, query: "budget echo" },
    },
    {
      tool: "callMcpTool",
      args: {
        tool_name: EVAL_AUTH_TOOL_NAME,
        arguments: { query: "budget" },
      },
    },
    replyAfterCall,
  );
}

/** Search connects the open MCP provider without auth. */
export function streamOpenMcpSearch(replyAfterConnect: string) {
  return streamScript(
    {
      tool: "searchMcpTools",
      args: { provider: EVAL_MCP_NO_AUTH_PROVIDER, query: "handbook" },
    },
    replyAfterConnect,
  );
}

/**
 * Complete the latest MCP OAuth session for one actor through the real callback.
 *
 * Pass `conversationWorkQueue` for web wakes that must hit the test queue.
 */
export async function completeLatestMcpAuth(args: {
  userId: string;
  agentRunner: AgentRunner;
  conversationWorkQueue?: ConversationWorkQueue;
  provider?: string;
}): Promise<void> {
  const provider = args.provider ?? EVAL_MCP_AUTH_PROVIDER;
  const session = await getLatestMcpAuthSessionForUserProvider(
    args.userId,
    provider,
  );
  expect(session?.authSessionId).toEqual(expect.any(String));
  await completeMcpOauthCallbackRoute({
    provider,
    authSessionId: session!.authSessionId,
    agentRunner: args.agentRunner,
    ...(args.conversationWorkQueue
      ? { conversationWorkQueue: args.conversationWorkQueue }
      : {}),
  });
}

/**
 * Assert MCP auth is parked for one actor.
 *
 * Shared core: pendingAuth + paused turn record. Callers pass `delivery` for
 * the surface-specific prompt (Slack ephemeral link, web pending-messages, …).
 */
export async function expectMcpAuthParked(args: {
  actorId: string;
  conversationId?: string;
  provider?: string;
  delivery?: () => void | Promise<void>;
}): Promise<void> {
  const conversationId = args.conversationId ?? CONVERSATION_ID;
  const provider = args.provider ?? EVAL_MCP_AUTH_PROVIDER;
  if (args.delivery) {
    await args.delivery();
  }
  expect(
    (await loadConversationState(conversationId)).processing.pendingAuth,
  ).toMatchObject({
    kind: "mcp",
    provider,
    actorId: args.actorId,
  });
  await expect(listTurnSummaries(conversationId)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ state: "paused", resumeReason: "auth" }),
    ]),
  );
}

/** Assert pending MCP auth was cleared after a successful connect/resume. */
export async function expectMcpAuthCleared(
  conversationId = CONVERSATION_ID,
): Promise<void> {
  expect(
    (await loadConversationState(conversationId)).processing.pendingAuth,
  ).toBeUndefined();
}

/** Assert stored Eval Auth credentials exist for one actor. */
export async function expectMcpAuthCredentialsStored(
  userId: string,
  provider = EVAL_MCP_AUTH_PROVIDER,
): Promise<void> {
  await expect(getMcpStoredOAuthCredentials(userId, provider)).resolves.toMatchObject(
    {
      tokens: expect.objectContaining({ access_token: expect.any(String) }),
    },
  );
}
