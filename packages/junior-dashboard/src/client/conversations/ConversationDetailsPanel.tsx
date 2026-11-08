import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { ConversationDetails } from "./ConversationDetails";
import { ConversationSettings } from "./ConversationSettings";
import type { ConversationLink } from "./ConversationLinkedWork";
import { ConversationStats, hasConversationStats } from "./ConversationMeta";
import {
  ConversationUsageBreakdown,
  hasConversationUsageBreakdown,
} from "./ConversationUsageBreakdown";
import {
  ConversationMemoryContext,
  type ConversationMemoryEntry,
  type ConversationMemoryState,
} from "./conversationMemory";
import type { SubagentTranscriptTarget } from "./SubagentTranscriptDrawer";
import {
  conversationParticipants,
  ParticipantAvatarStack,
} from "../components/ParticipantAvatarStack";
import type { Conversation } from "../types";

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
  onOpenSubagent(target: SubagentTranscriptTarget): void;
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
        settings={
          detail?.autoArchive === undefined &&
          detail?.subscribed === undefined ? null : (
            <ConversationSettings
              autoArchive={detail?.autoArchive}
              conversationId={props.conversationId}
              subscribed={detail?.subscribed}
            />
          )
        }
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
