import { Bot, History } from "lucide-react";
import type { ConversationAgentTreeNode } from "@sentry/junior/api/schema";

import { ContextTag } from "./ConversationContextTags";

/**
 * Name the agent type of a child Conversation, and say when it is a fork:
 * it started with its parent's history, which its transcript leaves out. A
 * fresh child without a type shows nothing.
 */
export function ChildAgentTags(props: { node?: ConversationAgentTreeNode }) {
  const agentType = props.node?.agentType;
  return (
    <>
      {agentType ? (
        <ContextTag
          className="shrink-0 capitalize"
          icon={<Bot aria-hidden="true" className="size-3 shrink-0" />}
          label={agentType}
          title={`Agent type: ${agentType}`}
        />
      ) : null}
      {props.node?.fork ? (
        <ContextTag
          className="shrink-0"
          icon={<History aria-hidden="true" className="size-3 shrink-0" />}
          label="Parent history"
          title="Started with its parent's history, which this transcript leaves out."
        />
      ) : null}
    </>
  );
}
