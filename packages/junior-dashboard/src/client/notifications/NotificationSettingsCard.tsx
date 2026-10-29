import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isWithinNotificationSchedule,
  notificationSettingsSchema,
  testNotificationResponseSchema,
  type NotificationSchedule,
  type NotificationSettings,
} from "@sentry/junior/api/schema";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { InlineError } from "../components/InlineError";
import { Card } from "../components/layout/Card";
import { Select } from "../components/Select";
import { Skeleton } from "../components/ui/skeleton";
import { del, fetchDashboardJson, post, put } from "../http";
import {
  currentPushSubscription,
  pushSupport,
  subscribeThisDevice,
  unsubscribeThisDevice,
} from "./push";

const notificationSettingsQueryKey = ["dashboard", "notifications"] as const;
const deviceQueryKey = ["dashboard", "notifications", "device"] as const;
const NOTIFICATIONS_PATH = "/api/notifications";

const WEEKDAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
] as const;

const TIMEZONE_SOURCE_LABEL: Record<
  Exclude<NotificationSettings["timezoneSource"], "manual">,
  string
> = {
  default: "Junior default",
  saved: "from your profile",
  slack: "from Slack",
};

function timezoneOptions(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

/** Show the device control and notification hours on the Settings page. */
export function NotificationSettingsCard() {
  const settingsQuery = useQuery({
    queryKey: notificationSettingsQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        notificationSettingsSchema,
        NOTIFICATIONS_PATH,
        signal,
      ),
  });

  return (
    <Card className="mt-6 mb-0" padding="md" variant="raised">
      <h2 className="m-0 text-lg font-bold">Phone notifications</h2>
      <p className="mt-2 mb-0 text-sm text-dashboard-text-muted">
        Get a notification when Junior replies to a conversation you started
        here. Slack threads keep using Slack notifications.
      </p>
      {settingsQuery.isPending ? (
        <NotificationSettingsSkeleton />
      ) : settingsQuery.isError ? (
        <InlineError className="mt-5">
          Could not load notification settings. Reload the page to try again.
        </InlineError>
      ) : (
        <>
          <DeviceSection settings={settingsQuery.data} />
          <ScheduleForm settings={settingsQuery.data} />
        </>
      )}
    </Card>
  );
}

function NotificationSettingsSkeleton() {
  return (
    <div
      aria-label="Loading notification settings"
      className="mt-5 grid gap-3"
      role="status"
    >
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function DeviceSection({ settings }: { settings: NotificationSettings }) {
  const queryClient = useQueryClient();
  const support = useMemo(() => pushSupport(), []);
  const deviceQuery = useQuery({
    enabled: support === "supported",
    queryKey: deviceQueryKey,
    queryFn: async () => (await currentPushSubscription())?.endpoint ?? null,
  });
  const saveSettings = (next: NotificationSettings) =>
    queryClient.setQueryData(notificationSettingsQueryKey, next);

  const enable = useMutation({
    mutationFn: async (publicKey: string) => {
      const subscription = await subscribeThisDevice(publicKey);
      return await post(
        notificationSettingsSchema,
        `${NOTIFICATIONS_PATH}/subscriptions`,
        subscription,
      );
    },
    onSuccess: (next) => {
      saveSettings(next);
      void queryClient.invalidateQueries({ queryKey: deviceQueryKey });
    },
  });
  const disable = useMutation({
    mutationFn: async () => {
      const endpoint = await unsubscribeThisDevice();
      return endpoint
        ? await del(
            notificationSettingsSchema,
            `${NOTIFICATIONS_PATH}/subscriptions`,
            { endpoint },
          )
        : undefined;
    },
    onSuccess: (next) => {
      if (next) saveSettings(next);
      void queryClient.invalidateQueries({ queryKey: deviceQueryKey });
    },
  });
  const test = useMutation({
    mutationFn: () =>
      post(testNotificationResponseSchema, `${NOTIFICATIONS_PATH}/test`, {}),
  });

  if (!settings.publicKey) {
    return (
      <p className="mt-5 mb-0 text-sm text-dashboard-text-muted">
        Phone notifications are not set up for this Junior install. Ask a Junior
        admin to add Web Push keys.
      </p>
    );
  }
  if (support === "needs-install") {
    return (
      <p className="mt-5 mb-0 text-sm text-dashboard-text-muted">
        On iPhone and iPad, add Junior to your Home Screen first. Tap Share,
        then Add to Home Screen. Open Junior from the Home Screen and come back
        to this page.
      </p>
    );
  }
  if (support === "unsupported") {
    return (
      <p className="mt-5 mb-0 text-sm text-dashboard-text-muted">
        This browser cannot receive notifications.
      </p>
    );
  }
  const permissionDenied =
    typeof Notification !== "undefined" && Notification.permission === "denied";
  const subscribed = Boolean(deviceQuery.data);
  const publicKey = settings.publicKey;
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-3">
        {subscribed ? (
          <>
            <Button
              disabled={disable.isPending}
              onClick={() => disable.mutate()}
              type="button"
            >
              {disable.isPending ? "Turning off…" : "Turn off on this device"}
            </Button>
            <Button
              disabled={test.isPending}
              onClick={() => test.mutate()}
              type="button"
            >
              {test.isPending ? "Sending…" : "Send a test"}
            </Button>
          </>
        ) : (
          <Button
            disabled={
              enable.isPending || deviceQuery.isPending || permissionDenied
            }
            onClick={() => enable.mutate(publicKey)}
            type="button"
            variant="primary"
          >
            {enable.isPending ? "Turning on…" : "Turn on for this device"}
          </Button>
        )}
      </div>
      <p className="mt-3 mb-0 text-sm text-dashboard-text-muted">
        {settings.deviceCount === 1
          ? "1 device gets your notifications."
          : `${settings.deviceCount} devices get your notifications.`}
        {permissionDenied
          ? " This browser blocks notifications from Junior. Allow them in the browser settings."
          : ""}
      </p>
      {test.isSuccess ? (
        <p className="mt-2 mb-0 text-sm text-emerald-300">
          {test.data.delivered > 0
            ? "Test sent."
            : "No device got the test. Turn notifications off and on again."}
        </p>
      ) : null}
      {enable.isError || disable.isError || test.isError ? (
        <InlineError className="mt-2">
          Could not change notifications on this device. Try again.
        </InlineError>
      ) : null}
    </div>
  );
}

function ScheduleForm({ settings }: { settings: NotificationSettings }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<NotificationSchedule>(settings.schedule);
  useEffect(() => setDraft(settings.schedule), [settings.schedule]);
  const zones = useMemo(() => timezoneOptions(), []);
  const save = useMutation({
    mutationFn: (schedule: NotificationSchedule) =>
      put(
        notificationSettingsSchema,
        `${NOTIFICATIONS_PATH}/schedule`,
        schedule,
      ),
    onSuccess: (next) =>
      queryClient.setQueryData(notificationSettingsQueryKey, next),
  });
  const update = (patch: Partial<NotificationSchedule>) => {
    setDraft((current) => ({ ...current, ...patch }));
    if (save.isSuccess || save.isError) save.reset();
  };
  const changed = JSON.stringify(draft) !== JSON.stringify(settings.schedule);
  const valid =
    draft.start !== draft.end &&
    (!draft.workingHoursOnly || draft.days.length > 0);
  const timezone = draft.timezone ?? settings.timezone;
  const openNow = isWithinNotificationSchedule(draft, timezone, Date.now());

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changed && valid) save.mutate(draft);
  }

  return (
    <form
      className="mt-6 border-t border-dashboard-border pt-5"
      onSubmit={submit}
    >
      <h3 className="m-0 text-base font-bold">Working hours</h3>
      <label className="mt-4 flex items-center gap-3 text-sm">
        <Checkbox
          checked={draft.workingHoursOnly}
          onCheckedChange={(checked) =>
            update({ workingHoursOnly: checked === true })
          }
        />
        Only notify me during working hours
      </label>
      <fieldset
        className="m-0 mt-4 border-0 p-0 disabled:opacity-60"
        disabled={!draft.workingHoursOnly}
      >
        <legend className="mb-2 p-0 text-sm font-medium">Days</legend>
        <ToggleGroup
          aria-label="Working days"
          className="flex-wrap gap-2"
          multiple
          onValueChange={(values) =>
            update({ days: values.map(Number).sort((a, b) => a - b) })
          }
          value={draft.days.map(String)}
        >
          {WEEKDAYS.map(([day, label]) => (
            <ToggleGroupItem
              className="min-h-11 min-w-12 lg:min-h-9"
              key={day}
              value={String(day)}
              variant="pill"
            >
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:max-w-sm">
          <Field>
            <FieldLabel htmlFor="notification-start">Start</FieldLabel>
            <Input
              id="notification-start"
              onChange={(event) => update({ start: event.target.value })}
              required
              step={900}
              type="time"
              value={draft.start}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="notification-end">End</FieldLabel>
            <Input
              id="notification-end"
              onChange={(event) => update({ end: event.target.value })}
              required
              step={900}
              type="time"
              value={draft.end}
            />
          </Field>
        </div>
      </fieldset>
      <Field className="mt-4 sm:max-w-sm">
        <FieldLabel htmlFor="notification-timezone">Timezone</FieldLabel>
        <Select
          id="notification-timezone"
          onChange={(event) =>
            update({ timezone: event.target.value || undefined })
          }
          value={draft.timezone ?? ""}
        >
          <option value="">
            {settings.timezoneSource === "manual"
              ? "Automatic"
              : `Automatic: ${settings.timezone} (${TIMEZONE_SOURCE_LABEL[settings.timezoneSource]})`}
          </option>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>
        <FieldDescription>
          Automatic uses your Slack timezone when Junior can read it.
        </FieldDescription>
      </Field>
      <p className="mt-4 mb-0 text-sm text-dashboard-text-muted">
        {openNow
          ? "Notifications are on right now."
          : "Notifications are paused right now. Replies still show here."}
      </p>
      <div className="mt-5 flex items-center gap-3">
        <Button disabled={!changed || !valid || save.isPending} type="submit">
          {save.isPending ? "Saving…" : "Save hours"}
        </Button>
        {save.isSuccess ? (
          <p className="m-0 text-sm text-emerald-300">Hours saved.</p>
        ) : null}
        {save.isError ? (
          <InlineError>Could not save your hours. Try again.</InlineError>
        ) : null}
      </div>
    </form>
  );
}
