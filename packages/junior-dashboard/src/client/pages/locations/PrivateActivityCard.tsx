import { LockKeyhole } from "lucide-react";
import type { ConversationStatsItem } from "@sentry/junior/api/schema";

import { Card } from "../../components/layout/Card";
import { formatCompactNumber } from "../../format";

/** Summarize private activity without exposing private destinations. */
export function PrivateActivityCard(props: { item: ConversationStatsItem }) {
  return (
    <Card className="opacity-80" padding="sm">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 max-sm:grid-cols-[auto_minmax(0,1fr)]">
        <span className="grid size-9 shrink-0 place-items-center rounded border border-dashboard-border-medium bg-dashboard-fill-soft text-dashboard-text-muted">
          <LockKeyhole aria-hidden="true" size={15} />
        </span>
        <div className="min-w-0">
          <div className="font-display text-base font-medium text-dashboard-text">
            Private activity
          </div>
          <div className="mt-1 font-mono text-xs leading-relaxed text-dashboard-text-muted">
            DMs, private channels, and unknown visibility stay combined and
            unlinked.
          </div>
        </div>
        <div className="text-right max-sm:col-start-2 max-sm:text-left">
          <div className="font-display text-2xl font-light text-dashboard-text">
            {formatCompactNumber(props.item.conversations)}
          </div>
          <div className="font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted">
            conversations
          </div>
        </div>
      </div>
    </Card>
  );
}
