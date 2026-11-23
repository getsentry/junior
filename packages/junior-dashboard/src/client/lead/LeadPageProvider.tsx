import { useMemo, type ReactNode } from "react";

import { useLead, useLeadWatchRefresh } from "./Lead";
import { LeadPage } from "./leadPage";
import { useLeadWork } from "./useLeadWork";

/**
 * Give the Lead transcript the viewer's Conversations, the Lead's Watches,
 * and a way to fill its reply box.
 */
function LeadPageProvider(props: {
  children: ReactNode;
  /** The Lead transcript's last event seq. A new event can change Watches. */
  lastSeq: number | undefined;
  prefill(text: string): void;
}) {
  const work = useLeadWork();
  const lead = useLead();
  useLeadWatchRefresh(props.lastSeq, lead.data?.lastSeq);
  const watched = lead.data?.watchedConversationIds;
  const { prefill } = props;
  const value = useMemo(
    () => ({
      conversations: work.byId,
      prefill,
      waiting: work.waiting,
      watchedIds: new Set(watched),
    }),
    [prefill, watched, work],
  );
  return <LeadPage value={value}>{props.children}</LeadPage>;
}

/** Give a Lead's page what its rows read. Other pages render as they are. */
export function LeadPageScope(props: {
  children: ReactNode;
  lastSeq: number | undefined;
  lead: boolean;
  prefill(text: string): void;
}) {
  if (!props.lead) return props.children;
  return (
    <LeadPageProvider lastSeq={props.lastSeq} prefill={props.prefill}>
      {props.children}
    </LeadPageProvider>
  );
}
