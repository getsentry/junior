import type {
  ActorIdentity,
  ConversationDetailReport,
} from "@sentry/junior/api/schema";

import { useDashboardCoreData } from "../../api";
import { ConversationDetails } from "./ConversationDetails";
import { singleGitHubRepository } from "../../conversations/ConversationContextTags";
import type { ConversationLink } from "../../conversations/ConversationLinkedWork";
import {
  ConversationStats,
  conversationCost,
  conversationLocation,
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
import { GitHubMark } from "../../conversations/GitHubMark";
import { SlackMark } from "../../conversations/SlackMark";
import { OutboundLink } from "../../components/OutboundLink";
import { conversationParticipants } from "../../components/ParticipantAvatarStack";
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
}) {
  const { conversation, detail } = props;
  const viewerEmail = useDashboardCoreData().data?.me.user.email;
  const showUsageBreakdown = hasConversationUsageBreakdown({
    conversation,
    detail,
  });
  const repository = singleGitHubRepository(detail?.annotations);
  const location = conversationLocation(conversation, detail);
  const stats = { conversation, detail, showUsageBreakdown };
  return (
    <ConversationDetails
      context={
        // Details is the only desktop place that names the Slack location.
        repository || location ? (
          <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5 text-dashboard-text-muted">
            {repository ? (
              <OutboundLink
                className="inline-flex min-w-0 items-center gap-1.5 hover:text-dashboard-text"
                href={repository.href}
              >
                <GitHubMark className="size-3.5 shrink-0" />
                {repository.label}
              </OutboundLink>
            ) : null}
            {location ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <SlackMark className="size-3.5 shrink-0" />
                {location}
              </span>
            ) : null}
          </p>
        ) : null
      }
      conversationId={props.conversationId}
      cost={conversationCost(conversation, detail, "above")}
      detail={detail}
      highlightReview={props.highlightReview}
      links={props.links}
      memoryList={props.memoryList}
      onClose={props.onClose}
      onOpenSubagent={props.onOpenSubagent}
      onSelectMemory={props.onSelectMemory}
      participants={withoutViewerWhoLeft(
        conversationParticipants(conversation),
        detail,
        viewerEmail,
      )}
      repository={repository?.label}
      usage={
        hasConversationStats(stats) || showUsageBreakdown ? (
          <>
            <ConversationStats {...stats} />
            {showUsageBreakdown ? (
              <ConversationUsageBreakdown
                conversation={conversation}
                detail={detail}
              />
            ) : null}
          </>
        ) : null
      }
    />
  );
}

/**
 * The API always lists the root actor. A viewer who left the Conversation
 * is not a participant, so their own avatar leaves the footer.
 */
function withoutViewerWhoLeft(
  participants: readonly ActorIdentity[],
  detail: ConversationDetailReport | undefined,
  viewerEmail: string | undefined,
): readonly ActorIdentity[] {
  if (detail?.isParticipant !== false || !viewerEmail) return participants;
  const viewer = viewerEmail.toLowerCase();
  return participants.filter(
    (participant) => participant.email?.toLowerCase() !== viewer,
  );
}
