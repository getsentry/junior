import type {
  ActorIdentity,
  ConversationDetailReport,
} from "@sentry/junior/api/schema";
import type { ReactNode } from "react";

import { ConversationDetails } from "./ConversationDetails";
import { ConversationGlance } from "./ConversationGlance";
import type { ConversationLink } from "../../conversations/ConversationLinkedWork";
import {
  ConversationStats,
  hasConversationStats,
} from "../../conversations/ConversationMeta";
import {
  ConversationUsageBreakdown,
  hasConversationUsageBreakdown,
} from "../../conversations/ConversationUsageBreakdown";
import type {
  ConversationMemoryEntry,
  ConversationMemoryList,
} from "../../conversations/conversationMemory";
import type { ConversationDrawerTarget } from "../../conversations/ConversationDrawer";
import { conversationParticipants } from "../../components/ParticipantAvatarStack";
import {
  ConversationParticipants,
  type ParticipantInvite,
} from "../../conversations/ConversationParticipants";
import type { Conversation } from "../../types";

/** Render the Conversation details side panel from the page's loaded data. */
export function ConversationDetailsPanel(props: {
  conversation: Conversation | undefined;
  conversationId: string;
  detail: ConversationDetailReport | undefined;
  /** True when a sidebar review chip opened details. */
  highlightReview: boolean;
  links: ConversationLink[];
  memoryList: ConversationMemoryList | undefined;
  onClose(): void;
  onOpenSubagent(target: ConversationDrawerTarget): void;
  onSelectMemory(entry: ConversationMemoryEntry): void;
  /**
   * Who the Participants card lists and where its Invite adds people, when
   * they are not the Conversation's own, as on a Lead.
   */
  participants?:
    | { invite: ParticipantInvite; participants: readonly ActorIdentity[] }
    | undefined;
  /** A Lead's Space: its description and settings. */
  space?: ReactNode;
}) {
  const { conversation, detail } = props;
  const showUsageBreakdown = hasConversationUsageBreakdown({
    conversation,
    detail,
  });
  return (
    <ConversationDetails
      agentTree={detail?.agentTree}
      glance={
        <ConversationGlance conversation={conversation} detail={detail} />
      }
      summary={detail?.summary}
      summaryMentions={detail?.summaryMentions}
      conversationId={props.conversationId}
      highlightReview={props.highlightReview}
      participants={
        <ConversationParticipants
          conversationId={props.conversationId}
          detail={detail}
          invite={props.participants?.invite}
          participants={
            props.participants?.participants ??
            conversationParticipants(conversation)
          }
        />
      }
      isParticipant={detail?.isParticipant === true}
      onClose={props.onClose}
      onOpenSubagent={props.onOpenSubagent}
      onSelectMemory={props.onSelectMemory}
      links={props.links}
      memoryList={props.memoryList}
      space={props.space}
      overview={
        hasConversationStats({
          conversation,
          detail,
          glance: true,
          showUsageBreakdown,
        }) ? (
          <ConversationStats
            conversation={conversation}
            detail={detail}
            glance
            showUsageBreakdown={showUsageBreakdown}
          />
        ) : null
      }
      usage={
        showUsageBreakdown ? (
          <ConversationUsageBreakdown
            conversation={conversation}
            detail={detail}
            glance
          />
        ) : null
      }
    />
  );
}
