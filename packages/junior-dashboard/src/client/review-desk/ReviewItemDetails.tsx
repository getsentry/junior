import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { DetailsPanel } from "../components/DetailsPanel";
import { StatusChip } from "../components/StatusChip";
import { DetailsCard } from "../conversations/DetailsList";
import { conversationPath } from "../conversations/conversationRoutes";
import { DisplayText } from "../display-text/DisplayText";
import { automationPath, formatRelativeTime } from "../format";
import { dashboardInlineLinkClass } from "../styles";
import { useLinkedConversationTitles } from "./queries";
import {
  assigneeLabel,
  reviewItemStatusLabel,
  reviewItemSubjectHref,
} from "./reviewItemFormat";

function Fact(props: { children: ReactNode; label: string }) {
  return (
    <>
      <dt className="text-dashboard-text-muted">{props.label}</dt>
      <dd className="m-0 min-w-0 break-words text-dashboard-text">
        {props.children}
      </dd>
    </>
  );
}

/**
 * Show the facts of one Review item beside it: its text, assignees, where
 * it came from, and the Conversations linked to it.
 */
export function ReviewItemDetails(props: {
  item: ReviewItemPayload;
  onClose(): void;
}) {
  const { item } = props;
  const subject = item.subject;
  const subjectHref = subject?.url
    ? reviewItemSubjectHref(subject.url)
    : undefined;
  const [addedByTitle, ...linkedTitles] = useLinkedConversationTitles([
    item.addedByConversationId,
    ...item.conversationIds,
  ]);
  const assigned = item.assignees.length > 0 || item.assignedToEveryone;
  return (
    <DetailsPanel
      label="Review item details"
      onClose={props.onClose}
      title={
        <h2 className="m-0 text-base font-semibold text-dashboard-text">
          Details
        </h2>
      }
    >
      <div className="grid min-w-0 gap-3 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="min-w-0 break-words px-1 pb-1 font-sans text-sm leading-relaxed text-dashboard-text-muted">
          <DisplayText text={item.body} />
        </div>
        <DetailsCard title="Assignees">
          {assigned ? (
            <span className="text-sm text-dashboard-text">
              {assigneeLabel(item)}
            </span>
          ) : (
            <StatusChip size="compact" tone="warning">
              Unassigned
            </StatusChip>
          )}
        </DetailsCard>
        <DetailsCard>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            <Fact label="Status">{reviewItemStatusLabel(item)}</Fact>
            <Fact label="Added">{formatRelativeTime(item.createdAt)}</Fact>
            <Fact label="Added by">
              <Link
                className={dashboardInlineLinkClass}
                title={item.addedByConversationId}
                to={conversationPath(item.addedByConversationId, {
                  turnId: item.addedByTurnId,
                })}
              >
                {addedByTitle ?? "Conversation"}
              </Link>
              {item.automationId ? (
                <>
                  {" · "}
                  <Link
                    className={dashboardInlineLinkClass}
                    to={automationPath(item.automationId)}
                  >
                    Automation
                  </Link>
                </>
              ) : null}
            </Fact>
            <Fact label="Visibility">
              {item.visibility === "private" ? "Private" : "Public"}
            </Fact>
          </dl>
        </DetailsCard>
        {subject ? (
          <DetailsCard title="Subject">
            <span className="text-sm">
              {subjectHref ? (
                <a
                  className={dashboardInlineLinkClass}
                  href={subjectHref}
                  rel="noreferrer"
                  target="_blank"
                >
                  {subject.title ?? subjectHref}
                </a>
              ) : (
                (subject.title ?? subject.id)
              )}
            </span>
          </DetailsCard>
        ) : null}
        {item.conversationIds.length > 0 ? (
          <DetailsCard
            count={item.conversationIds.length}
            title="Linked conversations"
          >
            <ul className="m-0 grid list-none gap-1 p-0 text-sm">
              {item.conversationIds.map((conversationId, index) => {
                const title = linkedTitles[index];
                return (
                  <li
                    className={
                      title ? "truncate" : "truncate font-mono text-xs"
                    }
                    key={conversationId}
                  >
                    <Link
                      className={dashboardInlineLinkClass}
                      title={conversationId}
                      to={conversationPath(conversationId)}
                    >
                      {title ?? conversationId}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </DetailsCard>
        ) : null}
      </div>
    </DetailsPanel>
  );
}
