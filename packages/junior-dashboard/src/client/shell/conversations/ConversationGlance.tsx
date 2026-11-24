import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { singleGitHubRepository } from "../../conversations/ConversationContextTags";
import { ConversationGlanceMetrics } from "../../conversations/ConversationMeta";
import { DetailsRow } from "../../conversations/DetailsList";
import { GitHubMark } from "../../conversations/GitHubMark";
import { SlackMark } from "../../conversations/SlackMark";
import { slackLocationLabel } from "../../format";
import type { Conversation } from "../../types";

/**
 * Lead Conversation details with what a reader checks while work runs: the
 * live cost, then the repository and the Slack location it works in.
 */
export function ConversationGlance(props: {
  conversation: Conversation | undefined;
  detail: ConversationDetailReport | undefined;
}) {
  const { conversation, detail } = props;
  if (!conversation) return null;
  const repository = singleGitHubRepository(detail?.annotations);
  const location = slackLocationLabel(conversation, { includeId: false });
  const locationUrl = detail?.locationUrl ?? conversation.locationUrl;
  return (
    <section aria-label="At a glance" className="grid min-w-0 gap-1 px-1 pb-2">
      <ConversationGlanceMetrics conversation={conversation} detail={detail} />
      {repository || location ? (
        <div className="-mx-1 grid min-w-0">
          {repository ? (
            <DetailsRow
              href={repository.href}
              icon={<GitHubMark className="size-3.5" />}
              title={repository.label}
            />
          ) : null}
          {location ? (
            <DetailsRow
              href={locationUrl}
              icon={<SlackMark className="size-3.5" />}
              title={location}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
