import { Fragment } from "react";
import { CircleCheck, CircleDashed, CircleX } from "lucide-react";
import { Link } from "react-router";
import type {
  WalkthroughDocument,
  WalkthroughEvidence as Evidence,
  WalkthroughHunk,
} from "@sentry/junior/api/schema";

import { OutboundLink } from "../components/OutboundLink";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { conversationPath } from "../conversations/conversationRoutes";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";

type Source = WalkthroughDocument["sources"][number];
type Check = WalkthroughDocument["checks"][number];

// A reviewer may never have opened the Conversation, so Brief lines name it,
// not the Brief.
const sourceLabels: Record<Source["kind"], string> = {
  brief_decision: "Conversation",
  brief_fact: "Conversation",
  pr_body: "PR description",
  sentry: "Sentry",
};

/** One numbered piece of chapter evidence, resolved against the document. */
export type CitedEvidence =
  | {
      kind: "hunk";
      n: number;
      evidence: Evidence & { kind: "hunk" };
      hunk: WalkthroughHunk;
    }
  | { kind: "source"; n: number; source: Source }
  | { kind: "check"; n: number; check: Check };

/** Resolve evidence in prose order, so "[2]" is the second item. */
export function citedEvidence(
  document: WalkthroughDocument,
  hunks: ReadonlyMap<string, WalkthroughHunk>,
  evidence: readonly Evidence[],
): CitedEvidence[] {
  return evidence.flatMap((e, index): CitedEvidence[] => {
    const n = index + 1;
    if (e.kind === "hunk") {
      const hunk = hunks.get(e.hunkId);
      return hunk ? [{ kind: "hunk", n, evidence: e, hunk }] : [];
    }
    if (e.kind === "source") {
      const source = document.sources.find((s) => s.id === e.sourceId);
      return source ? [{ kind: "source", n, source }] : [];
    }
    const check = document.checks.find((c) => c.id === e.checkId);
    return check ? [{ kind: "check", n, check }] : [];
  });
}

/** DOM id of one reference, so a citation can scroll to it. */
export function referenceId(scope: string, n: number): string {
  return `wt-ref-${scope}-${n}`.replace(/[^\w-]/g, "-");
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function referenceLabel(ref: CitedEvidence): string {
  if (ref.kind === "hunk") return fileName(ref.hunk.path);
  if (ref.kind === "check") return ref.check.label;
  const kind = ref.source.decisionKind
    ? ` · ${decisionKindLabels[ref.source.decisionKind]}`
    : "";
  return `${sourceLabels[ref.source.kind]}${kind}: ${ref.source.text}`;
}

function scrollToReference(id: string) {
  const element = document.getElementById(id);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.dataset.flash = "true";
  window.setTimeout(() => delete element.dataset.flash, 1200);
}

/** The number badge that a citation and its reference share. */
function ReferenceNumber(props: { n: number }) {
  return (
    <span className="inline-grid h-4.5 min-w-4.5 place-items-center rounded bg-dashboard-fill-strong px-1 font-sans text-xs leading-none font-medium tabular-nums text-dashboard-text-muted">
      {props.n}
    </span>
  );
}

/** A citation in prose. Small and raised, like a footnote mark. */
function CitationMark(props: { n: number }) {
  return (
    <span className="inline-grid h-3.5 min-w-3.5 place-items-center rounded-sm bg-dashboard-fill-strong px-0.5 font-sans text-2xs leading-none font-medium tabular-nums text-dashboard-text-muted">
      {props.n}
    </span>
  );
}

const flashClass =
  "scroll-mt-24 transition-colors data-[flash=true]:bg-dashboard-accent/10";

/**
 * Prose with "[n]" citations as small numbered links. Hover shows what the
 * citation points at, and a click scrolls to it.
 */
export function CitedProse(props: {
  className?: string;
  refs: readonly CitedEvidence[];
  scope: string;
  text: string;
}) {
  // Split into text runs and the citations that follow each run.
  const runs: { cites: CitedEvidence[]; text: string }[] = [];
  for (const part of props.text.split(/(\[\d+\])/)) {
    const n = /^\[(\d+)\]$/.exec(part)?.[1];
    const ref = n ? props.refs.find((r) => r.n === Number(n)) : undefined;
    const last = runs.at(-1);
    if (ref && last) last.cites.push(ref);
    else if (ref) runs.push({ cites: [ref], text: "" });
    else if (part) runs.push({ cites: [], text: part });
  }
  return (
    <p className={cn("m-0", props.className)}>
      {runs.map((run, index) => {
        if (!run.cites.length) {
          return <DisplayText inline key={index} text={run.text} />;
        }
        // Keep a mark on the line of the word it follows. Skip a word that
        // carries markdown, so the split cannot break its formatting.
        const match = /^([\s\S]*?)(\S*)\s*$/.exec(run.text);
        const word = match?.[2] ?? "";
        const plain = !/[*_`[\]]/.test(word);
        const head = plain ? (match?.[1] ?? "") : run.text;
        return (
          <Fragment key={index}>
            {head ? <DisplayText inline text={head} /> : null}
            <span className="whitespace-nowrap">
              {plain ? word : null}
              {run.cites.map((ref) => (
                <CitationButton key={ref.n} refItem={ref} scope={props.scope} />
              ))}
            </span>
          </Fragment>
        );
      })}
    </p>
  );
}

function CitationButton(props: { refItem: CitedEvidence; scope: string }) {
  const ref = props.refItem;
  const id = referenceId(props.scope, ref.n);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={`Reference ${ref.n}: ${referenceLabel(ref)}`}
            className="ml-0.5 inline cursor-pointer border-0 bg-transparent p-0 align-super leading-none hover:[&>span]:text-dashboard-text"
            onClick={() => scrollToReference(id)}
            type="button"
          >
            <CitationMark n={ref.n} />
          </button>
        }
      />
      <TooltipContent>
        <DisplayText inline text={referenceLabel(ref)} />
      </TooltipContent>
    </Tooltip>
  );
}

const decisionKindLabels: Record<
  NonNullable<Source["decisionKind"]>,
  string
> = {
  assumed: "Assumed",
  confirmed: "Confirmed",
  stated: "Stated",
};

const sourceLinkClass =
  "text-dashboard-text-muted underline decoration-dashboard-border-heavy underline-offset-2 hover:text-dashboard-text";

/**
 * Name where a source comes from. The name is the link, for every kind: a
 * Brief line opens its Conversation, and a Sentry line opens Sentry.
 */
function SourceLabel(props: { conversationId?: string; source: Source }) {
  const label = sourceLabels[props.source.kind];
  if (props.source.kind.startsWith("brief_") && props.conversationId) {
    return (
      <Link
        className={sourceLinkClass}
        to={conversationPath(props.conversationId)}
      >
        {label}
      </Link>
    );
  }
  if (props.source.url) {
    return (
      <OutboundLink className={sourceLinkClass} href={props.source.url}>
        {label}
      </OutboundLink>
    );
  }
  return label;
}

/** Sources the prose cites, as numbered footnotes. */
export function ReferenceList(props: {
  /** The Conversation that made the PR. Brief lines link to it. */
  conversationId?: string;
  refs: readonly CitedEvidence[];
  scope: string;
}) {
  const sources = props.refs.filter(
    (r): r is CitedEvidence & { kind: "source" } => r.kind === "source",
  );
  if (!sources.length) return null;
  return (
    <ol className="m-0 grid list-none gap-1 border-t border-dashboard-border-subtle p-0 pt-3">
      {sources.map((ref) => (
        <li
          className={cn(
            "grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2 rounded px-1 py-0.5 text-sm text-dashboard-text-subtle",
            flashClass,
          )}
          id={referenceId(props.scope, ref.n)}
          key={ref.n}
        >
          <ReferenceNumber n={ref.n} />
          <span>
            <span className="text-dashboard-text-muted">
              <SourceLabel
                conversationId={props.conversationId}
                source={ref.source}
              />
              {" · "}
              {ref.source.decisionKind === "assumed" ? (
                <span className="text-amber-300 light:text-amber-700">
                  {decisionKindLabels[ref.source.decisionKind]}
                  {" · "}
                </span>
              ) : ref.source.decisionKind ? (
                `${decisionKindLabels[ref.source.decisionKind]} · `
              ) : null}
            </span>
            <DisplayText inline text={ref.source.text} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * One cited hunk. When the column is wide, the explanation sits beside the
 * code. Code comes from the stored diff, never from the model.
 */
export function HunkReference(props: {
  layerUrl?: string;
  ref: CitedEvidence & { kind: "hunk" };
  scope: string;
  stacked: boolean;
}) {
  const { evidence, hunk } = props.ref;
  const lines = evidence.lines
    ? hunk.lines.slice(evidence.lines.start - 1, evidence.lines.end)
    : hunk.lines;
  return (
    <figure
      className={cn(
        "m-0 grid gap-3 rounded-md @3xl:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] @3xl:gap-5",
        flashClass,
      )}
      id={referenceId(props.scope, props.ref.n)}
    >
      <figcaption className="grid content-start gap-1.5 text-sm text-dashboard-text-subtle">
        <span className="flex min-w-0 items-center gap-2 text-xs text-dashboard-text-muted">
          <ReferenceNumber n={props.ref.n} />
          <span className="min-w-0 truncate font-mono" title={hunk.path}>
            {fileName(hunk.path)}
          </span>
          {hunk.url ? (
            <OutboundLink
              aria-label={`Open ${fileName(hunk.path)} on GitHub`}
              className="shrink-0 text-dashboard-text-muted no-underline hover:text-dashboard-text"
              href={hunk.url}
            >
              {props.stacked ? `#${hunk.pr}` : ""}
            </OutboundLink>
          ) : null}
        </span>
        {evidence.note ? (
          <span>
            <DisplayText inline text={evidence.note} />
          </span>
        ) : null}
      </figcaption>
      <pre className="m-0 min-w-0 overflow-x-auto rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel py-1.5 font-mono text-sm leading-relaxed">
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
    </figure>
  );
}

const checkIcons = {
  failed: { Icon: CircleX, className: "text-rose-300", label: "Failed" },
  passed: { Icon: CircleCheck, className: "text-emerald-300", label: "Passed" },
  pending: {
    Icon: CircleDashed,
    className: "text-dashboard-text-faint",
    label: "Running",
  },
} as const;

/** Checks that back the story: tests Junior ran and CI results. */
export function ProofCard(props: {
  refs: readonly CitedEvidence[];
  scope: string;
}) {
  const checks = props.refs.filter(
    (r): r is CitedEvidence & { kind: "check" } => r.kind === "check",
  );
  if (!checks.length) return null;
  return (
    <ul className="m-0 grid list-none gap-0 divide-y divide-dashboard-border-subtle rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel p-0">
      {checks.map((ref) => {
        const icon = checkIcons[ref.check.status];
        return (
          <li
            className={cn(
              "grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 px-3 py-2.5",
              flashClass,
            )}
            id={referenceId(props.scope, ref.n)}
            key={ref.n}
          >
            <ReferenceNumber n={ref.n} />
            <icon.Icon
              aria-label={icon.label}
              className={cn("mt-0.5 size-4", icon.className)}
            />
            <span className="grid gap-0.5">
              <span className="text-sm text-dashboard-text">
                <DisplayText inline text={ref.check.label} />
              </span>
              {ref.check.detail ? (
                <span className="text-xs text-dashboard-text-muted">
                  <DisplayText inline text={ref.check.detail} />
                </span>
              ) : null}
            </span>
            {ref.check.url ? (
              <OutboundLink
                className="text-xs text-dashboard-text-muted hover:text-dashboard-text"
                href={ref.check.url}
              >
                Run
              </OutboundLink>
            ) : (
              <span />
            )}
          </li>
        );
      })}
    </ul>
  );
}
