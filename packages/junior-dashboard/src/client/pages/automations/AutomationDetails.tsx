import type { AutomationSummary } from "@sentry/junior/api/schema";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";

import { Button } from "../../components/Button";
import { Detail, DetailList } from "../../components/DetailList";
import { DetailsPanel } from "../../components/DetailsPanel";
import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import {
  timeRangeLabel,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { TranscriptText } from "../../conversations/TranscriptText";
import { peoplePath } from "../../format";
import { dashboardInlineLinkClass } from "../../styles";
import { AutomationLifecycle } from "./AutomationLifecycle";
import { AutomationRecentRuns } from "./AutomationRecentRuns";
import { AutomationStatus } from "./AutomationStatus";
import {
  automationEventConditions,
  automationEventNames,
  automationScheduleLabel,
  formatAutomationRunTime,
} from "./automationFormat";
import { automationOutcomeLabel } from "./automationOutcomes";

/** Keep Automation context scrollable above persistent, permission-aware actions. */
export function AutomationDetails(props: {
  onClose(): void;
  onRetry(): void;
  error: boolean;
  range: TimeRangeDays;
  automation: AutomationSummary | undefined;
}) {
  const location = useLocation();
  const { automation } = props;
  return (
    <DetailsPanel
      label="Automation details"
      onClose={props.onClose}
      title={
        <h2 className="m-0 break-words font-display text-base font-medium text-dashboard-text">
          {automation?.title ?? "Automation details"}
        </h2>
      }
    >
      <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
        <div
          aria-label="Automation content"
          role="region"
          tabIndex={0}
          className="min-h-0 overflow-y-auto overscroll-contain p-4 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus [overflow-wrap:anywhere]"
        >
          {automation ? (
            <>
              <h2 className="m-0 mb-4 break-words font-display text-base font-medium text-dashboard-text xl:hidden">
                {automation.title}
              </h2>
              <AutomationDetailsContent
                automation={automation}
                range={props.range}
              />
            </>
          ) : null}
          {props.error ? (
            <InlineError>
              Automation details could not be loaded. It may be unavailable or
              you may not have access.{" "}
              <Button onClick={props.onRetry}>Try again</Button>
            </InlineError>
          ) : !automation ? (
            <PageContentSkeleton
              label="Loading automation details"
              variant="panel"
            />
          ) : null}
        </div>
        {automation ? (
          <AutomationLifecycle
            automation={automation}
            editPath={`/automations/${encodeURIComponent(automation.id)}/edit${location.search}`}
          />
        ) : null}
      </div>
    </DetailsPanel>
  );
}

function AutomationDetailsContent({
  automation,
  range,
}: {
  automation: AutomationSummary;
  range: TimeRangeDays;
}) {
  const location = useLocation();
  const conditions =
    automation.kind === "event" ? automationEventConditions(automation) : "";
  return (
    <div className="grid min-w-0 gap-5">
      <AutomationStatus automation={automation} />
      <AutomationDetailSection title="Trigger">
        {automation.kind === "scheduled" ? (
          <p className="m-0">{automationScheduleLabel(automation)}</p>
        ) : (
          <>
            <p className="m-0 break-words">{automation.resource}</p>
            <p className="m-0 mt-1 text-dashboard-text-muted">
              {automationEventNames(automation)}
            </p>
            {conditions ? (
              <p className="m-0 mt-1 break-words text-xs text-dashboard-text-muted">
                {conditions}
              </p>
            ) : null}
          </>
        )}
      </AutomationDetailSection>
      <AutomationDetailSection title="Instructions">
        <TranscriptText
          mentions={automation.mentions ?? []}
          text={automation.instruction}
        />
      </AutomationDetailSection>
      <AutomationDetailSection title="Outcome">
        {automation.outcomes.length === 0 ? (
          <p className="m-0 text-dashboard-text-muted">No message on success</p>
        ) : (
          <ol className="m-0 grid list-none gap-2 p-0">
            {automation.outcomes.map((outcome, index) => (
              <li key={index}>
                On success, message{" "}
                {automationOutcomeLabel(outcome, automation.destination)}
              </li>
            ))}
          </ol>
        )}
      </AutomationDetailSection>
      <AutomationRecentRuns automation={automation} />
      <details className="border-t border-dashboard-border pt-3">
        <summary className="w-fit cursor-pointer rounded-sm py-1 text-xs text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus">
          About this Automation
        </summary>
        <DetailList className="mt-3">
          <Detail label="Created by">
            {automation.createdByEmail ? (
              <Link
                className={dashboardInlineLinkClass}
                to={peoplePath(automation.createdByEmail)}
              >
                {automation.ownedByViewer ? "you" : automation.createdBy}
              </Link>
            ) : automation.ownedByViewer ? (
              "you"
            ) : (
              automation.createdBy
            )}
          </Detail>
          <Detail label="Created">
            {formatAutomationRunTime(automation.createdAt)}
          </Detail>
          <Detail label="Connected accounts">
            {automation.credentialMode === "creator"
              ? `Uses accounts connected by ${automation.ownedByViewer ? "you" : automation.createdBy}.`
              : "Junior’s accounts only"}
          </Detail>
          <Detail label="Run counts">
            {automation.runs[range]} runs / {timeRangeLabel(range)} ·{" "}
            {automation.totalRuns} total
          </Detail>
        </DetailList>
        <Link
          className={`${dashboardInlineLinkClass} mt-3 inline-block py-2 text-xs`}
          to={`/automations/${encodeURIComponent(automation.id)}/versions${location.search}`}
        >
          Version history
        </Link>
      </details>
    </div>
  );
}

function AutomationDetailSection(props: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-2 text-sm leading-relaxed">
      <h3 className="m-0 text-xs font-medium text-dashboard-text-muted">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}
