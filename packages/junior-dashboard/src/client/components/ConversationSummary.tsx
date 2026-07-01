import {
  conversationDisplayTitle,
  conversationIdentityMeta,
  visualStatusForConversation,
} from "../format";
import type { Conversation } from "../types";
import { StatusBadge } from "./StatusBadge";

/** Render the shared conversation title, identity, and status. */
export function ConversationSummary(props: { conversation: Conversation }) {
  const visualStatus = visualStatusForConversation(props.conversation);

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 truncate text-[1.04rem] font-bold leading-tight text-white">
          {conversationDisplayTitle(props.conversation)}
        </div>
        <StatusBadge status={visualStatus} />
      </div>
      <div className="mt-1 break-words text-[0.86rem] leading-relaxed text-[#b8b8b8] md:truncate">
        {conversationIdentityMeta(props.conversation, props.conversation.id)}
      </div>
    </div>
  );
}
