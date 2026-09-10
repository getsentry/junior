import { useState, type ReactNode } from "react";

import { Drawer } from "../components/Drawer";
import { FilterTabList } from "../components/FilterBar";
import { ConversationMemories } from "./ConversationMemories";

/** Show the Brief, identity, runtime, and resource details for a Conversation. */
export function ConversationDetailsDrawer(props: {
  annotations: ReactNode;
  brief: ReactNode;
  conversationId: string;
  identity: ReactNode;
  onClose(): void;
  privacy: ReactNode;
  stats: ReactNode;
  title: string;
}) {
  const [tab, setTab] = useState<"details" | "memories">("details");
  const titleId = "conversation-details-drawer-title";
  const sections = [
    { content: props.brief, title: "Brief" },
    { content: props.identity, title: "Identity" },
    { content: props.stats, title: "Runtime" },
    { content: props.annotations, title: "Links" },
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
                <section className="grid min-w-0 gap-2" key={section.title}>
                  <h3 className="m-0 font-mono text-xs font-medium uppercase tracking-[0.14em] text-dashboard-text-muted">
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
        </div>
      </div>
    </Drawer>
  );
}
