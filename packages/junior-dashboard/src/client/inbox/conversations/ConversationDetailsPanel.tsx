import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { ConversationDetails } from "./ConversationDetails";
import type { ConversationLink } from "../../conversations/ConversationLinkedWork";
import {
  ConversationStats,
  hasConversationStats,
} from "../../conversations/ConversationMeta";
import {
  ConversationUsageBreakdown,
  hasConversationUsageBreakdown,
} from "../../conversations/ConversationUsageBreakdown";
import {
  ConversationMemoryContext,
  type ConversationMemoryEntry,
  type ConversationMemoryState,
} from "../../conversations/conversationMemory";
import type { ConversationDrawerTarget } from "../../conversations/ConversationDrawer";
import {
  conversationParticipants,
  ParticipantAvatarStack,
} from "../../components/ParticipantAvatarStack";
import type { Conversation } from "../../types";

/** Render the Conversation details side panel from the page's loaded data. */
export function ConversationDetailsPanel(props: {
  conversation: Conversation | undefined;
  conversationId: string;
  detail: ConversationDetailReport | undefined;
  /** True when a sidebar review chip opened details. */
  highlightReview: boolean;
  links: ConversationLink[];
  memoryState: ConversationMemoryState;
  onClose(): void;
  onOpenSubagent(target: ConversationDrawerTarget): void;
  onSelectMemory(entry: ConversationMemoryEntry & { turnId: string }): void;
}) {
  const { conversation, detail } = props;
  const participants = conversationParticipants(conversation);
  const showUsageBreakdown = hasConversationUsageBreakdown({
    conversation,
    detail,
  });
  return (
    <ConversationMemoryContext value={props.memoryState}>
      <ConversationDetails
        agentTree={detail?.agentTree}
        brief={detail?.brief}
        conversationId={props.conversationId}
        highlightReview={props.highlightReview}
        identity={
          participants.length > 0 ? (
            <ParticipantAvatarStack participants={participants} size="detail" />
          ) : null
        }
        onClose={props.onClose}
        onOpenSubagent={props.onOpenSubagent}
        onSelectMemory={props.onSelectMemory}
        links={props.links}
        overview={
          hasConversationStats({
            conversation,
            detail,
            showUsageBreakdown,
          }) ? (
            <ConversationStats
              conversation={conversation}
              detail={detail}
              showUsageBreakdown={showUsageBreakdown}
            />
          ) : null
        }
        usage={
          showUsageBreakdown ? (
            <ConversationUsageBreakdown
              conversation={conversation}
              detail={detail}
            />
          ) : null
        }
      />
    </ConversationMemoryContext>
  );
}
