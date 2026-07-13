import { LockKeyhole } from "lucide-react";
import type { ConversationStatsItem } from "@sentry/junior/api/schema";

import { Card } from "../../components/layout/Card";
import { formatCompactNumber } from "../../format";

/** Summarize private activity without exposing private destinations. */
export function PrivateActivityCard(props: { item: ConversationStatsItem }) {
  return (
    <Card className="opacity-80" padding="sm">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 max-sm:grid-cols-[auto_minmax(0,1fr)]">
        <span className="grid size-9 shrink-0 place-items-center rounded border border-white/[0.08] bg-white/[0.025] text-white/35">
          <LockKeyhole aria-hidden="true" size={15} />
        </span>
        <div className="min-w-0">
          <div className="font-display text-[1rem] font-medium text-white/80">
            Private activity
          </div>
          <div className="mt-1 font-mono text-[0.67rem] leading-relaxed text-white/30">
            DMs, private channels, and unknown visibility stay combined and
            unlinked.
          </div>
        </div>
        <div className="text-right max-sm:col-start-2 max-sm:text-left">
          <div className="font-display text-2xl font-light text-white/80">
            {formatCompactNumber(props.item.conversations)}
          </div>
          <div className="font-mono text-[0.58rem] uppercase tracking-[0.1em] text-white/25">
            conversations
          </div>
        </div>
      </div>
    </Card>
  );
}
