import { Archive } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { StatusChip } from "../components/StatusChip";
import { TranscriptMarkdown } from "../conversations/TranscriptMarkdown";
import { conversationPath } from "../conversations/conversationRoutes";
import { automationPath, formatRelativeTime } from "../format";
import { ReviewItemActions } from "./ReviewItemActions";
import { useLinkedConversationTitles } from "./queries";
import { assigneeLabel, reviewItemStatusLabel } from "./reviewItemFormat";

function Fact(props: { children: ReactNode; label: string }) {
  return (
    <div className="grid content-start gap-0.5">
      <dt className="text-xs font-medium text-dashboard-text-muted">
        {props.label}
      </dt>
      <dd className="m-0 min-w-0 break-words text-sm">{props.children}</dd>
    </div>
  );
}

/** Show one Review item with its facts and the viewer's actions. */
export function ReviewItemDetail(props: { item: ReviewItemPayload }) {
  const { item } = props;
  const subject = item.subject;
  const conversationTitles = useLinkedConversationTitles(item.conversationIds);
  const closed = item.status !== "open";
  return (
    <article className="grid min-w-0 content-start gap-5">
      {closed ? (
        // Search mixes open and archived items, so a closed item must be
        // easy to tell apart at the top of the detail.
        <p className="m-0 flex items-center gap-2 rounded-md bg-dashboard-fill-soft px-3 py-2 text-xs font-medium text-dashboard-text-muted">
          <Archive aria-hidden="true" size={14} />
          Archived · {reviewItemStatusLabel(item)}
        </p>
      ) : null}
      <header className="grid gap-1.5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <h2 className="m-0 min-w-0 break-words font-display text-xl font-medium leading-snug">
            {item.title}
          </h2>
          {closed ? null : (
            <StatusChip className="mt-1 shrink-0" size="compact" tone="accent">
              {reviewItemStatusLabel(item)}
            </StatusChip>
          )}
        </div>
        <p className="m-0 text-xs text-dashboard-text-muted">
          Added {formatRelativeTime(item.createdAt)}
          {item.visibility === "private" ? " · Private" : null}
        </p>
      </header>
      <TranscriptMarkdown text={item.body} />
      <section
        aria-label={item.status === "open" ? "Actions" : "Outcome"}
        className="border-t border-dashboard-border-subtle pt-5"
      >
        <ReviewItemActions item={item} />
      </section>
      <dl className="m-0 grid gap-4 border-t border-dashboard-border-subtle pt-5 sm:grid-cols-2">
        <Fact label="Assignees">
          {item.assignees.length > 0 || item.assignedToEveryone ? (
            assigneeLabel(item)
          ) : (
            <StatusChip size="compact" tone="warning">
              Unassigned
            </StatusChip>
          )}
        </Fact>
        {subject ? (
          <Fact label="Subject">
            {subject.url ? (
              <a href={subject.url} rel="noreferrer" target="_blank">
                {subject.title ?? subject.url}
              </a>
            ) : (
              (subject.title ?? subject.id)
            )}
          </Fact>
        ) : null}
        <Fact label="Added by">
          <Link to={conversationPath(item.addedByConversationId)}>
            Conversation
          </Link>
          {item.automationId ? (
            <>
              {" · "}
              <Link to={automationPath(item.automationId)}>Automation</Link>
            </>
          ) : null}
        </Fact>
        {item.conversationIds.length > 0 ? (
          <Fact label="Linked Conversations">
            <ul className="m-0 grid list-none gap-0.5 p-0">
              {item.conversationIds.map((conversationId, index) => {
                const title = conversationTitles[index];
                return (
                  <li
                    className={
                      title ? "truncate" : "truncate font-mono text-xs"
                    }
                    key={conversationId}
                  >
                    <Link
                      title={conversationId}
                      to={conversationPath(conversationId)}
                    >
                      {title ?? conversationId}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Fact>
        ) : null}
      </dl>
    </article>
  );
}
