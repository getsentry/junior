import { expect } from "vitest";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  getLatestMcpAuthSessionForUserProvider,
  getMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { listTurnSummaries } from "@/chat/task-execution/checkpoint";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { ConversationWorkWebHarness } from "./api-turn";
import {
  CONVERSATION_ID,
  loadConversationState,
  streamScript,
  type ConversationWorkSlackHarness,
} from "./conversation-work";
import { completeMcpOauthCallbackRoute } from "./mcp-oauth-callback-harness";
import {
  EVAL_MCP_AUTH_PROVIDER,
  EVAL_MCP_NO_AUTH_PROVIDER,
} from "../msw/handlers/eval-mcp-auth";

/** Public Slack auth notice shown while MCP OAuth is pending. */
export const EVAL_MCP_AUTH_NOTICE = /I need access to Eval Auth to continue/;

/** Canonical Eval Auth tool name used by orchestration suites. */
export const EVAL_AUTH_TOOL_NAME = "mcp__eval-auth__budget-echo";

/** Canonical open MCP tool name used by orchestration suites. */
export const EVAL_MCP_OPEN_TOOL_NAME = "mcp__eval-mcp-open__handbook-search";

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

/** Search discloses the open MCP tool before the same turn calls it. */
export function streamOpenMcpSearchAndCall(replyAfterCall: string) {
  return streamScript(
    {
      tool: "searchMcpTools",
      args: { provider: EVAL_MCP_NO_AUTH_PROVIDER, query: "handbook" },
    },
    {
      tool: "callMcpTool",
      args: {
        tool_name: EVAL_MCP_OPEN_TOOL_NAME,
        arguments: { query: "holidays" },
      },
    },
    replyAfterCall,
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

/** Slack delivery: public auth notice + private connect link for one actor. */
export async function expectSlackMcpAuthParked(args: {
  userId: string;
  harness: ConversationWorkSlackHarness;
  conversationId?: string;
  provider?: string;
}): Promise<void> {
  await expectMcpAuthParked({
    actorId: args.userId,
    conversationId: args.conversationId,
    provider: args.provider,
    delivery: () => {
      expect(
        args.harness.replies().some((text) => EVAL_MCP_AUTH_NOTICE.test(text)),
      ).toBe(true);
      expect(args.harness.authLinksFor(args.userId).length).toBeGreaterThan(0);
    },
  });
}

/** Web delivery: participant pending-messages exposes a connect prompt. */
export async function expectWebMcpAuthParked(args: {
  harness: ConversationWorkWebHarness;
  conversationId: string;
  provider?: string;
}): Promise<void> {
  await expectMcpAuthParked({
    actorId: args.harness.actor.userId,
    conversationId: args.conversationId,
    provider: args.provider,
    delivery: async () => {
      const pending = await args.harness.pendingMessages(args.conversationId);
      expect(pending.authorization).toMatchObject({
        authorizationUrl: expect.stringMatching(/^https?:\/\//),
        label: expect.any(String),
        completionText: expect.any(String),
      });
    },
  });
}

/** No MCP auth prompt delivered to this Slack actor. */
export function expectNoSlackMcpAuth(
  userId: string,
  harness: ConversationWorkSlackHarness,
): void {
  expect(harness.authLinksFor(userId)).toEqual([]);
}

/** Connect Eval Auth for one Slack actor through mention → park → OAuth. */
export async function connectSlackMcpActor(args: {
  harness: ConversationWorkSlackHarness;
  userId: string;
  replyText?: string;
}): Promise<void> {
  const replyText = args.replyText ?? "Eval Auth is connected.";
  args.harness.setModelStream(streamMcpSearch(replyText));
  await args.harness.mention(
    args.userId,
    "use eval-auth and confirm the connection",
  );
  await args.harness.drain();
  await expectSlackMcpAuthParked({
    userId: args.userId,
    harness: args.harness,
  });
  await completeLatestMcpAuth({
    userId: args.userId,
    agentRunner: args.harness.agentRunner,
  });
  await expectMcpAuthCleared();
  await expectMcpAuthCredentialsStored(args.userId);
  expect(args.harness.replies().some((text) => text.includes(replyText))).toBe(
    true,
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
  await expect(
    getMcpStoredOAuthCredentials(userId, provider),
  ).resolves.toMatchObject({
    tokens: expect.objectContaining({ access_token: expect.any(String) }),
  });
}
