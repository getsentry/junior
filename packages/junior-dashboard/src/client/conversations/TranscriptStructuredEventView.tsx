import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { formatMessageTimestamp } from "../format";
import type { TranscriptViewStructuredEventPart } from "../types";
import { MentionText } from "./transcriptMentions";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";
import { TranscriptSummaryTrigger } from "./TranscriptSummary";

type TranscriptPresentationEventPart = TranscriptViewStructuredEventPart;

/** Render one structured event with core-owned transcript interaction. */
export function TranscriptStructuredEventView(props: {
  part: TranscriptPresentationEventPart;
  timestamp?: number;
}) {
  const search = useTranscriptSearch();
  const presentation = props.part.presentation;
  const timestamp = formatMessageTimestamp(props.timestamp);
  const details = presentation.details ?? [];
  const mentions = props.part.mentions ?? [];
  // The rail icon box is h-6. A leading-6 title shares its center line.
  const surfaceClass = "min-w-0 font-sans text-xs";
  // A lone detail often repeats the event title, such as "Loaded AGENTS.md"
  // over "AGENTS.md". Skip that repeated title.
  const repeatsTitle = (title: string) =>
    details.length === 1 && presentation.title.includes(title);
  const body =
    details.length > 0 ? (
      <div className="grid gap-4 pb-1 pt-2">
        {details.map((detail, index) => (
          <section key={`${detail.title}:${index}`}>
            {repeatsTitle(detail.title) ? null : (
              <div className="whitespace-pre-wrap break-words font-sans text-sm font-medium text-dashboard-text">
                <HighlightText text={detail.title} />
              </div>
            )}
            {detail.description ? (
              <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-dashboard-text-muted">
                <MentionText mentions={mentions} text={detail.description} />
              </div>
            ) : null}
            {detail.content ? (
              <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2.5 font-mono text-xs leading-normal text-dashboard-text-muted first:mt-0">
                <HighlightText text={detail.content} />
              </pre>
            ) : null}
            {detail.metadata?.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.metadata.map((value) => (
                  <span
                    className="text-xs text-dashboard-text-muted"
                    key={value}
                  >
                    <HighlightText text={value} />
                  </span>
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    ) : null;
  // The header can sit inside the row button, so it uses only inline elements.
  const header = (
    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 max-md:grid-cols-[minmax(0,1fr)]">
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-6 text-dashboard-text">
          <HighlightText text={presentation.title} />
        </span>
        {presentation.preview ? (
          <span className="mt-0.5 block truncate text-xs text-dashboard-text-muted">
            <MentionText mentions={mentions} text={presentation.preview} />
          </span>
        ) : null}
      </span>
      {timestamp ? (
        <span className="text-xs leading-6 tabular-nums text-dashboard-text-muted max-md:hidden">
          {timestamp}
        </span>
      ) : null}
    </span>
  );

  if (details.length === 0 || search.active) {
    return (
      <div className={surfaceClass}>
        {header}
        {body}
      </div>
    );
  }
  return (
    <Collapsible className={surfaceClass}>
      <TranscriptSummaryTrigger flush className="block">
        {header}
      </TranscriptSummaryTrigger>
      <CollapsibleContent hiddenUntilFound>{body}</CollapsibleContent>
    </Collapsible>
  );
}
