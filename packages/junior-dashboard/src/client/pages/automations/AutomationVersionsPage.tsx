/** Version history for one Automation. Making a version active saves it again. */
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  automationEditSchema,
  type AutomationSummary,
  type AutomationVersion,
  type AutomationVersionList,
} from "@sentry/junior/api/schema";
import { useAutomationData, useAutomationVersionsData } from "../../api";
import { Button } from "../../components/Button";
import { Detail, DetailList } from "../../components/DetailList";
import { FormNotice } from "../../components/FormNotice";
import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { StatusChip } from "../../components/StatusChip";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { automationPath } from "../../format";
import { DashboardApiError, fetchDashboardJson, post } from "../../http";
import { pathWithSearch } from "../../searchParams";
import { formatAutomationRunTime } from "./automationFormat";
import { automationOutcomeLabel } from "./automationOutcomes";

const DESCRIPTION = "Saved settings for this automation, newest first.";

/** Load one Automation's versions with its summary for labels and access. */
export function AutomationVersionsPage(props: { enabled: boolean }) {
  const { automationId, kind } = useParams();
  const [searchParams] = useSearchParams();
  const taskKind = kind === "scheduled" || kind === "event" ? kind : undefined;
  const enabled = props.enabled && Boolean(automationId && taskKind);
  const summary = useAutomationData(enabled, automationId);
  const versions = useAutomationVersionsData(enabled, taskKind, automationId);
  if (!automationId || !taskKind) {
    return <Navigate replace to="/automations" />;
  }
  const backTo = pathWithSearch(automationPath(automationId), searchParams);
  const error = summary.error ?? versions.error;
  if (error || (summary.data && summary.data.kind !== taskKind)) {
    return (
      <>
        <PageHeader description={DESCRIPTION} title="Version history" />
        <Card padding="md">
          <InlineError>
            {error instanceof DashboardApiError && error.status === 404
              ? "This automation was not found or is not visible to you."
              : summary.data && summary.data.kind !== taskKind
                ? "This automation was not found or is not visible to you."
                : "Version history could not be loaded. Try again."}
          </InlineError>
          <BackLink to={backTo} />
        </Card>
      </>
    );
  }
  if (!summary.data || !versions.data) {
    return (
      <>
        <PageHeader description={DESCRIPTION} title="Version history" />
        <PageContentSkeleton label="Loading version history" variant="list" />
      </>
    );
  }
  return (
    <AutomationVersionsView
      automation={summary.data}
      backTo={backTo}
      data={versions.data}
    />
  );
}

function BackLink(props: { to: string }) {
  return (
    <Link
      className="mb-3 inline-flex items-center gap-2 font-mono text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text"
      to={props.to}
    >
      <ArrowLeft aria-hidden="true" size={14} />
      Back to automation
    </Link>
  );
}

function AutomationVersionsView(props: {
  automation: AutomationSummary;
  backTo: string;
  data: AutomationVersionList;
}) {
  const { automation, data } = props;
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<number>();
  const [activated, setActivated] = useState<number>();
  const canActivate = !(
    automation.kind === "scheduled" && automation.status === "completed"
  );
  const path = `/api/automations/${automation.kind}/${encodeURIComponent(automation.id)}`;
  const activate = useMutation({
    mutationFn: async (version: number) => {
      // The user chose an exact saved version, so the latest revision is safe here.
      const current = await fetchDashboardJson(
        automationEditSchema,
        `${path}/edit`,
      );
      return post(
        automationEditSchema,
        `${path}/versions/${version}/activate`,
        {
          revision: current.revision,
        },
      );
    },
    onMutate: () => setActivated(undefined),
    onSuccess: async (_, version) => {
      setConfirming(undefined);
      setActivated(version);
      await queryClient.invalidateQueries({
        queryKey: ["dashboard", "automations"],
      });
    },
  });
  return (
    <>
      <div>
        <BackLink to={props.backTo} />
        <PageHeader
          description={`${automation.kind} automation · ${automation.destination.label} · ${data.versions.length} ${data.versions.length === 1 ? "version" : "versions"}`}
          title={automation.title}
        />
      </div>
      <p className="m-0 max-w-2xl text-sm leading-relaxed text-dashboard-text-muted">
        {canActivate
          ? "Making a version active saves its settings as a new version. Earlier versions stay in this list. It does not run the automation."
          : "This automation has completed. Its versions are read-only."}
      </p>
      {activated !== undefined ? (
        <p
          role="status"
          className="m-0 text-sm text-emerald-300"
        >{`Version ${activated} is active again. It was saved as a new version.`}</p>
      ) : null}
      {data.versions.length === 0 ? (
        <Card padding="md">
          <p className="m-0 text-sm text-dashboard-text-muted">
            No versions are saved yet. Junior saves a version each time the
            settings change.
          </p>
        </Card>
      ) : (
        <Card>
          <ol className="m-0 list-none divide-y divide-dashboard-border-subtle p-0">
            {data.versions.map((version, index) => (
              <VersionRow
                key={version.version}
                active={version.version === data.activeVersion}
                automation={automation}
                canActivate={canActivate}
                confirming={confirming === version.version}
                error={
                  activate.variables === version.version ? activate.error : null
                }
                onCancel={() => setConfirming(undefined)}
                onConfirm={() => activate.mutate(version.version)}
                onRequest={() => {
                  activate.reset();
                  setConfirming(version.version);
                }}
                pending={
                  activate.isPending && activate.variables === version.version
                }
                previous={data.versions[index + 1]}
                truncated={data.truncated}
                version={version}
              />
            ))}
          </ol>
        </Card>
      )}
      {data.truncated ? (
        <p className="m-0 text-center text-xs text-dashboard-text-muted">
          Showing the 100 most recent versions.
        </p>
      ) : null}
    </>
  );
}

function VersionRow(props: {
  active: boolean;
  automation: AutomationSummary;
  canActivate: boolean;
  confirming: boolean;
  error: Error | null;
  onCancel(): void;
  onConfirm(): void;
  onRequest(): void;
  pending: boolean;
  previous: AutomationVersion | undefined;
  truncated: boolean;
  version: AutomationVersion;
}) {
  const { automation, version } = props;
  const editor = version.editedBy
    ? (version.editedBy.fullName ??
      version.editedBy.userName ??
      version.editedBy.slackUserId)
    : "Editor unknown";
  const changes = props.previous
    ? changedFields(props.previous, version)
    : undefined;
  const changeText = changes
    ? changes.length
      ? `Changed ${changes.join(", ")}`
      : "No setting changes"
    : version.version === 1 || !props.truncated
      ? "First saved version"
      : undefined;
  const titleId = `automation-version-${version.version}`;
  return (
    <li aria-labelledby={titleId} className="grid gap-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h3 id={titleId} className="m-0 text-sm font-medium">
              Version {version.version}
            </h3>
            {props.active ? (
              <StatusChip size="compact" tone="success">
                Active
              </StatusChip>
            ) : null}
          </div>
          <p className="mt-1 mb-0 text-xs text-dashboard-text-muted">
            {editor} · {formatAutomationRunTime(version.createdAt)}
          </p>
          {changeText ? (
            <p className="mt-1 mb-0 text-xs text-dashboard-text-muted">
              {changeText}
            </p>
          ) : null}
        </div>
        {props.canActivate && !props.active && !props.confirming ? (
          <Button
            aria-label={`Make version ${version.version} active`}
            onClick={props.onRequest}
          >
            Make active
          </Button>
        ) : null}
      </div>
      {props.confirming ? (
        <FormNotice title={`Make version ${version.version} active?`}>
          <p className="mt-0">
            Junior saves these settings as a new version. Future runs use them.
            {automation.ownedByViewer
              ? ""
              : ` Only ${automation.createdBy} can turn on their connected accounts or change where results go.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              tone="primary"
              disabled={props.pending}
              onClick={props.onConfirm}
            >
              {props.pending ? "Saving…" : "Make active"}
            </Button>
            <Button disabled={props.pending} onClick={props.onCancel}>
              Cancel
            </Button>
          </div>
        </FormNotice>
      ) : null}
      {props.error ? (
        <FormNotice tone="error" title="This version could not be made active.">
          {props.error instanceof DashboardApiError
            ? props.error.code === "conflict"
              ? "The automation changed. Try again."
              : (props.error.apiError ?? "Try again.")
            : "Try again."}
        </FormNotice>
      ) : null}
      <details>
        <summary className="w-fit cursor-pointer py-1 text-xs text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline focus-visible:outline-dashboard-focus">
          Show settings
        </summary>
        <VersionSettings automation={automation} version={version} />
      </details>
    </li>
  );
}

function VersionSettings(props: {
  automation: AutomationSummary;
  version: AutomationVersion;
}) {
  const { automation, version } = props;
  const { definition } = version;
  const destination =
    definition.destination.channelId === automation.destination.channelId &&
    definition.destination.teamId === automation.destination.teamId
      ? automation.destination.label
      : `Another destination · ${definition.destination.channelId}`;
  return (
    <DetailList className="mt-2">
      <Detail label="Title">
        {definition.title ?? "First line of the instruction"}
      </Detail>
      <Detail label="What to do" valueClassName="whitespace-pre-wrap">
        {definition.instruction}
      </Detail>
      <Detail label="When to run">
        {version.kind === "scheduled" ? (
          version.definition.schedule.description.includes(
            version.definition.schedule.timezone,
          ) ? (
            version.definition.schedule.description
          ) : (
            `${version.definition.schedule.description} (${version.definition.schedule.timezone})`
          )
        ) : (
          <>
            {version.definition.trigger.label} ·{" "}
            {version.definition.trigger.identifier}
            <br />
            {version.definition.trigger.events.join(", ")}
            {Object.keys(version.definition.trigger.match ?? {}).length ? (
              <pre className="mt-2 mb-0 whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(version.definition.trigger.match, null, 2)}
              </pre>
            ) : null}
          </>
        )}
      </Detail>
      <Detail label="Destination">{destination}</Detail>
      <Detail label="On success">
        {definition.outcomes.length ? (
          <ol className="m-0 pl-4">
            {definition.outcomes.map((outcome, index) => (
              <li key={index}>
                {automationOutcomeLabel(outcome, automation.destination)}
              </li>
            ))}
          </ol>
        ) : (
          "No message on success"
        )}
      </Detail>
      <Detail label="Connected accounts">
        {definition.credentialMode === "creator"
          ? `Uses accounts connected by ${automation.ownedByViewer ? "you" : automation.createdBy}.`
          : "Junior’s accounts only"}
      </Detail>
    </DetailList>
  );
}

/** Name the settings that differ from the previous version. */
function changedFields(
  previous: AutomationVersion,
  version: AutomationVersion,
): string[] {
  const before: Record<string, unknown> = previous.definition;
  const after: Record<string, unknown> = version.definition;
  return (
    [
      ["title", "title"],
      ["instruction", "instruction"],
      ["schedule", "schedule"],
      ["trigger", "trigger"],
      ["destination", "destination"],
      ["outcomes", "success messages"],
      ["credentialMode", "connected accounts"],
    ] as const
  ).flatMap(([key, label]) =>
    JSON.stringify(before[key]) === JSON.stringify(after[key]) ? [] : [label],
  );
}
