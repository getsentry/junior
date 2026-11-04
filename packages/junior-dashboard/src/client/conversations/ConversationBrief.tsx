import { ChevronDown, ChevronRight } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ActorIdentity,
  ConversationDetailReport,
} from "@sentry/junior/api/schema";

import { Detail, DetailList } from "../components/DetailList";
import { StatusChip, type StatusChipTone } from "../components/StatusChip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { formatTime } from "../format";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import { DisplayText } from "../display-text/DisplayText";

type ConversationBriefReport = NonNullable<ConversationDetailReport["brief"]>;

type BriefContent = ConversationBriefReport["content"];

const SUMMARY_PREVIEW_LINES = 4;
const SUMMARY_FADE_LINES = 1.65;

const outcomeTones: Record<BriefContent["outcome"]["status"], StatusChipTone> =
  {
    abandoned: "neutral",
    answered: "info",
    blocked: "danger",
    done: "success",
    in_progress: "accent",
    partial: "warning",
  };

/** Show a summary in details, or the durable Brief when a transcript expires. */
export function ConversationBrief(props: {
  brief: ConversationBriefReport;
  variant?: "summary" | "full";
}) {
  const { content } = props.brief;
  const mentions = props.brief.mentions;
  if (props.variant === "summary") {
    return (
      <div className="grid min-w-0 gap-4">
        <BriefSummary>
          <DisplayText mentions={mentions} text={content.summary} />
        </BriefSummary>
        {content.openDecisions.length > 0 ? (
          <div className="grid gap-2">
            <h4 className="m-0 text-sm font-medium text-dashboard-text">
              Open decisions
            </h4>
            <BriefOpenDecisions
              decisions={content.openDecisions}
              mentions={mentions}
            />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusChip tone={outcomeTones[content.outcome.status]}>
          {displayLabel(content.outcome.status)}
        </StatusChip>
        <span className="text-xs text-dashboard-text-muted">
          Brief v{props.brief.version} · updated{" "}
          {formatTime(props.brief.updatedAt, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
      </div>
      <DisplayText mentions={mentions} text={content.summary} />
      <BriefSection title="Intent & outcome">
        <DetailList>
          <Detail label="Intent">
            <DisplayText mentions={mentions} text={content.intent} />
          </Detail>
          <Detail label="Outcome">
            <DisplayText mentions={mentions} text={content.outcome.text} />
          </Detail>
        </DetailList>
      </BriefSection>
      {content.decisions.length || content.openDecisions.length ? (
        <BriefSection title="Decisions">
          <DetailList>
            {content.decisions.length ? (
              <Detail label="Decisions">
                <BriefDecisions
                  decisions={content.decisions}
                  mentions={mentions}
                />
              </Detail>
            ) : null}
            {content.openDecisions.length ? (
              <Detail label="Open decisions">
                <BriefOpenDecisions
                  decisions={content.openDecisions}
                  mentions={mentions}
                />
              </Detail>
            ) : null}
          </DetailList>
        </BriefSection>
      ) : null}
      {content.facts.length ||
      content.links.length ||
      content.keywords.length ? (
        <BriefSection title="Facts, links & keywords">
          <DetailList>
            {content.facts.length ? (
              <Detail label="Facts">
                <BriefList items={content.facts} mentions={mentions} />
              </Detail>
            ) : null}
            {content.links.length ? (
              <Detail label="Links">
                <ul className="m-0 grid list-none gap-2 p-0">
                  {content.links.map((link) => (
                    <li
                      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
                      key={`${link.kind}:${link.url}`}
                    >
                      <a
                        className="min-w-0 break-all font-medium text-dashboard-accent-text underline decoration-dashboard-accent/30 underline-offset-2 hover:text-dashboard-accent-text"
                        href={link.url}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {link.label}
                      </a>
                      <span className="text-xs text-dashboard-text-muted">
                        {displayLabel(link.kind)}
                      </span>
                      {link.status ? (
                        <StatusChip
                          size="compact"
                          tone={linkStatusTone(link.status)}
                        >
                          {link.status}
                        </StatusChip>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Detail>
            ) : null}
            {content.keywords.length ? (
              <Detail label="Keywords">
                <div className="flex flex-wrap gap-1.5">
                  {content.keywords.map((keyword) => (
                    <StatusChip key={keyword} size="compact">
                      {keyword}
                    </StatusChip>
                  ))}
                </div>
              </Detail>
            ) : null}
          </DetailList>
        </BriefSection>
      ) : null}
    </div>
  );
}

function BriefSummary(props: { children: ReactNode }) {
  const id = useId();
  const previewRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapsed = hasMore && !expanded;

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const content = contentRef.current;
    if (!preview || !content) return;

    const measure = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(preview).lineHeight,
      );
      const height = lineHeight * SUMMARY_PREVIEW_LINES;
      const overflows = content.getBoundingClientRect().height > height + 0.5;
      const focused = document.activeElement;
      if (
        overflows &&
        focused &&
        content.contains(focused) &&
        focused.getBoundingClientRect().bottom >
          preview.getBoundingClientRect().top +
            height -
            lineHeight * SUMMARY_FADE_LINES
      ) {
        setExpanded(true);
      } else if (!overflows && focused && focused === toggleRef.current) {
        preview.focus({ preventScroll: true });
      }
      setHasMore(overflows);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const toggle = toggleRef.current;
    if (!expanded && toggle && document.activeElement === toggle) {
      toggle.scrollIntoView({ block: "nearest" });
    }
  }, [expanded]);

  return (
    <div className="relative min-w-0">
      <div
        className={cn("leading-6 md:leading-7", collapsed && "overflow-clip")}
        id={id}
        onFocusCapture={(event) => {
          if (!collapsed) return;
          // Keep focused links clear of both the clipping and the fade.
          const preview = event.currentTarget;
          const lineHeight = Number.parseFloat(
            getComputedStyle(preview).lineHeight,
          );
          if (
            event.target.getBoundingClientRect().bottom >
            preview.getBoundingClientRect().bottom -
              lineHeight * SUMMARY_FADE_LINES
          ) {
            setExpanded(true);
          }
        }}
        ref={previewRef}
        style={
          collapsed
            ? {
                maskImage: `linear-gradient(black calc(100% - ${SUMMARY_FADE_LINES}lh), transparent)`,
                maxHeight: `${SUMMARY_PREVIEW_LINES}lh`,
              }
            : undefined
        }
        tabIndex={-1}
      >
        <div ref={contentRef}>{props.children}</div>
      </div>
      {hasMore ? (
        <button
          aria-controls={id}
          aria-expanded={expanded}
          aria-label={
            expanded ? "Collapse Brief summary" : "Expand Brief summary"
          }
          className={cn(
            "group flex h-6 w-8 cursor-pointer items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-dashboard-focus",
            collapsed
              ? "absolute bottom-0 left-1/2 -translate-x-1/2"
              : "mx-auto mt-1",
          )}
          onClick={() => setExpanded((open) => !open)}
          ref={toggleRef}
          type="button"
        >
          <span
            aria-hidden="true"
            className="grid size-5 place-items-center rounded-full border border-dashboard-border bg-dashboard-ink text-dashboard-text-solid transition-[filter] group-hover:brightness-95 dark:bg-dashboard-text-solid dark:text-dashboard-text-inverse"
          >
            <ChevronDown
              className="size-4 group-aria-expanded:rotate-180"
              strokeWidth={2.25}
            />
          </span>
        </button>
      ) : null}
    </div>
  );
}

function BriefSection(props: { children: ReactNode; title: string }) {
  return (
    <Collapsible className="min-w-0 border-t border-dashboard-border pt-3">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 text-left text-sm font-medium text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            dashboardDisclosureChevronClass,
            "text-dashboard-text-muted",
          )}
        />
        {props.title}
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div className="mt-3">{props.children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function BriefDecisions(props: {
  decisions: BriefContent["decisions"];
  mentions?: readonly ActorIdentity[];
}) {
  return (
    <ul className="m-0 grid list-none gap-2.5 p-0">
      {props.decisions.map((decision, index) => (
        <li key={`${decision.text}:${index}`}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusChip
              size="compact"
              tone={decision.kind === "assumed" ? "warning" : "info"}
            >
              {decision.kind}
            </StatusChip>
            <span className="min-w-0">
              <DisplayText
                inline
                mentions={props.mentions}
                text={decision.text}
              />
            </span>
          </div>
          {decision.by ? (
            <div className="mt-0.5 text-xs text-dashboard-text-muted">
              by ·{" "}
              <DisplayText
                inline
                mentions={props.mentions}
                text={decision.by}
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function BriefOpenDecisions(props: {
  decisions: BriefContent["openDecisions"];
  mentions?: readonly ActorIdentity[];
}) {
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {props.decisions.map((decision, index) => (
        <li key={`${decision.text}:${index}`}>
          <div>
            <DisplayText
              inline
              mentions={props.mentions}
              text={decision.text}
            />
          </div>
          {decision.owner ? (
            <div className="mt-1 text-xs text-dashboard-text-muted">
              Owner:{" "}
              <DisplayText
                inline
                mentions={props.mentions}
                text={decision.owner}
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function BriefList(props: {
  items: string[];
  mentions?: readonly ActorIdentity[];
}) {
  return (
    <ul className="my-0 grid gap-1.5 pl-4">
      {props.items.map((item, index) => (
        <li key={`${item}:${index}`}>
          <DisplayText inline mentions={props.mentions} text={item} />
        </li>
      ))}
    </ul>
  );
}

function displayLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function linkStatusTone(status: string): StatusChipTone {
  if (status === "merged" || status === "done") return "success";
  if (status === "closed" || status === "blocked") return "danger";
  if (status === "open" || status === "in_progress") return "accent";
  return "neutral";
}
