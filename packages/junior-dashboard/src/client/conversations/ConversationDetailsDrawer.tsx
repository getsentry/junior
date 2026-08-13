import type { ReactNode } from "react";

import { Drawer } from "../components/Drawer";

/** Show advanced identity, runtime, and resource details for a conversation. */
export function ConversationDetailsDrawer(props: {
  annotations: ReactNode;
  identity: ReactNode;
  onClose(): void;
  privacy: ReactNode;
  stats: ReactNode;
  title: string;
}) {
  const titleId = "conversation-details-drawer-title";
  const sections = [
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
      openKey={props.title}
      titleId={titleId}
    >
      {sections.length > 0 ? (
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
    </Drawer>
  );
}
