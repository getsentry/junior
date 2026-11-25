import { Inbox, MessageSquare } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { OutboundLink } from "../components/OutboundLink";
import { conversationPath } from "../conversations/conversationRoutes";
import { dashboardInlineLinkClass } from "../styles";
import { useLinkedConversationTitles } from "./queries";
import { inboxRowPath, inboxItemSubjectHref } from "./inboxItemFormat";

/** A list shows this many entries until the reader asks for the rest. */
const COLLAPSED_ENTRIES = 3;

const iconClass =
  "mr-1.5 inline size-3.5 shrink-0 align-[-0.125em] text-dashboard-text-faint";

type Entry = { key: string; node: ReactNode };

function EntryList(props: { entries: Entry[]; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  if (props.entries.length === 0) return null;
  const shown = expanded
    ? props.entries
    : props.entries.slice(0, COLLAPSED_ENTRIES);
  const hidden = props.entries.length - shown.length;
  return (
    <section
      aria-labelledby={headingId}
      className="grid min-w-0 content-start gap-1"
    >
      <h4
        className="m-0 text-xs font-medium text-dashboard-text-muted"
        id={headingId}
      >
        {props.label}
      </h4>
      <ul className="m-0 grid list-none gap-1 p-0">
        {shown.map((entry) => (
          <li className="min-w-0 break-words" key={entry.key}>
            {entry.node}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          className="w-fit cursor-pointer border-0 bg-transparent p-0 text-left text-xs text-dashboard-text-muted underline-offset-2 hover:text-dashboard-text hover:underline focus-visible:outline-dashboard-focus"
          onClick={() => setExpanded(true)}
          type="button"
        >
          Show {hidden} more
        </button>
      ) : null}
    </section>
  );
}

function ConversationLink(props: { conversationId: string; label: string }) {
  return (
    <Link
      className={dashboardInlineLinkClass}
      title={props.conversationId}
      to={conversationPath(props.conversationId)}
    >
      <MessageSquare aria-hidden="true" className={iconClass} />
      {props.label}
    </Link>
  );
}

function Note(props: { text: string | undefined }) {
  return props.text ? (
    <span className="text-dashboard-text-muted"> · {props.text}</span>
  ) : null;
}

/**
 * Show what is related to a question, beside its answer choices: the links
 * that the agent added, then the other open items and Conversations on the
 * same subject or linked work. The reader can check them before answering.
 */
export function InboxItemRelated(props: { item: InboxItemPayload }) {
  const { item } = props;
  const links = item.request?.related ?? [];
  const relatedConversationIds = item.related?.conversationIds ?? [];
  const titles = useLinkedConversationTitles(relatedConversationIds);
  const linkEntries: Entry[] = links.map((entry, index) => {
    const href = entry.url ? inboxItemSubjectHref(entry.url) : undefined;
    return {
      key: `${index}`,
      node: (
        <>
          {entry.conversationId ? (
            <ConversationLink
              conversationId={entry.conversationId}
              label={entry.label}
            />
          ) : href ? (
            <OutboundLink className={dashboardInlineLinkClass} href={href}>
              {entry.label}
            </OutboundLink>
          ) : (
            entry.label
          )}
          <Note text={entry.note} />
        </>
      ),
    };
  });
  const relatedEntries: Entry[] = [
    ...(item.related?.items ?? []).map((related) => ({
      key: `item:${related.id}`,
      node: (
        <Link
          className={dashboardInlineLinkClass}
          to={inboxRowPath({ id: related.id, status: "open" })}
        >
          <Inbox aria-hidden="true" className={iconClass} />
          {related.title}
        </Link>
      ),
    })),
    ...relatedConversationIds.map((conversationId, index) => ({
      key: `conversation:${conversationId}`,
      node: (
        <ConversationLink
          conversationId={conversationId}
          label={titles[index] ?? "Conversation"}
        />
      ),
    })),
  ];
  if (linkEntries.length === 0 && relatedEntries.length === 0) {
    return null;
  }
  return (
    <div className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
      <EntryList entries={linkEntries} label="Links" />
      <EntryList entries={relatedEntries} label="Related" />
    </div>
  );
}
