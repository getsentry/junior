/**
 * Version history for one Automation. The list selects a version, and the
 * compare view shows what it changed from the version before it. Making a
 * version active saves it again as a new version.
 */
import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  automationEditSchema,
  type AutomationSummary,
  type AutomationVersionList,
  type ListedAutomationVersion,
} from "@sentry/junior/api/schema";

import { useAutomationVersionsData } from "../../api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { FormNotice } from "../../components/FormNotice";
import { InlineError } from "../../components/InlineError";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { StatusChip } from "../../components/StatusChip";
import { Card } from "../../components/layout/Card";
import { formatRelativeTime } from "../../format";
import { DashboardApiError, fetchDashboardJson, post } from "../../http";
import { cn } from "../../styles";
import { formatAutomationRunTime } from "./automationFormat";
import { automationOutcomeLabel } from "./automationOutcomes";
import { TriggerFilters } from "./TriggerFilters";

/** Search param that selects the version to compare. */
export const AUTOMATION_VERSION_PARAM = "version";

/** Load one Automation's versions and compare the selected one. */
export function AutomationVersionsTab(props: {
  automation: AutomationSummary;
}) {
  const versions = useAutomationVersionsData(true, props.automation.id);
  if (versions.error) {
    return (
      <InlineError>
        Version history could not be loaded.{" "}
        <Button onClick={() => void versions.refetch()}>Try again</Button>
      </InlineError>
    );
  }
  if (!versions.data) {
    return (
      <PageContentSkeleton label="Loading version history" variant="list" />
    );
  }
  return (
    <AutomationVersionsView
      automation={props.automation}
      data={versions.data}
    />
  );
}

function AutomationVersionsView(props: {
  automation: AutomationSummary;
  data: AutomationVersionList;
}) {
  const { automation, data } = props;
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [activated, setActivated] = useState<number>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canActivate = automation.status !== "completed";
  const requested = Number(searchParams.get(AUTOMATION_VERSION_PARAM));
  const selectedIndex = Math.max(
    0,
    data.versions.findIndex((version) => version.version === requested),
  );
  const selected = data.versions[selectedIndex];
  const previous = data.versions[selectedIndex + 1];
  const select = (version: number) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(AUTOMATION_VERSION_PARAM, String(version));
        return next;
      },
      { replace: true },
    );
  const path = `/api/automations/${encodeURIComponent(automation.id)}`;
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
        { revision: current.revision },
      );
    },
    onMutate: () => setActivated(undefined),
    onSuccess: async (_, version) => {
      setActivated(version);
      await queryClient.invalidateQueries({
        queryKey: ["dashboard", "automations"],
      });
    },
  });
  if (!selected) {
    return (
      <Card padding="md">
        <p className="m-0 text-sm text-dashboard-text-muted">
          No versions are saved yet. Junior saves a version each time the
          settings change.
        </p>
      </Card>
    );
  }
  const active = selected.version === data.activeVersion;
  return (
    <>
      <p className="m-0 max-w-2xl text-sm leading-relaxed text-dashboard-text-muted">
        {canActivate
          ? "Each save creates a version. Making a version active saves its settings as a new version. It does not run the automation."
          : "This automation has completed. Its versions are read-only."}
      </p>
      {activated !== undefined ? (
        <p role="status" className="m-0 text-sm text-emerald-300">
          Version {activated} is active again. It was saved as a new version.
        </p>
      ) : null}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-6">
        <nav aria-label="Versions" className="min-w-0">
          <ol className="m-0 grid list-none gap-1 p-0 max-lg:max-h-64 max-lg:overflow-y-auto">
            {data.versions.map((version, index) => (
              <li key={version.version}>
                <VersionListItem
                  active={version.version === data.activeVersion}
                  changes={versionChangeText(
                    version,
                    data.versions[index + 1],
                    data.truncated,
                  )}
                  onSelect={() => select(version.version)}
                  selected={version.version === selected.version}
                  version={version}
                />
              </li>
            ))}
          </ol>
          {data.truncated ? (
            <p className="m-0 mt-2 px-3 text-xs text-dashboard-text-muted">
              Showing the 100 most recent versions.
            </p>
          ) : null}
        </nav>
        <Card as="section" className="min-w-0" padding="none" variant="default">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-dashboard-border-subtle px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="m-0 font-display text-lg font-medium">
                  Version {selected.version}
                </h2>
                {active ? (
                  <StatusChip size="compact" tone="success">
                    Active
                  </StatusChip>
                ) : null}
              </div>
              <p className="mt-1 mb-0 text-xs text-dashboard-text-muted">
                {versionEditor(selected)} ·{" "}
                {formatAutomationRunTime(selected.createdAt)}
                {previous ? ` · Compared with version ${previous.version}` : ""}
              </p>
            </div>
            {canActivate && !active ? (
              <Button
                aria-label={`Make version ${selected.version} active`}
                disabled={activate.isPending}
                onClick={() => setConfirmOpen(true)}
              >
                {activate.isPending && activate.variables === selected.version
                  ? "Saving…"
                  : "Make active"}
              </Button>
            ) : null}
          </header>
          {activate.error && activate.variables === selected.version ? (
            <div className="px-4 pt-4 sm:px-5">
              <FormNotice
                tone="error"
                title="This version could not be made active."
              >
                {activate.error instanceof DashboardApiError
                  ? activate.error.code === "conflict"
                    ? "The automation changed. Try again."
                    : (activate.error.apiError ?? "Try again.")
                  : "Try again."}
              </FormNotice>
            </div>
          ) : null}
          <VersionCompare
            automation={automation}
            previous={previous}
            version={selected}
          />
        </Card>
      </div>
      <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>
            Make version {selected.version} active?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Junior saves these settings as a new version. Future runs use them.
            {automation.ownedByViewer
              ? null
              : ` Only ${automation.createdBy} can turn on their connected accounts or change where results go.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                activate.mutate(selected.version);
                setConfirmOpen(false);
              }}
              variant="primary"
            >
              Make active
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function VersionListItem(props: {
  active: boolean;
  changes: string | undefined;
  onSelect(): void;
  selected: boolean;
  version: ListedAutomationVersion;
}) {
  const { version } = props;
  return (
    <button
      aria-current={props.selected ? "true" : undefined}
      className={cn(
        "grid w-full min-w-0 cursor-pointer gap-0.5 rounded-md border-0 px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-dashboard-focus",
        props.selected
          ? "bg-dashboard-accent/[0.08] text-dashboard-text"
          : "bg-transparent text-dashboard-text hover:bg-dashboard-fill-soft",
      )}
      onClick={props.onSelect}
      type="button"
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        Version {version.version}
        {props.active ? (
          <StatusChip size="compact" tone="success">
            Active
          </StatusChip>
        ) : null}
      </span>
      <span className="truncate text-xs text-dashboard-text-muted">
        {versionEditor(version)} ·{" "}
        <time dateTime={version.createdAt}>
          {formatRelativeTime(version.createdAt)}
        </time>
      </span>
      {props.changes ? (
        <span className="truncate text-xs text-dashboard-text-muted">
          {props.changes}
        </span>
      ) : null}
    </button>
  );
}

const VERSION_FIELDS = [
  { key: "title", label: "Title" },
  { key: "instruction", label: "What to do" },
  { key: "when", label: "When to run" },
  { key: "destination", label: "Destination" },
  { key: "outcomes", label: "Where results go" },
  { key: "credentialMode", label: "Credentials" },
] as const;

type VersionField = (typeof VERSION_FIELDS)[number]["key"];

/** Show every saved field. Changed fields show the previous value too. */
function VersionCompare(props: {
  automation: AutomationSummary;
  previous: ListedAutomationVersion | undefined;
  version: ListedAutomationVersion;
}) {
  const { automation, previous, version } = props;
  const changed = previous ? changedFields(previous, version) : [];
  return (
    <dl className="m-0 divide-y divide-dashboard-border-subtle">
      {VERSION_FIELDS.map(({ key, label }) => {
        const isChanged = changed.includes(key);
        return (
          <div
            className={cn(
              "grid min-w-0 gap-2 px-4 py-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6 sm:px-5",
              isChanged &&
                "shadow-[inset_2px_0_0_var(--color-dashboard-accent)]",
            )}
            key={key}
          >
            <dt className="text-xs font-medium text-dashboard-text-muted">
              {label}
              {isChanged ? (
                <span className="mt-1 block font-normal text-dashboard-accent-text">
                  Changed
                </span>
              ) : null}
            </dt>
            <dd className="m-0 min-w-0 text-sm leading-relaxed break-words">
              {isChanged && previous && key === "instruction" ? (
                <LineDiff
                  after={version.definition.instruction}
                  before={previous.definition.instruction}
                />
              ) : isChanged && previous ? (
                <div className="grid gap-2">
                  <div className="text-dashboard-text-muted line-through decoration-dashboard-text-muted/50">
                    <span className="sr-only">Before: </span>
                    {fieldValue(key, automation, previous)}
                  </div>
                  <div>
                    <span className="sr-only">After: </span>
                    {fieldValue(key, automation, version)}
                  </div>
                </div>
              ) : (
                fieldValue(key, automation, version)
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function fieldValue(
  key: VersionField,
  automation: AutomationSummary,
  version: ListedAutomationVersion,
): ReactNode {
  const { definition } = version;
  switch (key) {
    case "title":
      return definition.title ?? "First line of the instruction";
    case "instruction":
      return (
        <span className="whitespace-pre-wrap">{definition.instruction}</span>
      );
    case "when":
      if (version.kind === "scheduled") {
        const { description, timezone } = version.definition.schedule;
        return description.includes(timezone)
          ? description
          : `${description} (${timezone})`;
      }
      return (
        <>
          {version.definition.trigger.label}
          {version.definition.trigger.identifier
            ? ` · ${version.definition.trigger.identifier}`
            : null}
          <br />
          {version.trigger.events.join(", ")}
          <TriggerFilters filters={version.trigger.filters} />
        </>
      );
    case "destination":
      return definition.destination.channelId ===
        automation.destination.channelId &&
        definition.destination.teamId === automation.destination.teamId
        ? automation.destination.label
        : `Another destination · ${definition.destination.channelId}`;
    case "outcomes":
      return definition.outcomes.length ? (
        <ol className="m-0 grid list-decimal gap-1 pl-5">
          {definition.outcomes.map((outcome, index) => (
            <li key={index}>
              {automationOutcomeLabel(outcome, automation.destination)}
            </li>
          ))}
        </ol>
      ) : (
        "No message on success"
      );
    case "credentialMode":
      return definition.credentialMode === "creator"
        ? `Uses accounts connected by ${automation.ownedByViewer ? "you" : automation.createdBy}.`
        : "System credentials only";
  }
}

/** Show removed and added instruction lines in place. */
function LineDiff(props: { after: string; before: string }) {
  return (
    <div className="grid overflow-hidden rounded-md border border-dashboard-border-subtle font-mono text-xs leading-relaxed">
      {diffLines(props.before, props.after).map((line, index) => (
        <div
          className={cn(
            "grid grid-cols-[1.5rem_minmax(0,1fr)] whitespace-pre-wrap px-2 py-0.5",
            line.kind === "added" && "bg-emerald-500/10 text-emerald-200",
            line.kind === "removed" && "bg-rose-500/10 text-rose-200",
          )}
          key={index}
        >
          <span aria-hidden="true" className="select-none opacity-60">
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
          </span>
          <span>
            {line.kind === "same" ? null : (
              <span className="sr-only">
                {line.kind === "added" ? "Added: " : "Removed: "}
              </span>
            )}
            {line.text || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

type DiffLine = { kind: "added" | "removed" | "same"; text: string };

/** Line diff from the longest common subsequence. Instructions stay short. */
function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lengths = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      lines.push({ kind: "removed", text: a[i++]! });
    } else {
      lines.push({ kind: "added", text: b[j++]! });
    }
  }
  while (i < a.length) lines.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) lines.push({ kind: "added", text: b[j++]! });
  return lines;
}

function versionEditor(version: ListedAutomationVersion): string {
  return version.editedBy
    ? (version.editedBy.fullName ??
        version.editedBy.userName ??
        version.editedBy.slackUserId)
    : "Editor unknown";
}

function versionChangeText(
  version: ListedAutomationVersion,
  previous: ListedAutomationVersion | undefined,
  truncated: boolean,
): string | undefined {
  if (!previous) {
    return version.version === 1 || !truncated
      ? "First saved version"
      : undefined;
  }
  const changes = changedFields(previous, version);
  if (changes.length === 0) return "No setting changes";
  const labels = VERSION_FIELDS.filter(({ key }) => changes.includes(key)).map(
    ({ label }) => label.toLowerCase(),
  );
  return `Changed ${labels.join(", ")}`;
}

/** Name the fields that differ from the previous version. */
function changedFields(
  previous: ListedAutomationVersion,
  version: ListedAutomationVersion,
): VersionField[] {
  const before: Record<string, unknown> = previous.definition;
  const after: Record<string, unknown> = version.definition;
  const differs = (key: string) =>
    JSON.stringify(before[key]) !== JSON.stringify(after[key]);
  return VERSION_FIELDS.flatMap(({ key }) =>
    (key === "when" ? differs("schedule") || differs("trigger") : differs(key))
      ? [key]
      : [],
  );
}
