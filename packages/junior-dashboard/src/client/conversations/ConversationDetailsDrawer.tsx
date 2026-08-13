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
      <div className="grid min-w-0 gap-5">
        {props.identity ? (
          <DetailsSection title="Identity">
            <div className="min-w-0 break-words font-sans text-sm leading-relaxed text-dashboard-text-muted">
              {props.identity}
            </div>
          </DetailsSection>
        ) : null}
        {props.stats ? (
          <DetailsSection title="Runtime">
            <div className="min-w-0 break-words font-sans text-sm leading-relaxed text-dashboard-text-muted">
              {props.stats}
            </div>
          </DetailsSection>
        ) : null}
        {props.annotations ? (
          <DetailsSection title="Links">
            <div className="min-w-0">{props.annotations}</div>
          </DetailsSection>
        ) : null}
      </div>
    </Drawer>
  );
}

function DetailsSection(props: { children: ReactNode; title: string }) {
  return (
    <section className="grid min-w-0 gap-2">
      <h3 className="m-0 font-mono text-xs font-medium uppercase tracking-[0.14em] text-dashboard-text-muted">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}
