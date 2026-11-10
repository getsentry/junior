import type {
  WalkthroughDocument,
  WalkthroughEvidence as Evidence,
  WalkthroughHunk,
} from "@sentry/junior/api/schema";

import { OutboundLink } from "../components/OutboundLink";
import { DisplayText } from "../display-text/DisplayText";
import { StatusChip } from "../components/StatusChip";
import { cn } from "../styles";

const sourceLabels: Record<
  WalkthroughDocument["sources"][number]["kind"],
  string
> = {
  brief_decision: "Decision in the Brief",
  brief_fact: "From the Brief",
  pr_body: "From the PR description",
  sentry: "From Sentry",
};

/** Render one piece of evidence. Code comes from the stored diff, never the model. */
export function WalkthroughEvidence(props: {
  document: WalkthroughDocument;
  evidence: Evidence;
  hunks: ReadonlyMap<string, WalkthroughHunk>;
}) {
  const { evidence } = props;
  if (evidence.kind === "hunk") {
    const hunk = props.hunks.get(evidence.hunkId);
    if (!hunk) return null;
    const lines = evidence.lines
      ? hunk.lines.slice(evidence.lines.start - 1, evidence.lines.end)
      : hunk.lines;
    const layer = props.document.layers.find((l) => l.pr === hunk.pr);
    return (
      <figure className="m-0 min-w-0 overflow-hidden rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel">
        <figcaption className="flex min-w-0 items-center justify-between gap-3 border-b border-dashboard-border-subtle px-3 py-2 text-xs text-dashboard-text-muted">
          <span className="min-w-0 truncate font-mono" title={hunk.path}>
            {hunk.path.split("/").slice(-2).join("/")}
          </span>
          {layer ? (
            <OutboundLink
              className="shrink-0 text-dashboard-text-muted no-underline hover:text-dashboard-text"
              href={`${layer.url}/files`}
            >
              #{hunk.pr}
            </OutboundLink>
          ) : null}
        </figcaption>
        <pre className="m-0 overflow-x-auto py-1.5 font-mono text-sm leading-relaxed">
          {lines.map((line, index) => (
            <div
              className={cn(
                "flex min-w-max gap-3 px-3",
                line.kind === "add" &&
                  "bg-emerald-400/10 text-emerald-200 light:text-emerald-800",
                line.kind === "remove" &&
                  "bg-rose-400/10 text-rose-200 light:text-rose-800",
                line.kind === "context" && "text-dashboard-text-muted",
              )}
              key={index}
            >
              <span
                aria-hidden="true"
                className="w-8 shrink-0 select-none text-right text-dashboard-text-faint"
              >
                {line.newLine ?? line.oldLine}
              </span>
              <span aria-hidden="true" className="w-3 shrink-0 select-none">
                {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
              </span>
              <code>{line.content}</code>
            </div>
          ))}
        </pre>
        {evidence.note ? (
          <p className="m-0 border-t border-dashboard-border-subtle px-3 py-2 text-sm text-dashboard-text-subtle">
            {evidence.note}
          </p>
        ) : null}
      </figure>
    );
  }
  if (evidence.kind === "source") {
    const source = props.document.sources.find(
      (s) => s.id === evidence.sourceId,
    );
    return (
      <div className="grid gap-1 rounded-md border border-dashboard-border-subtle bg-dashboard-fill-faint px-3 py-2.5">
        <span className="text-xs text-dashboard-text-muted">
          {source ? sourceLabels[source.kind] : "Source"}
          {source?.url ? (
            <>
              {" · "}
              <OutboundLink
                className="text-dashboard-text-muted hover:text-dashboard-text"
                href={source.url}
              >
                Open
              </OutboundLink>
            </>
          ) : null}
        </span>
        {source ? (
          <span className="text-sm text-dashboard-text">
            <DisplayText inline text={source.text} />
          </span>
        ) : null}
      </div>
    );
  }
  const check = props.document.checks.find((c) => c.id === evidence.checkId);
  if (!check) return null;
  return (
    <StatusChip
      tone={
        check.status === "passed"
          ? "success"
          : check.status === "failed"
            ? "danger"
            : "warning"
      }
    >
      {check.label}
    </StatusChip>
  );
}
