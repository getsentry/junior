import { ExternalLink } from "lucide-react";
import { useState, type ReactNode } from "react";

import { formatRelativeTime, formatTime } from "../format";
import { Drawer } from "../components/Drawer";
import { FilterTabList } from "../components/FilterBar";
import { ConversationMemories } from "./ConversationMemories";

/** Put conversation context before usage and diagnostic links. */
export function ConversationDetailsDrawer(props: {
  annotations: ReactNode;
  brief: ReactNode;
  conversationId: string;
  identity: ReactNode;
  lastActivityAt?: string;
  onClose(): void;
  sentryConversationUrl?: string;
  privacy: ReactNode;
  stats: ReactNode;
  title: string;
}) {
  const [tab, setTab] = useState<"details" | "memories">("details");
  const titleId = "conversation-details-drawer-title";
  const sections = [
    { content: props.brief, title: "Summary" },
    { content: props.annotations, title: "Linked work" },
    { content: props.identity, title: "Participants" },
    { content: props.stats, title: "Usage" },
  ].filter((section) => section.content != null);

  return (
    <Drawer
      closeLabel="Close conversation details"
      dismissLabel="Dismiss conversation details"
      header={
        <>
          <h2
            className="m-0 min-w-0 break-words text-lg font-bold leading-tight text-dashboard-text"
            id={titleId}
          >
            {props.title}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {props.privacy}
          </div>
        </>
      }
      onClose={props.onClose}
      openKey={props.conversationId}
      titleId={titleId}
      width="narrow"
    >
      <div className="grid min-w-0 gap-4">
        <FilterTabList
          ariaLabel="Conversation details"
          items={[
            { label: "Details", value: "details" },
            { label: "Memories", value: "memories" },
          ]}
          onChange={(value) =>
            setTab(value === "memories" ? "memories" : "details")
          }
          value={tab}
        />
        <div aria-label={`${tab} panel`} role="tabpanel">
          {tab === "memories" ? (
            <ConversationMemories conversationId={props.conversationId} />
          ) : sections.length > 0 ? (
            <div className="grid min-w-0 gap-5">
              {sections.map((section) => (
                <section
                  className="grid min-w-0 gap-3 border-b border-dashboard-border pb-5 last:border-0 last:pb-0"
                  key={section.title}
                >
                  <h3 className="m-0 text-sm font-semibold text-dashboard-text">
                    {section.title}
                  </h3>
                  <div className="min-w-0 break-words font-sans text-sm leading-relaxed text-dashboard-text-muted">
                    {section.content}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <p className="m-0 font-sans text-sm leading-relaxed text-dashboard-text-muted">
              No additional conversation details.
            </p>
          )}
          {tab === "details" &&
          (props.lastActivityAt || props.sentryConversationUrl) ? (
            <footer className="mt-5 grid gap-3 border-t border-dashboard-border pt-4 text-xs text-dashboard-text-muted">
              {props.lastActivityAt ? (
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>Last activity</span>
                  <time
                    dateTime={props.lastActivityAt}
                    title={formatTime(props.lastActivityAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  >
                    {formatRelativeTime(props.lastActivityAt)}
                  </time>
                </div>
              ) : null}
              {props.sentryConversationUrl ? (
                <a
                  className="inline-flex min-h-9 w-fit items-center gap-2 rounded px-1 text-dashboard-text-muted no-underline transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
                  href={props.sentryConversationUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Open in Sentry
                  <ExternalLink
                    aria-hidden="true"
                    className="size-3.5 shrink-0"
                  />
                </a>
              ) : null}
            </footer>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}
