import { Fragment } from "react";
import { CircleCheck, CircleDashed, CircleX } from "lucide-react";
import { Link } from "react-router";

import { OutboundLink } from "../components/OutboundLink";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { conversationPath } from "../conversations/conversationRoutes";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import type { CitedEvidence } from "./walkthroughModel";

/** DOM id of one reference, so a citation can scroll to it. */
function referenceId(scope: string, n: number): string {
  return `wt-ref-${scope}-${n}`.replace(/[^\w-]/g, "-");
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function referenceLabel(ref: CitedEvidence): string {
  switch (ref.kind) {
    case "code":
      return `${fileName(ref.excerpt.path)}:${ref.excerpt.start}`;
    case "check":
      return ref.check.label;
    case "link":
      return ref.label;
    case "message":
      return `Conversation: ${ref.message.text}`;
  }
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

const flashClass =
  "scroll-mt-24 transition-colors data-[flash=true]:bg-dashboard-accent/10";

/**
 * Prose with "[n]" citations as superscript marks, like footnotes. Hover shows
 * what a mark points at, and a click scrolls to it.
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
    // A citation the document cannot resolve drops out of the prose.
    else if (part && !n) runs.push({ cites: [], text: part });
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
              {run.cites.map((ref, cite) => (
                <Fragment key={ref.n}>
                  {/* Commas keep "2,3" from reading as 23. */}
                  {cite > 0 ? (
                    <span className="align-super font-sans text-2xs leading-none text-dashboard-text-muted">
                      ,
                    </span>
                  ) : null}
                  <CitationMark refItem={ref} scope={props.scope} />
                </Fragment>
              ))}
            </span>
          </Fragment>
        );
      })}
    </p>
  );
}

function CitationMark(props: { refItem: CitedEvidence; scope: string }) {
  const ref = props.refItem;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={`Reference ${ref.n}: ${referenceLabel(ref)}`}
            className="ml-px inline cursor-pointer border-0 bg-transparent p-0 align-super font-sans text-2xs leading-none font-medium tabular-nums text-dashboard-accent-text hover:underline"
            onClick={() => scrollToReference(referenceId(props.scope, ref.n))}
            type="button"
          >
            {ref.n}
          </button>
        }
      />
      <TooltipContent>
        <DisplayText inline text={referenceLabel(ref)} />
      </TooltipContent>
    </Tooltip>
  );
}

const sourceLinkClass =
  "text-dashboard-text-muted underline decoration-dashboard-border-heavy underline-offset-2 hover:text-dashboard-text";

/**
 * Messages and links that the prose cites, as numbered footnotes. The name of
 * the source is the link: a message opens its Conversation.
 */
export function ReferenceList(props: {
  /** The Conversation that made the PR. Cited messages link to it. */
  conversationId?: string;
  refs: readonly CitedEvidence[];
  scope: string;
}) {
  const sources = props.refs.filter(
    (r) => r.kind === "message" || r.kind === "link",
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
          {ref.kind === "link" ? (
            <OutboundLink className={sourceLinkClass} href={ref.url}>
              {ref.label}
            </OutboundLink>
          ) : ref.kind === "message" ? (
            <span>
              {props.conversationId ? (
                <Link
                  className={sourceLinkClass}
                  to={conversationPath(props.conversationId)}
                >
                  Conversation
                </Link>
              ) : (
                <span className="text-dashboard-text-muted">Conversation</span>
              )}
              <span className="text-dashboard-text-muted"> · </span>
              <DisplayText inline text={ref.message.text} />
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * One cited code excerpt. When the column is wide, the note sits beside the
 * code. Code comes from the stored diff, never from the model.
 */
export function CodeReference(props: {
  refItem: CitedEvidence & { kind: "code" };
  scope: string;
  stacked: boolean;
}) {
  const { evidence, excerpt } = props.refItem;
  const location = `${fileName(excerpt.path)}:${excerpt.start}`;
  return (
    <figure
      className={cn(
        "m-0 grid gap-3 rounded-md @3xl:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] @3xl:gap-5",
        flashClass,
      )}
      id={referenceId(props.scope, props.refItem.n)}
    >
      <figcaption className="grid content-start gap-1.5 text-sm text-dashboard-text-subtle">
        <span className="flex min-w-0 items-center gap-2 text-xs text-dashboard-text-muted">
          <ReferenceNumber n={props.refItem.n} />
          {excerpt.url ? (
            <OutboundLink
              className="min-w-0 truncate font-mono text-dashboard-text-muted hover:text-dashboard-text"
              href={excerpt.url}
              title={excerpt.path}
            >
              {location}
            </OutboundLink>
          ) : (
            <span className="min-w-0 truncate font-mono" title={excerpt.path}>
              {location}
            </span>
          )}
          {props.stacked ? (
            <span className="shrink-0 font-mono">#{excerpt.pr}</span>
          ) : null}
        </span>
        {evidence.note ? (
          <span>
            <DisplayText inline text={evidence.note} />
          </span>
        ) : null}
      </figcaption>
      {/* Wrap long lines: a reviewer should not scroll sideways to read
          the cited code. */}
      <pre className="m-0 min-w-0 rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel py-1.5 font-mono text-sm leading-relaxed">
        {excerpt.lines.map((line, index) => (
          <div
            className={cn(
              "flex gap-3 px-3",
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
            <code className="min-w-0 break-words whitespace-pre-wrap">
              {line.content}
            </code>
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

/** Checks that back the story, such as CI results. */
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
