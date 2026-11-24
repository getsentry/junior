import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Link } from "react-router";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { conversationPath } from "../conversations/conversationRoutes";
import { automationPath } from "../format";
import {
  cn,
  dashboardDisclosureChevronClass,
  dashboardInlineLinkClass,
} from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { formatRelativeTime } from "../time";
import { InboxItemAssignees } from "./InboxItemPeople";
import { itemConversationId, itemOwnerPath } from "./inboxItemFormat";
import { useLinkedConversationTitles } from "./queries";

/** Show one labeled fact in a `<dl>`. */
export function Fact(props: { children: ReactNode; label: string }) {
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
 * Link what added an item: its Conversation, at the Turn that added it, or
 * its Automation. An item that an Automation's run added in a Conversation
 * also links that Automation.
 */
export function InboxItemAddedBy(props: { item: InboxItemPayload }) {
  const { item } = props;
  const ownerConversationId = itemConversationId(item);
  const [title] = useLinkedConversationTitles(
    ownerConversationId ? [ownerConversationId] : [],
  );
  return (
    <>
      <Link
        className={dashboardInlineLinkClass}
        title={item.owner.id}
        to={itemOwnerPath(item, { turnId: item.addedByTurnId })}
      >
        {ownerConversationId ? (title ?? "Conversation") : "Automation"}
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
    </>
  );
}

/** Link each Conversation linked to an item, by its title when known. */
export function LinkedConversationList(props: {
  conversationIds: readonly string[];
}) {
  const titles = useLinkedConversationTitles(props.conversationIds);
  return (
    <ul className="m-0 grid list-none gap-1 p-0">
      {props.conversationIds.map((conversationId, index) => {
        const title = titles[index];
        return (
          <li
            className={cn("flex min-w-0", !title && "font-mono text-xs")}
            key={conversationId}
          >
            <Link
              className={cn(dashboardInlineLinkClass, "flex min-w-0")}
              title={conversationId}
              to={conversationPath(conversationId)}
            >
              <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
                {title ?? conversationId}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Show an open Inbox card's facts behind a Details disclosure: its
 * assignees, when and by what it was added, its visibility, and its linked
 * Conversations. The facts mount only while open, so a closed disclosure
 * reads no titles.
 */
export function InboxItemFactsDisclosure(props: { item: InboxItemPayload }) {
  const { item } = props;
  const triggerId = useId();
  return (
    <Collapsible className="grid min-w-0 gap-2">
      <CollapsibleTrigger
        id={triggerId}
        className="group flex w-fit cursor-pointer items-center gap-1 rounded-sm text-xs text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
      >
        <ChevronRight
          aria-hidden="true"
          className={dashboardDisclosureChevronClass}
        />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent aria-labelledby={triggerId} role="region">
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <Fact label="Assignees">
            <InboxItemAssignees item={item} />
          </Fact>
          <Fact label="Added">{formatRelativeTime(item.createdAt)}</Fact>
          <Fact label="Added by">
            <InboxItemAddedBy item={item} />
          </Fact>
          <Fact label="Visibility">
            {item.visibility === "private" ? "Private" : "Public"}
          </Fact>
          {item.conversationIds.length > 0 ? (
            <Fact label="Linked conversations">
              <LinkedConversationList conversationIds={item.conversationIds} />
            </Fact>
          ) : null}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
