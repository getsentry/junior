import type { ReactNode } from "react";
import { Link } from "react-router";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { DetailsPanel } from "../components/DetailsPanel";
import { DetailsCard } from "../conversations/DetailsList";
import { conversationPath } from "../conversations/conversationRoutes";
import {
  DisplayText,
  useTextShowsObjectCard,
} from "../display-text/DisplayText";
import { automationPath } from "../format";
import { dashboardInlineLinkClass } from "../styles";
import { useLinkedConversationTitles } from "./queries";
import { InboxItemObjects } from "./InboxItemObjects";
import {
  itemConversationId,
  itemOwnerPath,
  inboxItemStatusLabel,
  inboxItemSubjectHref,
} from "./inboxItemFormat";
import { OutboundLink } from "../components/OutboundLink";
import { formatRelativeTime } from "../time";
import { InboxItemAssignees } from "./InboxItemPeople";

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
 * Link the subject of an item. When the body already shows the subject's full
 * card, this card would repeat it, so it hides.
 */
function SubjectCard(props: {
  body: string;
  subject: InboxItemPayload["subject"];
}) {
  const { subject } = props;
  const href = subject.url ? inboxItemSubjectHref(subject.url) : undefined;
  if (useTextShowsObjectCard(props.body, href)) return null;
  return (
    <DetailsCard title="Subject">
      <span className="text-sm">
        {href ? (
          <OutboundLink className={dashboardInlineLinkClass} href={href}>
            {subject.object?.title ?? href}
          </OutboundLink>
        ) : (
          (subject.object?.title ?? subject.id)
        )}
      </span>
    </DetailsCard>
  );
}

/**
 * Show the facts of one Inbox item beside it: its text, assignees, where
 * it came from, and the Conversations linked to it.
 */
export function InboxItemDetails(props: {
  item: InboxItemPayload;
  onClose(): void;
}) {
  const { item } = props;
  const subject = item.subject;
  const ownerConversationId = itemConversationId(item);
  const titles = useLinkedConversationTitles([
    ...(ownerConversationId ? [ownerConversationId] : []),
    ...item.conversationIds,
  ]);
  const addedByTitle = ownerConversationId ? titles[0] : "Automation";
  const linkedTitles = ownerConversationId ? titles.slice(1) : titles;
  return (
    <DetailsPanel
      label="Inbox item details"
      onClose={props.onClose}
      title={
        <h2 className="m-0 text-base font-semibold text-dashboard-text">
          Details
        </h2>
      }
    >
      <div className="grid min-w-0 gap-3 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="min-w-0 break-words px-1 pb-1 font-sans text-sm leading-relaxed text-dashboard-text-muted">
          <InboxItemObjects conversationId={itemConversationId(item)}>
            <DisplayText mentions={item.mentions} text={item.body} />
          </InboxItemObjects>
        </div>
        <DetailsCard title="Assignees">
          <span className="text-sm text-dashboard-text">
            <InboxItemAssignees item={item} />
          </span>
        </DetailsCard>
        <DetailsCard>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            <Fact label="Status">{inboxItemStatusLabel(item)}</Fact>
            <Fact label="Added">{formatRelativeTime(item.createdAt)}</Fact>
            <Fact label="Added by">
              <Link
                className={dashboardInlineLinkClass}
                title={item.owner.id}
                to={itemOwnerPath(item, { turnId: item.addedByTurnId })}
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
        {subject.url ? (
          <InboxItemObjects conversationId={itemConversationId(item)}>
            <SubjectCard body={item.body} subject={subject} />
          </InboxItemObjects>
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
