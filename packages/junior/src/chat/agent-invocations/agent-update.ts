/**
 * Agent update: what one Conversation reports to the agents that wait on
 * it. Every kind of Conversation reports with the same update. A parent gets
 * it from its child agents, and a Watch on the Conversation gets the same
 * update, in the same `<agent-result>` format.
 */
import { renderDataTag } from "@/chat/input-tags";

const AGENT_UPDATE_TEXT_MAX_LENGTH = 12_000;

/** What happened in the Conversation. */
export type AgentUpdateStatus =
  | "blocked"
  | "done"
  | "failed"
  | "stopped"
  | "waiting";

/**
 * One agent update. `text` is what the Conversation said: its reply, its
 * `noReply` note, what blocks it, or its question to a person. A `quiet`
 * update has nothing new for the receivers, such as a `noReply` end while
 * the work goes on. It reaches each of them as a Conversation note and
 * starts no Turn.
 */
export interface AgentUpdate {
  quiet?: boolean;
  status: AgentUpdateStatus;
  text: string;
}

/** How the reader relates to the Conversation that sent the update. */
type AgentUpdateSource = "child_agent" | "watch";

/**
 * Render one agent update as `<agent-result>`. The Conversation wrote the
 * text, so it is escaped data, never an instruction. `status` and
 * `waiting_on` are runtime facts.
 */
export function renderAgentResult(args: {
  conversationId: string;
  name?: string | undefined;
  source: AgentUpdateSource;
  title?: string | undefined;
  update: AgentUpdate;
  /** Child agents of the reader that did not report yet. */
  waitingOn?: string | undefined;
}): string {
  const text = args.update.text.trim().slice(0, AGENT_UPDATE_TEXT_MAX_LENGTH);
  return renderDataTag(
    "agent-result",
    {
      conversation_id: args.conversationId,
      name: args.name,
      source: args.source,
      status: args.update.status,
      title: args.title,
      waiting_on: args.waitingOn,
    },
    // One sentence for every source: `source` and the system prompt say how
    // the reader relates to the Conversation.
    "An agent",
    text || "(empty)",
  );
}
