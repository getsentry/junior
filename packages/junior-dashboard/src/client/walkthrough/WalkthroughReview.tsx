import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { WalkthroughDocument } from "@sentry/junior/api/schema";

import { useCopyText } from "../components/CopyButton";
import { OutboundLink } from "../components/OutboundLink";
import { Button } from "../components/ui/button";
import { ButtonGroup } from "../components/ui/button-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { Textarea } from "../components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import {
  openDecisionCount,
  reviewMarkdown,
  type AnswerMap,
  type ReviewDecision,
} from "./walkthroughModel";

type Layer = WalkthroughDocument["layers"][number];
type Filter = "all" | "open";

/**
 * The reviewer's review as one short list: what is still open, and what they
 * agreed with, asked to change, or skipped. The text to paste into GitHub is
 * only behind Copy review.
 */
export function WalkthroughReview(props: {
  /** The chapter the reviewer is on. Its claims show highlighted. */
  activeChapter: number;
  answers: AnswerMap;
  chapterTitles: readonly string[];
  decisions: readonly ReviewDecision[];
  document: WalkthroughDocument;
  onOpenChapter(index: number): void;
}) {
  const { answers, decisions } = props;
  const open = openDecisionCount(decisions, answers);
  const [filter, setFilter] = useState<Filter>(() => (open ? "open" : "all"));
  const [comment, setComment] = useCommentDraft(props.document.versionId);
  const shown =
    filter === "open" ? decisions.filter((d) => !answers[d.id]) : decisions;
  const listRef = useRef<HTMLDivElement>(null);
  // Keep the current chapter's claims in view, since a stack's list is
  // longer than the panel.
  useEffect(() => {
    listRef.current
      ?.querySelector("[data-active-chapter]")
      ?.scrollIntoView({ block: "nearest" });
  }, [props.activeChapter]);

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]">
      <div className="flex items-center justify-between gap-2 border-b border-dashboard-border-subtle px-4 py-2">
        <p className="m-0 text-sm text-dashboard-text">
          <span className="tabular-nums">{open}</span> of{" "}
          <span className="tabular-nums">{decisions.length}</span> open
        </p>
        <ToggleGroup
          aria-label="Show claims"
          onValueChange={(values) => {
            const next = values[0];
            if (next) setFilter(next);
          }}
          value={[filter]}
        >
          <ToggleGroupItem value="open">Open</ToggleGroupItem>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div
        className="thin-scrollbar min-h-0 overflow-y-auto overscroll-contain px-2 py-2"
        ref={listRef}
      >
        {shown.length ? (
          chapterGroups(shown).map((group) => (
            <section
              className={cn(
                "grid grid-cols-[minmax(0,1fr)] gap-0.5 rounded-md py-1",
                group.chapterIndex === props.activeChapter &&
                  "bg-dashboard-fill-strong",
              )}
              data-active-chapter={
                group.chapterIndex === props.activeChapter ? "" : undefined
              }
              key={group.chapterIndex}
            >
              <h3 className="m-0 px-2 font-sans text-xs font-medium break-words text-dashboard-text-muted">
                <DisplayText
                  inline
                  links={false}
                  text={props.chapterTitles[group.chapterIndex] ?? ""}
                />
              </h3>
              <ul className="m-0 list-none p-0">
                {group.decisions.map((decision) => (
                  <li key={decision.id}>
                    <ClaimRow
                      answer={answers[decision.id]}
                      decision={decision}
                      onOpen={() => props.onOpenChapter(decision.chapterIndex)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p className="m-0 px-2 py-2">
            {decisions.length ? "Nothing open." : "Nothing to decide here."}
          </p>
        )}
      </div>
      <div className="grid gap-2 border-t border-dashboard-border-subtle px-4 py-3">
        <ReviewComment comment={comment} onChange={setComment} />
        <CopyReview
          activePr={
            decisions.find((d) => d.chapterIndex === props.activeChapter)
              ?.prs[0]
          }
          answers={answers}
          comment={comment}
          decisions={decisions}
          layers={props.document.layers}
        />
      </div>
    </div>
  );
}

const statusLabels = {
  agree: "Agreed",
  change: "Change requested",
  open: "Open",
  skip: "Skipped",
} as const;

const dotClasses = {
  agree: "bg-emerald-400 light:bg-emerald-600",
  change: "bg-amber-300 light:bg-amber-600",
  open: "border border-dashboard-text-muted",
  skip: "bg-dashboard-text-faint",
} as const;

/** One claim, wrapped in full. The row opens the chapter that asks it. */
function ClaimRow(props: {
  answer: AnswerMap[string] | undefined;
  decision: ReviewDecision;
  onOpen(): void;
}) {
  const status = props.answer?.value ?? "open";
  return (
    <button
      className="flex w-full cursor-pointer items-start gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left text-sm leading-snug text-dashboard-text hover:bg-dashboard-surface-hover"
      onClick={props.onOpen}
      type="button"
    >
      {/* One line tall, so the dot sits on the first line of a long claim. */}
      <span aria-hidden="true" className="flex h-[1lh] shrink-0 items-center">
        <span className={cn("size-2 rounded-full", dotClasses[status])} />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="break-words">
          <DisplayText inline links={false} text={props.decision.claim} />
        </span>
        {/* Open is the default, so only an answer is named. */}
        {status === "open" ? (
          <span className="sr-only">Open</span>
        ) : (
          <span className="text-xs text-dashboard-text-muted">
            {statusLabels[status]}
          </span>
        )}
      </span>
    </button>
  );
}

/** Claims in reading order, grouped under the chapter that asks them. */
function chapterGroups(decisions: readonly ReviewDecision[]) {
  const groups: { chapterIndex: number; decisions: ReviewDecision[] }[] = [];
  for (const decision of decisions) {
    const last = groups.at(-1);
    if (last?.chapterIndex === decision.chapterIndex) {
      last.decisions.push(decision);
    } else {
      groups.push({
        chapterIndex: decision.chapterIndex,
        decisions: [decision],
      });
    }
  }
  return groups;
}

/** One comment for the whole review, folded away until the reviewer wants it. */
function ReviewComment(props: {
  comment: string;
  onChange(comment: string): void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing && !props.comment) {
    return (
      <Button
        className="w-fit"
        onClick={() => setEditing(true)}
        type="button"
        variant="quiet"
      >
        <Plus aria-hidden="true" className="size-4" />
        Add a comment
      </Button>
    );
  }
  return (
    <Textarea
      aria-label="Comment for the author"
      autoFocus={editing}
      className="min-h-16"
      onBlur={() => setEditing(false)}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder="Comment for the author"
      rows={2}
      value={props.comment}
    />
  );
}

/**
 * GitHub takes one review per pull request, so a stack copies one PR at a
 * time. The current chapter's PR is the default.
 */
function CopyReview(props: {
  activePr?: number;
  answers: AnswerMap;
  comment: string;
  decisions: readonly ReviewDecision[];
  layers: readonly Layer[];
}) {
  const [picked, setPicked] = useState<number>();
  const [menuOpen, setMenuOpen] = useState(false);
  // Read the stack top down, like GitHub.
  const layers = [...props.layers].reverse();
  const markdownFor = (pr: number) =>
    reviewMarkdown({
      answers: props.answers,
      comment: props.comment,
      decisions: props.decisions,
      pr,
    });
  const layer =
    layers.find((l) => l.pr === (picked ?? props.activePr)) ?? layers[0];
  if (!layer) return null;
  const markdown = markdownFor(layer.pr);
  const stacked = layers.length > 1;

  return (
    <div className="grid gap-1.5">
      {stacked ? (
        <ButtonGroup className="w-full">
          <CopyButtonFor
            className="flex-1"
            label={`Copy review for #${layer.pr}`}
            text={markdown}
          />
          <Popover onOpenChange={setMenuOpen} open={menuOpen}>
            <PopoverTrigger
              render={
                <Button aria-label="Choose a pull request" type="button">
                  <ChevronDown aria-hidden="true" className="size-4" />
                </Button>
              }
            />
            <PopoverContent
              align="end"
              className="grid w-80 gap-0.5 p-1.5"
              side="top"
            >
              {layers.map((l) => (
                <button
                  aria-current={l.pr === layer.pr ? "true" : undefined}
                  className={cn(
                    "grid w-full cursor-pointer gap-0.5 rounded-md border-0 px-2 py-1.5 text-left hover:bg-dashboard-surface-hover",
                    l.pr === layer.pr
                      ? "bg-dashboard-fill-strong"
                      : "bg-transparent",
                  )}
                  key={l.pr}
                  onClick={() => {
                    setPicked(l.pr);
                    setMenuOpen(false);
                  }}
                  type="button"
                >
                  <span className="text-sm break-words text-dashboard-text">
                    #{l.pr} {l.title}
                  </span>
                  <span className="text-xs text-dashboard-text-muted">
                    {answerCounts(props.decisions, props.answers, l.pr)}
                  </span>
                </button>
              ))}
            </PopoverContent>
          </Popover>
        </ButtonGroup>
      ) : (
        <CopyButtonFor label="Copy review" text={markdown} />
      )}
      {markdown ? (
        <p className="m-0 text-xs">
          Paste it in the review on{" "}
          <OutboundLink
            className="text-dashboard-text underline decoration-dashboard-border-heavy underline-offset-2 hover:decoration-dashboard-text"
            href={layer.url}
          >
            #{layer.pr}
          </OutboundLink>
          .
        </p>
      ) : (
        <p className="m-0 text-xs">
          Answer a claim or add a comment to copy a review.
        </p>
      )}
    </div>
  );
}

function CopyButtonFor(props: {
  className?: string;
  label: string;
  text: string;
}) {
  const copy = useCopyText({
    getText: props.text ? () => props.text : undefined,
    label: props.label,
  });
  const Icon = copy.icon;
  return (
    <Button
      className={props.className}
      disabled={copy.disabled}
      onClick={() => void copy.copy()}
      type="button"
    >
      <Icon aria-hidden="true" className="size-4" />
      {copy.label}
    </Button>
  );
}

/** What one PR's review holds, so the reviewer picks the PR with feedback. */
function answerCounts(
  decisions: readonly ReviewDecision[],
  answers: AnswerMap,
  pr: number,
): string {
  const mine = decisions.filter((d) => d.prs.includes(pr));
  const count = (value: "agree" | "change") =>
    mine.filter((d) => answers[d.id]?.value === value).length;
  const changes = count("change");
  const agreed = count("agree");
  const open = openDecisionCount(mine, answers);
  const parts = [
    changes ? `${changes} change requested` : "",
    agreed ? `${agreed} agreed` : "",
    open ? `${open} open` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No claims";
}

const COMMENT_STORAGE_PREFIX = "junior:dashboard:walkthrough-comment:";

/**
 * The comment stays in this browser. Only answers are saved on the server;
 * GitHub holds the review once it is pasted.
 */
function useCommentDraft(versionId: string) {
  const key = `${COMMENT_STORAGE_PREFIX}${versionId}`;
  const [comment, setComment] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  function update(next: string) {
    setComment(next);
    try {
      if (next) window.localStorage.setItem(key, next);
      else window.localStorage.removeItem(key);
    } catch {
      // Storage can be full or blocked. The draft still lives in the page.
    }
  }
  return [comment, update] as const;
}
