import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { StatusChip } from "../components/StatusChip";
import { TranscriptMarkdown } from "../conversations/TranscriptMarkdown";
import { conversationPath } from "../conversations/conversationRoutes";
import { automationPath, formatRelativeTime } from "../format";
import { ReviewItemActions } from "./ReviewItemActions";
import { assigneeLabel } from "./reviewItemFormat";

function Fact(props: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-0.5">
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
  return (
    <article className="grid min-w-0 content-start gap-5">
      <header className="grid gap-1">
        <h2 className="m-0 font-sans text-lg font-semibold">{item.title}</h2>
        <p className="m-0 text-xs text-dashboard-text-muted">
          Added {formatRelativeTime(item.createdAt)}
          {item.visibility === "private" ? " · Private" : null}
        </p>
      </header>
      <TranscriptMarkdown text={item.body} />
      <ReviewItemActions item={item} />
      <dl className="m-0 grid gap-3 border-t border-dashboard-border-subtle pt-4 sm:grid-cols-2">
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
              {item.conversationIds.map((conversationId) => (
                <li className="truncate" key={conversationId}>
                  <Link to={conversationPath(conversationId)}>
                    {conversationId}
                  </Link>
                </li>
              ))}
            </ul>
          </Fact>
        ) : null}
      </dl>
    </article>
  );
}
