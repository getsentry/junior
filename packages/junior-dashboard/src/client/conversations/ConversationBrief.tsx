import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type {
  ActorIdentity,
  ConversationDetailReport,
} from "@sentry/junior/api/schema";

import { ClampedPreview } from "../components/ClampedPreview";
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
import { OutboundLink } from "../components/OutboundLink";

type ConversationBriefReport = NonNullable<ConversationDetailReport["brief"]>;

type BriefContent = ConversationBriefReport["content"];

const SUMMARY_PREVIEW_LINES = 4;

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
      <ClampedPreview
        className="leading-6"
        label="Brief summary"
        lines={SUMMARY_PREVIEW_LINES}
      >
        <DisplayText compact mentions={mentions} text={content.summary} />
      </ClampedPreview>
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
      {content.decisions.length ? (
        <BriefSection title="Decisions">
          <BriefDecisions decisions={content.decisions} mentions={mentions} />
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
                      <OutboundLink
                        className="min-w-0 break-all font-medium text-dashboard-accent-text underline decoration-dashboard-accent/30 underline-offset-2 hover:text-dashboard-accent-text"
                        href={link.url}
                      >
                        {link.label}
                      </OutboundLink>
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
