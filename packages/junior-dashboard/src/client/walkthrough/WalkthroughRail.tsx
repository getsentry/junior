import type {
  WalkthroughDocument,
  WalkthroughHunk,
} from "@sentry/junior/api/schema";

import { StatusChip } from "../components/StatusChip";
import { Button } from "../components/ui/button";
import { cn } from "../styles";
import {
  evidencePrs,
  layerStatus,
  slotLabels,
  type AnswerMap,
  type LayerStatus,
  type ReviewDecision,
  type WalkthroughStep,
} from "./walkthroughModel";

/** Stack layers with review status, then the steps in reading order. */
export function WalkthroughRail(props: {
  activeKey: string;
  answers: AnswerMap;
  approved: ReadonlySet<number>;
  decisions: readonly ReviewDecision[];
  document: WalkthroughDocument;
  hunks: ReadonlyMap<string, WalkthroughHunk>;
  onApprove(pr: number): void;
  onSelect(key: string): void;
  steps: readonly WalkthroughStep[];
}) {
  const { document } = props;
  // Layers are stored bottom first. Read the stack top down, like GitHub.
  const layers = [...document.layers].reverse();
  const statuses = new Map(
    document.layers.map((l) => [
      l.pr,
      layerStatus(l.pr, props.decisions, props.answers),
    ]),
  );
  const update = document.updates.at(-1);
  const pushedPrs = new Set(
    update
      ? evidencePrs(
          update.items.flatMap((i) => i.evidence),
          props.hunks,
        )
      : [],
  );

  return (
    <nav aria-label="Walkthrough" className="grid content-start gap-6">
      <section className="grid gap-2">
        <h3 className="m-0 text-xs font-medium text-dashboard-text-muted">
          Stack of {layers.length}
        </h3>
        <ol className="m-0 grid list-none gap-2 p-0">
          {layers.map((layer) => {
            const status = statuses.get(layer.pr) ?? { kind: "ready" as const };
            const below = document.layers
              .slice(0, document.layers.indexOf(layer))
              .find((l) => statuses.get(l.pr)?.kind !== "ready");
            const approved = props.approved.has(layer.pr);
            return (
              <li
                className="grid gap-1.5 rounded-md border border-dashboard-border-subtle bg-dashboard-fill-faint px-3 py-2.5"
                key={layer.pr}
              >
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="font-mono text-xs text-dashboard-text-muted">
                    #{layer.pr}
                  </span>
                  <span
                    className="min-w-0 truncate text-sm text-dashboard-text"
                    title={layer.title}
                  >
                    {layer.title}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-dashboard-text-muted">
                  <span>
                    {layer.additions || layer.deletions
                      ? `+${layer.additions} −${layer.deletions}`
                      : "Moves only"}
                    {update
                      ? pushedPrs.has(layer.pr)
                        ? " · changed in update"
                        : " · no change"
                      : ""}
                  </span>
                  {approved ? (
                    <StatusChip size="compact" tone="success">
                      Approved by you
                    </StatusChip>
                  ) : (
                    <StatusChip size="compact" tone={statusTone(status)}>
                      {statusLabel(status)}
                    </StatusChip>
                  )}
                </div>
                {status.kind === "ready" && !approved ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-dashboard-text-faint">
                      {below ? `Merges after #${below.pr}` : ""}
                    </span>
                    <Button
                      className="shrink-0 whitespace-nowrap"
                      onClick={() => props.onApprove(layer.pr)}
                      type="button"
                    >
                      Approve as you
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      <section className="grid gap-2">
        <h3 className="m-0 text-xs font-medium text-dashboard-text-muted">
          {update && props.steps[0]?.kind === "item"
            ? "In this update"
            : "Story"}
        </h3>
        <ol className="m-0 grid list-none gap-0.5 p-0">
          {props.steps.map((step, index) => {
            const label =
              step.kind === "chapter"
                ? (slotLabels[step.chapter.slot] ?? step.chapter.slot)
                : step.item.caption;
            const active = step.key === props.activeKey;
            return (
              <li key={step.key}>
                <button
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-2 rounded-md border-0 px-2 py-1.5 text-left text-sm",
                    active
                      ? "bg-dashboard-fill-strong text-dashboard-text"
                      : "bg-transparent text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text",
                  )}
                  onClick={() => props.onSelect(step.key)}
                  type="button"
                >
                  <span className="w-4 shrink-0 text-right font-mono text-xs leading-5 text-dashboard-text-faint">
                    {index + 1}
                  </span>
                  <span className="min-w-0">{label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      {document.skipped.length ? (
        <p className="m-0 text-xs leading-relaxed text-dashboard-text-faint">
          Not in the story:{" "}
          {document.skipped
            .map(
              (s) =>
                `${s.files} ${s.reason === "moved" ? "moved" : s.reason} file${s.files === 1 ? "" : "s"}`,
            )
            .join(", ")}
          .
        </p>
      ) : null}
    </nav>
  );
}

function statusLabel(status: LayerStatus): string {
  if (status.kind === "ready") return "Ready";
  if (status.kind === "changes") return "Changes requested";
  return `${status.count} to answer`;
}

function statusTone(status: LayerStatus) {
  if (status.kind === "ready") return "success" as const;
  if (status.kind === "changes") return "warning" as const;
  return "neutral" as const;
}
