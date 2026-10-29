import { useState, type ReactNode } from "react";

import { useDetailsPanel } from "../components/DetailsPanel";
import { IconButtonTooltip } from "../components/Tooltip";
import { ConversationDetailsFrame } from "./ConversationDetailsFrame";
import { SegmentedTabs } from "../components/SegmentedTabs";
import {
  ConversationChildAgents,
  useConversationChildAgents,
} from "./ConversationChildAgents";
import {
  ConversationMemories,
  useConversationMemories,
} from "./ConversationMemories";
import { ShareConversationButton } from "./ShareConversationButton";
import type { SubagentTranscriptTarget } from "./SubagentTranscriptDrawer";

type DetailsTab = "agents" | "summary" | "memories";

/**
 * Show conversation details: the brief and facts first, then linked work,
 * participants, and the usage breakdown. Share and Sentry links stay in the
 * header so every tab can reach them.
 */
export function ConversationDetails(props: {
  annotations: ReactNode;
  brief: ReactNode;
  conversationId: string;
  identity: ReactNode;
  onClose(): void;
  /** Open one child agent transcript. A details sheet closes first. */
  onOpenSubagent(target: SubagentTranscriptTarget): void;
  overview: ReactNode;
  sentryConversationUrl?: string;
  usage: ReactNode;
}) {
  const [tab, setTab] = useState<DetailsTab>("summary");
  const panel = useDetailsPanel();
  // Load both lists with details so each tab can show its count.
  const memories = useConversationMemories(props.conversationId);
  const agents = useConversationChildAgents(props.conversationId);
  const tabs = [
    { label: "Summary", value: "summary" },
    {
      count: memories.data?.memories.length,
      label: "Memories",
      value: "memories",
    },
    { count: agents.data?.agents.length, label: "Subagents", value: "agents" },
  ] as const;

  const sections = [
    { content: props.overview, key: "overview", title: undefined },
    { content: props.identity, key: "participants", title: "Participants" },
    { content: props.annotations, key: "linked-work", title: "Linked work" },
    { content: props.usage, key: "usage", title: "Usage" },
  ].filter((section) => section.content != null);

  return (
    <ConversationDetailsFrame
      actions={
        <>
          <ShareConversationButton
            key={props.conversationId}
            conversationId={props.conversationId}
            layout="icon"
          />
          {props.sentryConversationUrl ? (
            <IconButtonTooltip label="Open in Sentry" placement="below">
              <a
                aria-label="Open in Sentry"
                className="grid size-9 place-items-center rounded-md text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-strong hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus"
                href={props.sentryConversationUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <SentryGlyph />
              </a>
            </IconButtonTooltip>
          ) : null}
        </>
      }
      onClose={props.onClose}
    >
      <SegmentedTabs
        scroll
        items={tabs}
        label="Conversation details"
        onChange={setTab}
        value={tab}
      >
        {tab === "memories" ? (
          <ConversationMemories conversationId={props.conversationId} />
        ) : tab === "agents" ? (
          <ConversationChildAgents
            conversationId={props.conversationId}
            onOpenAgent={(target) => {
              // The panel stays beside the drawer. A modal sheet cannot.
              if (!panel) props.onClose();
              props.onOpenSubagent(target);
            }}
          />
        ) : props.brief != null || sections.length > 0 ? (
          <div className="grid min-w-0 gap-3">
            {props.brief != null ? (
              <div className="min-w-0 break-words px-1 pb-1 font-sans text-sm leading-relaxed text-dashboard-text-muted">
                {props.brief}
              </div>
            ) : null}
            {sections.map((section) => (
              <DetailsSection key={section.key} title={section.title}>
                {section.content}
              </DetailsSection>
            ))}
          </div>
        ) : (
          <p className="m-0 font-sans text-sm leading-relaxed text-dashboard-text-muted">
            No additional conversation details.
          </p>
        )}
      </SegmentedTabs>
    </ConversationDetailsFrame>
  );
}

/** Group one kind of conversation detail in a compact card. */
function DetailsSection(props: { children: ReactNode; title?: string }) {
  return (
    <section className="grid min-w-0 gap-2.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel p-3">
      {props.title ? (
        <h3 className="m-0 font-sans text-xs font-medium text-dashboard-text-muted">
          {props.title}
        </h3>
      ) : null}
      <div className="min-w-0 break-words font-sans text-xs leading-relaxed text-dashboard-text-muted">
        {props.children}
      </div>
    </section>
  );
}

/** Draw the Sentry glyph in the current text color, sized like a header icon. */
function SentryGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" />
    </svg>
  );
}
