import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { Detail, DetailList } from "../components/DetailList";
import { StatusChip, type StatusChipTone } from "../components/StatusChip";
import { formatTime } from "../format";

type ConversationBriefReport = NonNullable<
  ConversationDetailReport["brief"]
>;

type BriefContent = ConversationBriefReport["content"];

const outcomeTones: Record<BriefContent["outcome"]["status"], StatusChipTone> =
  {
    abandoned: "neutral",
    answered: "info",
    blocked: "danger",
    done: "success",
    in_progress: "accent",
    partial: "warning",
  };

/** Render a Conversation's durable Brief content. */
export function ConversationBrief(props: { brief: ConversationBriefReport }) {
  const { content } = props.brief;
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusChip tone={outcomeTones[content.outcome.status]}>
          {displayLabel(content.outcome.status)}
        </StatusChip>
        <span className="font-mono text-xs text-dashboard-text-muted">
          Brief v{props.brief.version} · updated{" "}
          {formatTime(props.brief.updatedAt, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
      </div>
      <p className="m-0 text-sm leading-relaxed text-dashboard-text">
        {content.summary}
      </p>
      <DetailList>
        <Detail label="Intent">{content.intent}</Detail>
        <Detail label="Outcome">{content.outcome.text}</Detail>
        {content.decisions.length ? (
          <Detail label="Decisions">
            <BriefDecisions decisions={content.decisions} />
          </Detail>
        ) : null}
        {content.openDecisions.length ? (
          <Detail label="Open decisions">
            <ul className="m-0 grid list-none gap-2 p-0">
              {content.openDecisions.map((decision, index) => (
                <li key={`${decision.text}:${index}`}>
                  <div>{decision.text}</div>
                  {decision.owner ? (
                    <div className="mt-0.5 font-mono text-xs text-dashboard-text-muted">
                      owner · {decision.owner}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </Detail>
        ) : null}
        {content.facts.length ? (
          <Detail label="Facts">
            <BriefList items={content.facts} />
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
                    className="min-w-0 break-all font-medium text-cyan-200 underline decoration-cyan-300/30 underline-offset-2 hover:text-cyan-100"
                    href={link.url}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {link.label}
                  </a>
                  <span className="font-mono text-xs text-dashboard-text-muted">
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
    </div>
  );
}

function BriefDecisions(props: { decisions: BriefContent["decisions"] }) {
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
            <span className="min-w-0">{decision.text}</span>
          </div>
          {decision.by ? (
            <div className="mt-0.5 font-mono text-xs text-dashboard-text-muted">
              by · {decision.by}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function BriefList(props: { items: string[] }) {
  return (
    <ul className="my-0 grid gap-1.5 pl-4">
      {props.items.map((item, index) => (
        <li key={`${item}:${index}`}>{item}</li>
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
