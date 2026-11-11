import { Fragment } from "react";
import { CircleCheck, CircleDashed, CircleX, X } from "lucide-react";
import { Link } from "react-router";

import { OutboundLink } from "../components/OutboundLink";
import { Button } from "../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { conversationPath } from "../conversations/conversationRoutes";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import type { CitedEvidence } from "./walkthroughModel";

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** What a citation points at, in a few words. */
function referenceLabel(ref: CitedEvidence): string {
  switch (ref.kind) {
    case "code":
      return `${fileName(ref.excerpt.path)}:${ref.excerpt.start}`;
    case "check":
      return ref.check.label;
    case "link":
      return ref.label;
    case "message":
      return "Message in the Conversation";
  }
}

/** The number badge that a citation and its evidence share. */
function ReferenceNumber(props: { n: number }) {
  return (
    <span className="inline-grid h-4.5 min-w-4.5 place-items-center rounded bg-dashboard-fill-strong px-1 font-sans text-xs leading-none font-medium tabular-nums text-dashboard-text-muted">
      {props.n}
    </span>
  );
}

/**
 * Prose with "[n]" citations as superscript marks, like footnotes. Hover
 * names what a mark points at. A click, or focus when `openOnFocus`, opens
 * that evidence.
 */
export function CitedProse(props: {
  className?: string;
  /** The open citation in this prose, if any. */
  openN?: number;
  /** Focus opens evidence too, when opening it does not move focus. */
  openOnFocus: boolean;
  onOpen(n: number): void;
  refs: readonly CitedEvidence[];
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
                  <CitationMark
                    onOpen={() => props.onOpen(ref.n)}
                    open={props.openN === ref.n}
                    openOnFocus={props.openOnFocus}
                    refItem={ref}
                  />
                </Fragment>
              ))}
            </span>
          </Fragment>
        );
      })}
    </p>
  );
}

function CitationMark(props: {
  onOpen(): void;
  open: boolean;
  openOnFocus: boolean;
  refItem: CitedEvidence;
}) {
  const ref = props.refItem;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-expanded={props.open}
            aria-label={`Evidence ${ref.n}: ${referenceLabel(ref)}`}
            className={cn(
              "ml-px inline cursor-pointer rounded-sm border-0 bg-transparent px-0.5 align-super font-sans text-2xs leading-none font-medium tabular-nums text-dashboard-accent-text hover:underline",
              props.open && "bg-dashboard-accent/15",
            )}
            onClick={props.onOpen}
            onFocus={props.openOnFocus ? props.onOpen : undefined}
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

/**
 * One cited piece of evidence, opened from its citation: code, a message, a
 * check, or a link. It sits beside the prose, or in a drawer when the column
 * is narrow.
 */
export function EvidencePanel(props: {
  conversationId?: string;
  onClose?(): void;
  refItem: CitedEvidence;
  stacked: boolean;
}) {
  const ref = props.refItem;
  return (
    <section
      aria-label={`Evidence ${ref.n}`}
      className="grid min-w-0 content-start gap-3"
    >
      <header className="flex items-start gap-2">
        <span className="mt-0.5">
          <ReferenceNumber n={ref.n} />
        </span>
        <EvidenceTitle refItem={ref} stacked={props.stacked} />
        {props.onClose ? (
          <Button
            aria-label="Close evidence"
            className="-mt-2 -mr-2 ml-auto shrink-0"
            onClick={props.onClose}
            size="icon"
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
      </header>
      <EvidenceBody conversationId={props.conversationId} refItem={ref} />
    </section>
  );
}

const sourceLinkClass =
  "text-dashboard-text-subtle underline decoration-dashboard-border-heavy underline-offset-2 hover:text-dashboard-text";

/** The full name of what the evidence is. Paths wrap; nothing is cut. */
function EvidenceTitle(props: { refItem: CitedEvidence; stacked: boolean }) {
  const ref = props.refItem;
  const className = "min-w-0 text-sm break-words text-dashboard-text";
  switch (ref.kind) {
    case "code": {
      const location = `${ref.excerpt.path}:${ref.excerpt.start}`;
      return (
        <span className={cn(className, "grid gap-0.5")}>
          {ref.excerpt.url ? (
            <OutboundLink
              className={cn(sourceLinkClass, "font-mono break-all")}
              href={ref.excerpt.url}
            >
              {location}
            </OutboundLink>
          ) : (
            <span className="font-mono break-all">{location}</span>
          )}
          {props.stacked ? (
            <span className="text-xs text-dashboard-text-muted">
              #{ref.excerpt.pr}
            </span>
          ) : null}
        </span>
      );
    }
    case "link":
      return (
        <OutboundLink className={cn(className, sourceLinkClass)} href={ref.url}>
          {ref.label}
        </OutboundLink>
      );
    case "check":
    case "message":
      return <span className={className}>{referenceLabel(ref)}</span>;
  }
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

function EvidenceBody(props: {
  conversationId?: string;
  refItem: CitedEvidence;
}) {
  const ref = props.refItem;
  switch (ref.kind) {
    case "code":
      return (
        <>
          {ref.evidence.note ? (
            <p className="m-0 text-sm text-dashboard-text-subtle">
              <DisplayText inline text={ref.evidence.note} />
            </p>
          ) : null}
          <CodeExcerpt excerpt={ref.excerpt} />
        </>
      );
    case "message":
      return (
        <blockquote className="m-0 grid gap-2 border-l-2 border-dashboard-border-emphasis pl-3 text-sm text-dashboard-text-subtle">
          <DisplayText text={ref.message.text} />
          {props.conversationId ? (
            <Link
              className={cn(sourceLinkClass, "w-fit text-xs")}
              to={conversationPath(props.conversationId)}
            >
              Open the Conversation
            </Link>
          ) : null}
        </blockquote>
      );
    case "check": {
      const icon = checkIcons[ref.check.status];
      return (
        <p className="m-0 flex items-start gap-2 text-sm text-dashboard-text-subtle">
          <icon.Icon
            aria-label={icon.label}
            className={cn("mt-0.5 size-4 shrink-0", icon.className)}
          />
          <span className="grid gap-0.5">
            {ref.check.detail ? (
              <DisplayText inline text={ref.check.detail} />
            ) : (
              icon.label
            )}
            {ref.check.url ? (
              <OutboundLink
                className={cn(sourceLinkClass, "w-fit text-xs")}
                href={ref.check.url}
              >
                Open the run
              </OutboundLink>
            ) : null}
          </span>
        </p>
      );
    }
    case "link":
      return (
        <p className="m-0 text-xs break-all text-dashboard-text-muted">
          {ref.url}
        </p>
      );
  }
}

/** Cited code from the stored diff, never from the model. Lines wrap. */
function CodeExcerpt(props: {
  excerpt: (CitedEvidence & { kind: "code" })["excerpt"];
}) {
  return (
    <pre className="m-0 min-w-0 rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel py-1.5 font-mono text-sm leading-relaxed">
      {props.excerpt.lines.map((line, index) => (
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
  );
}
