import { ExternalLink } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { formatRelativeTime, formatTime } from "../format";
import { Drawer } from "../components/Drawer";
import { cn } from "../styles";
import { ConversationMemories } from "./ConversationMemories";

const tabs = [
  { label: "Details", value: "details" },
  { label: "Memories", value: "memories" },
] as const;

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
  const tabId = useId();
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
        <div
          aria-label="Conversation details"
          className="grid grid-cols-2 gap-1 rounded-lg border border-dashboard-border bg-dashboard-surface-panel p-1"
          role="tablist"
        >
          {tabs.map((item, index) => (
            <button
              aria-controls={`${tabId}-panel`}
              aria-selected={tab === item.value}
              className={cn(
                "min-h-9 cursor-pointer rounded-md border-0 px-3 py-2 font-sans text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus",
                tab === item.value
                  ? "bg-dashboard-fill-strong text-dashboard-text"
                  : "bg-transparent text-dashboard-text-muted hover:bg-dashboard-fill-faint hover:text-dashboard-text",
              )}
              id={`${tabId}-${item.value}`}
              key={item.value}
              onClick={() => setTab(item.value)}
              onKeyDown={(event) => {
                let nextIndex: number;
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  nextIndex = 1 - index;
                } else if (event.key === "Home") {
                  nextIndex = 0;
                } else if (event.key === "End") {
                  nextIndex = 1;
                } else {
                  return;
                }
                event.preventDefault();
                setTab(tabs[nextIndex]!.value);
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [nextIndex]?.focus();
              }}
              role="tab"
              tabIndex={tab === item.value ? 0 : -1}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <div
          aria-labelledby={`${tabId}-${tab}`}
          className="min-w-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          id={`${tabId}-panel`}
          role="tabpanel"
          tabIndex={0}
        >
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
