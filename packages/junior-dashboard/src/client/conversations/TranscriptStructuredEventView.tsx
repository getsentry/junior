import {
  Activity,
  Brain,
  Calendar,
  Check,
  Database,
  Info,
  KeyRound,
  Link,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { formatMessageTimestamp } from "../format";
import type { TranscriptViewStructuredEventPart } from "../types";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

type TranscriptPresentationEventPart = TranscriptViewStructuredEventPart;

const icons: Record<
  NonNullable<TranscriptPresentationEventPart["presentation"]["icon"]>,
  LucideIcon
> = {
  activity: Activity,
  brain: Brain,
  calendar: Calendar,
  check: Check,
  database: Database,
  info: Info,
  key: KeyRound,
  link: Link,
  sparkles: Sparkles,
  warning: TriangleAlert,
};

/** Render one structured event with core-owned transcript interaction. */
export function TranscriptStructuredEventView(props: {
  part: TranscriptPresentationEventPart;
  timestamp?: number;
}) {
  const search = useTranscriptSearch();
  const presentation = props.part.presentation;
  const Icon = presentation.icon ? icons[presentation.icon] : Activity;
  const timestamp = formatMessageTimestamp(props.timestamp);
  const details = presentation.details ?? [];
  const body =
    details.length > 0 ? (
      <div className="grid gap-2 pb-1 pl-6 pt-2">
        {details.map((detail, index) => (
          <div
            className="rounded border border-white/[0.06] bg-white/[0.025] px-3 py-2.5"
            key={`${detail.title}:${index}`}
          >
            <div className="whitespace-pre-wrap break-words text-[0.84rem] text-dashboard-text">
              <HighlightText text={detail.title} />
            </div>
            {detail.description ? (
              <div className="mt-1 whitespace-pre-wrap break-words text-[0.78rem] leading-relaxed text-dashboard-text-muted">
                <HighlightText text={detail.description} />
              </div>
            ) : null}
            {detail.metadata?.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.metadata.map((value) => (
                  <span
                    className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[0.68rem] text-dashboard-text-muted"
                    key={value}
                  >
                    <HighlightText text={value} />
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    ) : null;
  const header = (
    <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2 max-md:grid-cols-[1rem_minmax(0,1fr)]">
      <span className="mt-0.5 inline-flex size-4 items-center justify-center text-dashboard-text-muted">
        <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
      </span>
      <div className="min-w-0">
        <div className="font-medium text-dashboard-text-muted">
          <HighlightText text={presentation.title} />
        </div>
        {presentation.preview ? (
          <div className="mt-0.5 truncate text-[0.78rem] text-dashboard-text-muted">
            <HighlightText text={presentation.preview} />
          </div>
        ) : null}
      </div>
      {timestamp ? (
        <span className="font-mono text-[0.72rem] text-dashboard-text-muted max-md:hidden">
          {timestamp}
        </span>
      ) : null}
    </div>
  );

  if (details.length === 0 || search.active) {
    return (
      <div className="py-1.5 font-mono text-[0.82rem] leading-tight">
        {header}
        {body}
      </div>
    );
  }
  return (
    <details className="group/plugin-event py-1.5 font-mono text-[0.82rem] leading-tight">
      <summary className="cursor-pointer list-none transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 [&::-webkit-details-marker]:hidden">
        {header}
      </summary>
      {body}
    </details>
  );
}
