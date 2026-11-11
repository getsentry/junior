import { Bot, History } from "lucide-react";

import { ContextTag } from "./ConversationContextTags";

/**
 * Name the agent type of a child Conversation. A `fork` child started with
 * its parent's history, which its transcript leaves out, so its tag says
 * that. Other types show their name. A child without a type shows nothing.
 */
export function AgentTypeTag(props: { agentType?: string }) {
  if (!props.agentType) return null;
  if (props.agentType === "fork") {
    return (
      <ContextTag
        className="shrink-0"
        icon={<History aria-hidden="true" className="size-3 shrink-0" />}
        label="Parent history"
        title="Started with its parent's history, which this transcript leaves out."
      />
    );
  }
  return (
    <ContextTag
      className="shrink-0 capitalize"
      icon={<Bot aria-hidden="true" className="size-3 shrink-0" />}
      label={props.agentType}
      title={`Agent type: ${props.agentType}`}
    />
  );
}
