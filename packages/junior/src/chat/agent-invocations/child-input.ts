/**
 * Creates the agent invocation that gives one input to a child Conversation:
 * a result or message from its own child agent, or its own watch events.
 *
 * The parent did not start this work, so it is not a task. It runs with the
 * Actor and credentials of the child's latest task. A watch event or a result
 * is never a task, so the credentials of one timer Turn never pass to later
 * work. The task Actor of its Turn comes from the Turn that caused the input,
 * not from this row (see `conversations/task-actor.ts`).
 */
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { juniorAgentInvocations } from "@/db/schema";
import { getAgentInvocation, invocationFromRow } from "./store";
import type { AgentInvocation } from "./types";

/**
 * Read the latest task of one child Conversation: the newest agent invocation
 * that its parent started with `spawnAgent` or `messageAgent`. The first agent
 * invocation of a child always comes from `spawnAgent`, also when it has no
 * tool call id.
 */
async function getLatestAgentTask(
  childConversationId: string,
): Promise<AgentInvocation | undefined> {
  const db = getSqlExecutor().db();
  const [latest] = await db
    .select()
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(juniorAgentInvocations.childConversationId, childConversationId),
        isNotNull(juniorAgentInvocations.parentToolCallId),
      ),
    )
    .orderBy(desc(juniorAgentInvocations.createdAt))
    .limit(1);
  if (latest) {
    return invocationFromRow(latest);
  }
  const [first] = await db
    .select()
    .from(juniorAgentInvocations)
    .where(eq(juniorAgentInvocations.childConversationId, childConversationId))
    .orderBy(asc(juniorAgentInvocations.createdAt))
    .limit(1);
  return first ? invocationFromRow(first) : undefined;
}

/**
 * Create or replay the agent invocation that gives one input to the child
 * Conversation of `latest`. It continues that Conversation for the same
 * parent. It runs as the Actor and with the credentials of the child's latest
 * task, unless `runAs` sets them. It skips the queue and active-count checks
 * because it continues work that already passed them.
 */
export async function createAgentInvocationForChildInput(
  args: {
    input: string;
    invocationId: string;
    latest: AgentInvocation;
    /** Actor, credentials, and Source for watch events. */
    runAs?: Pick<AgentInvocation, "actor" | "credentialContext" | "source">;
  },
  nowMs = Date.now(),
): Promise<AgentInvocation> {
  const { invocationId, latest } = args;
  const task = await getLatestAgentTask(latest.childConversationId);
  if (!task) {
    throw new Error(
      `Child conversation ${latest.childConversationId} has no agent task`,
    );
  }
  const runAs = args.runAs ?? task;
  await getSqlExecutor()
    .db()
    .insert(juniorAgentInvocations)
    .values({
      invocationId,
      parentConversationId: latest.parentConversationId,
      childConversationId: latest.childConversationId,
      agentName: latest.agentName ?? null,
      input: args.input,
      actor: runAs.actor,
      credentialContext: runAs.credentialContext ?? null,
      source: args.runAs?.source ?? { kind: "agent_invocation" },
      destination: latest.destination,
      modelProfile: latest.modelProfile ?? null,
      reasoningLevel: latest.reasoningLevel ?? null,
      status: "pending",
      mailboxStatus: "pending",
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
      terminalAt: null,
    })
    .onConflictDoNothing();
  const invocation = await getAgentInvocation(invocationId);
  if (
    !invocation ||
    invocation.childConversationId !== latest.childConversationId
  ) {
    throw new Error(`Agent invocation creation raced for ${invocationId}`);
  }
  return invocation;
}
