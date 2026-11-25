import { useMemo, type ReactNode } from "react";

import { useLeadWatchRefresh, useSpaceLead } from "./Lead";
import { LeadPage } from "./leadPage";
import { useLeadWork } from "./useLeadWork";

/**
 * Give the Lead transcript its Space's Conversations, the Lead's Watches,
 * and a way to fill its reply box.
 */
function LeadPageProvider(props: {
  children: ReactNode;
  /** The Lead transcript's last event seq. A new event can change Watches. */
  lastSeq: number | undefined;
  prefill(text: string): void;
  spaceId: string | undefined;
}) {
  const work = useLeadWork(props.spaceId);
  const lead = useSpaceLead(props.spaceId);
  useLeadWatchRefresh(props.spaceId, props.lastSeq, lead.data?.lastSeq);
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
  /** The Lead's Space. */
  spaceId: string | undefined;
}) {
  if (!props.lead) return props.children;
  return (
    <LeadPageProvider
      lastSeq={props.lastSeq}
      prefill={props.prefill}
      spaceId={props.spaceId}
    >
      {props.children}
    </LeadPageProvider>
  );
}
