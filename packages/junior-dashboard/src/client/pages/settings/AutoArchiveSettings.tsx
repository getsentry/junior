import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  AUTO_ARCHIVE_MAX_GRACE_HOURS,
  dashboardIdentitySchema,
  type DashboardIdentity,
} from "../../../api/schema";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { NativeSelect } from "../../components/ui/native-select";
import { InlineError } from "../../components/InlineError";
import { Card } from "../../components/layout/Card";
import { useArchiveDoneConversations } from "../../conversations/autoArchiveQueries";
import { patch } from "../../http";
import type { DashboardCoreData } from "../../types";

const dashboardCoreQueryKey = ["dashboard", "core"] as const;

/** Grace periods offered in Settings, in hours. */
const AUTO_ARCHIVE_GRACE_OPTIONS = [1, 6, 24, 72, AUTO_ARCHIVE_MAX_GRACE_HOURS];

function formatArchivedCount(count: number): string {
  if (count === 0) return "No done conversations to archive.";
  return count === 1
    ? "Archived 1 conversation."
    : `Archived ${count} conversations.`;
}

function formatGraceHours(hours: number): string {
  if (hours % 24 !== 0) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = hours / 24;
  if (days === 7) return "1 week";
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * Let the user turn auto-archive on for their conversations and pick how long
 * finished work must stay quiet before Junior archives it.
 */
export function AutoArchiveSettings({
  identity,
}: {
  identity: DashboardIdentity;
}) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (
      settings: Pick<
        DashboardIdentity,
        "autoArchiveDefault" | "autoArchiveGraceHours"
      >,
    ) => patch(dashboardIdentitySchema, "/api/me", settings),
    onSuccess: (updated) => {
      queryClient.setQueryData<DashboardCoreData>(
        dashboardCoreQueryKey,
        (current) => (current ? { ...current, me: updated } : current),
      );
    },
  });
  const archiveDone = useArchiveDoneConversations();
  const enabled = identity.autoArchiveDefault ?? false;
  const graceHours = identity.autoArchiveGraceHours ?? 24;
  // Keep a saved value that is not a preset, so the select shows the truth.
  const graceOptions = AUTO_ARCHIVE_GRACE_OPTIONS.includes(graceHours)
    ? AUTO_ARCHIVE_GRACE_OPTIONS
    : [...AUTO_ARCHIVE_GRACE_OPTIONS, graceHours].sort((a, b) => a - b);

  return (
    <Card className="mt-6 mb-0" padding="md" variant="raised">
      <h2 className="m-0 text-lg font-bold">Conversations</h2>
      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <Checkbox
          checked={enabled}
          className="mt-0.5"
          disabled={update.isPending}
          onCheckedChange={(checked) =>
            update.mutate({ autoArchiveDefault: checked })
          }
        />
        <span className="grid gap-0.5">
          <span className="text-sm font-medium">
            Auto-archive conversations when done
          </span>
          <span className="text-xs text-dashboard-text-muted">
            Archive a conversation for you when all of its linked work, such as
            pull requests, is merged or closed and nobody replies during the
            wait time. You can change this for each conversation in its details.
          </span>
        </span>
      </label>
      <Field className="mt-5 max-w-xs">
        <FieldLabel htmlFor="auto-archive-grace">Wait time</FieldLabel>
        <NativeSelect
          aria-describedby="auto-archive-grace-help"
          disabled={update.isPending}
          id="auto-archive-grace"
          onChange={(event) =>
            update.mutate({ autoArchiveGraceHours: Number(event.target.value) })
          }
          value={graceHours}
        >
          {graceOptions.map((hours) => (
            <option key={hours} value={hours}>
              {formatGraceHours(hours)}
            </option>
          ))}
        </NativeSelect>
        <FieldDescription id="auto-archive-grace-help">
          How long finished work and the conversation stay quiet before archive.
        </FieldDescription>
      </Field>
      {update.isError ? (
        <InlineError className="mt-3">
          Could not save this setting. Try again.
        </InlineError>
      ) : null}
      <div className="mt-5 grid gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={archiveDone.isPending}
            onClick={() => archiveDone.mutate()}
            type="button"
          >
            {archiveDone.isPending ? "Archiving…" : "Archive done now"}
          </Button>
          {archiveDone.isSuccess ? (
            <p className="m-0 text-sm text-dashboard-text-muted" role="status">
              {formatArchivedCount(archiveDone.data.archived)}
            </p>
          ) : null}
          {archiveDone.isError ? (
            <InlineError>
              Could not archive conversations. Try again.
            </InlineError>
          ) : null}
        </div>
        <p className="m-0 text-xs text-dashboard-text-muted">
          Archive every done conversation once, after the same wait time. Skips
          conversations where you turned auto-archive off.
        </p>
      </div>
    </Card>
  );
}
