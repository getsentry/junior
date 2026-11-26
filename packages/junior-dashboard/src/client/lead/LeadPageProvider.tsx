import { useMemo, type ReactNode } from "react";

import { LeadPage } from "./leadPage";
import { useLeadWork } from "./useLeadWork";

/** Give the Lead transcript its Space's Conversations. */
function LeadPageProvider(props: {
  children: ReactNode;
  spaceId: string | undefined;
}) {
  const work = useLeadWork(props.spaceId);
  const value = useMemo(() => ({ conversations: work.byId }), [work.byId]);
  return <LeadPage value={value}>{props.children}</LeadPage>;
}

/** Give a Lead's page what its rows read. Other pages render as they are. */
export function LeadPageScope(props: {
  children: ReactNode;
  lead: boolean;
  /** The Lead's Space. */
  spaceId: string | undefined;
}) {
  if (!props.lead) return props.children;
  return (
    <LeadPageProvider spaceId={props.spaceId}>
      {props.children}
    </LeadPageProvider>
  );
}
