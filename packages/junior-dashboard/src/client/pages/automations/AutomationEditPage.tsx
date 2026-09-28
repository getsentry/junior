import { Link, useLocation, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  automationEditSchema,
  type AutomationSummary,
} from "@sentry/junior/api/schema";
import { useAutomationData } from "../../api";
import { fetchDashboardJson } from "../../http";
import { Button } from "../../components/Button";
import { FormNotice } from "../../components/FormNotice";
import { StatusChip } from "../../components/StatusChip";
import { AutomationsNavigation } from "./AutomationsPageLayout";
import { AutomationEditor } from "./AutomationEditor";
import { AutomationEditorLoading } from "./AutomationEditorLoading";
import { AutomationFormSection } from "./AutomationFormSection";
import { automationOutcomeLabel } from "./automationOutcomes";

/** Load a linkable editor, with readable public values for non-creators. */
export function AutomationEditPage(props: { enabled: boolean }) {
  const { kind, automationId } = useParams();
  const location = useLocation();
  const summary = useAutomationData(props.enabled, automationId);
  const canEdit =
    summary.data?.ownedByViewer &&
    !(summary.data.kind === "scheduled" && summary.data.status === "completed");
  const edit = useQuery({
    queryKey: ["dashboard", "automations", "edit", kind, automationId],
    enabled: props.enabled && Boolean(canEdit) && summary.data?.kind === kind,
    retry: false,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        automationEditSchema,
        `/api/automations/${kind}/${encodeURIComponent(automationId!)}/edit`,
        signal,
      ),
  });
  const returnPath = `/automations/list${location.search}`;
  const value = summary.data;
  const status =
    value?.kind === "event"
      ? value.status === "paused"
        ? "paused"
        : value.triggerAvailable
          ? "active"
          : "unavailable"
      : value?.status;
  const statusTone =
    status === "active"
      ? "success"
      : status === "blocked" || status === "unavailable"
        ? "warning"
        : "neutral";
  return (
    <>
      <AutomationsNavigation />
      <div className="mx-auto w-full min-w-0 max-w-5xl px-5 pt-7 sm:px-8 sm:pt-9">
        <Link
          to={returnPath}
          className="inline-flex min-h-8 items-center gap-2 text-sm text-dashboard-text-muted no-underline hover:text-dashboard-text"
        >
          <ArrowLeft aria-hidden size={15} />
          All automations
        </Link>
        <div className="mt-4 mb-8 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="m-0 break-words font-display text-3xl font-light tracking-tight">
              {value && !canEdit ? value.title : "Edit automation"}
            </h1>
            {value ? (
              <p className="mt-2 mb-0 text-sm text-dashboard-text-muted">
                Created by {value.ownedByViewer ? "you" : value.createdBy} ·{" "}
                {value.destination.label}
              </p>
            ) : null}
          </div>
          {value ? (
            <StatusChip tone={statusTone}>
              {status === "unavailable" ? "Trigger unavailable" : status}
            </StatusChip>
          ) : null}
        </div>
        {(!value && summary.error) ||
        (!edit.data && edit.error) ||
        (value && value.kind !== kind) ? (
          <FormNotice tone="error" title="Automation could not be loaded.">
            It may no longer be available, or you may not have access.{" "}
            <Button
              onClick={() => {
                void summary.refetch();
                if (canEdit) void edit.refetch();
              }}
            >
              Try again
            </Button>
          </FormNotice>
        ) : !value || (canEdit && !edit.data) ? (
          <AutomationEditorLoading />
        ) : canEdit && edit.data ? (
          <AutomationEditor
            key={`${kind}:${automationId}`}
            automation={edit.data}
            summary={value}
            returnPath={returnPath}
          />
        ) : (
          <AutomationReadOnly automation={value} />
        )}
      </div>
    </>
  );
}

function AutomationReadOnly({ automation }: { automation: AutomationSummary }) {
  return (
    <>
      <p className="mb-6 text-sm text-dashboard-text-muted">
        {automation.ownedByViewer
          ? "This automation has completed and cannot be edited. It will not run again."
          : `Only ${automation.createdBy} can edit this automation.`}
      </p>
      <AutomationFormSection title="What to do" detail="The saved instruction.">
        <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">
          {automation.instruction}
        </p>
      </AutomationFormSection>
      <AutomationFormSection title="When to run" detail="The saved trigger.">
        {automation.kind === "scheduled" ? (
          <p className="m-0 text-sm">
            {automation.schedule} · {automation.timezone}
          </p>
        ) : (
          <div className="grid gap-3 text-sm">
            <p className="m-0 break-words">{automation.resource}</p>
            <p className="m-0 break-words">{automation.events.join(", ")}</p>
            {automation.match ? (
              <pre className="whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(automation.match, null, 2)}
              </pre>
            ) : null}
          </div>
        )}
      </AutomationFormSection>
      <AutomationFormSection
        title="Where results go"
        detail="Messages after successful work."
      >
        {automation.outcomes.length ? (
          <ol className="m-0 grid gap-2 pl-5 text-sm">
            {automation.outcomes.map((outcome, index) => (
              <li key={index}>
                {automationOutcomeLabel(outcome, automation.destination)}
              </li>
            ))}
          </ol>
        ) : (
          <p className="m-0 text-sm">No success message</p>
        )}
      </AutomationFormSection>
      <AutomationFormSection
        title="Credentials"
        detail="The accounts Junior can use."
      >
        <p className="m-0 text-sm">
          {automation.credentialMode === "creator"
            ? `Uses ${automation.ownedByViewer ? "your" : `${automation.createdBy}’s`} connected accounts.`
            : "System credentials only."}
        </p>
      </AutomationFormSection>
    </>
  );
}
