import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import {
  automationScheduleIntentSchema,
  automationSchedulePreviewSchema,
  type AutomationEdit,
} from "@sentry/junior/api/schema";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { Select } from "../../components/Select";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { post, DashboardApiError } from "../../http";
import {
  scheduleDraft,
  weekdays,
  type AutomationScheduleDraft,
} from "./automationDraft";

/** Edit calendar fields and preview the next run without saving. */
export function AutomationScheduleFields(props: {
  automation: Extract<AutomationEdit, { kind: "scheduled" }>;
  value?: AutomationScheduleDraft;
  onChange(value: AutomationScheduleDraft | undefined): void;
}) {
  const value = props.value ?? scheduleDraft(props.automation);
  const [previewValue, setPreviewValue] = useState(props.value);
  useEffect(() => {
    const timer = setTimeout(() => setPreviewValue(props.value), 300);
    return () => clearTimeout(timer);
  }, [props.value]);
  const parsed = automationScheduleIntentSchema.safeParse(previewValue);
  const preview = useQuery({
    queryKey: [
      "dashboard",
      "automation-schedule-preview",
      props.automation.id,
      previewValue,
    ],
    enabled: Boolean(previewValue) && parsed.success,
    retry: false,
    queryFn: () =>
      post(
        automationSchedulePreviewSchema,
        `/api/automations/${encodeURIComponent(props.automation.id)}/preview`,
        previewValue,
      ),
  });
  const frequency = value.kind === "recurring" ? value.frequency : "once";
  const time = value.kind === "recurring" ? value.time : value.timing.time;
  const nextRun = props.value
    ? preview.data?.nextRunAtMs
    : props.automation.nextRunAtMs;
  const waiting = props.value !== previewValue || preview.isFetching;
  const issue =
    preview.error instanceof DashboardApiError
      ? preview.error.apiError
      : preview.error
        ? "Schedule preview could not be loaded. Try again."
        : props.value && !parsed.success && !waiting
          ? parsed.error.issues[0]?.message
          : undefined;
  return (
    <>
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="schedule-frequency">Repeat</FieldLabel>
          <Select
            id="schedule-frequency"
            value={frequency}
            onChange={(e) => {
              const frequency = e.target.value;
              if (
                frequency !== "once" &&
                frequency !== "daily" &&
                frequency !== "weekly" &&
                frequency !== "monthly" &&
                frequency !== "yearly"
              )
                return;
              props.onChange(
                frequency === "once"
                  ? {
                      kind: "one_off",
                      timezone:
                        value.timezone ?? props.automation.schedule.timezone,
                      timing: { type: "at", date: "", time },
                    }
                  : {
                      kind: "recurring",
                      timezone: value.timezone,
                      time,
                      frequency,
                      interval: 1,
                      weekdays: frequency === "weekly" ? ["monday"] : undefined,
                      dayOfMonth: ["monthly", "yearly"].includes(frequency)
                        ? 1
                        : undefined,
                      month: frequency === "yearly" ? 1 : undefined,
                    },
              );
            }}
          >
            <option value="once">Once</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="yearly">Every year</option>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="schedule-time">Time</FieldLabel>
          <Input
            size="comfortable"
            id="schedule-time"
            type="time"
            value={time}
            onChange={(e) =>
              props.onChange(
                value.kind === "recurring"
                  ? { ...value, time: e.target.value }
                  : {
                      ...value,
                      timing: {
                        type: "at",
                        date: value.timing.date,
                        time: e.target.value,
                      },
                    },
              )
            }
          />
        </Field>
      </div>
      {value.kind === "recurring" ? (
        <>
          {value.frequency === "weekly" ? (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">On</legend>
              <ToggleGroup
                className="grid grid-cols-7 gap-1.5"
                multiple
                onValueChange={(next) =>
                  props.onChange({ ...value, weekdays: next })
                }
                value={value.weekdays ?? []}
              >
                {[...weekdays.slice(1), weekdays[0]].map((day) => (
                  <ToggleGroupItem
                    key={day}
                    aria-label={day}
                    className="h-auto min-h-11 min-w-0 border-dashboard-border-emphasis px-1 capitalize data-pressed:border-dashboard-focus/50 data-pressed:bg-dashboard-focus/10 data-pressed:text-dashboard-focus sm:min-h-10 sm:text-sm"
                    value={day}
                  >
                    {day.slice(0, 3)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </fieldset>
          ) : null}
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="schedule-interval">Interval</FieldLabel>
              <Input
                size="comfortable"
                id="schedule-interval"
                type="number"
                min={1}
                max={365}
                value={value.interval ?? 1}
                onChange={(e) =>
                  props.onChange({ ...value, interval: e.target.valueAsNumber })
                }
              />
              <FieldDescription id="schedule-interval-help">
                Number of calendar periods between runs.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="schedule-start">Start date</FieldLabel>
              <Input
                size="comfortable"
                id="schedule-start"
                type="date"
                value={value.startDate ?? ""}
                onChange={(e) =>
                  props.onChange({
                    ...value,
                    startDate: e.target.value || undefined,
                  })
                }
              />
            </Field>
          </div>
          {value.frequency === "monthly" || value.frequency === "yearly" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="schedule-day">Day of month</FieldLabel>
                <Input
                  size="comfortable"
                  id="schedule-day"
                  type="number"
                  min={1}
                  max={31}
                  value={value.dayOfMonth ?? 1}
                  onChange={(e) =>
                    props.onChange({
                      ...value,
                      dayOfMonth: e.target.valueAsNumber,
                    })
                  }
                />
              </Field>
              {value.frequency === "yearly" ? (
                <Field>
                  <FieldLabel htmlFor="schedule-month">Month</FieldLabel>
                  <Select
                    id="schedule-month"
                    value={value.month ?? 1}
                    onChange={(e) =>
                      props.onChange({
                        ...value,
                        month: Number(e.target.value),
                      })
                    }
                  >
                    {Array.from({ length: 12 }, (_, index) => (
                      <option key={index} value={index + 1}>
                        {new Intl.DateTimeFormat("en", {
                          month: "long",
                          timeZone: "UTC",
                        }).format(new Date(Date.UTC(2026, index, 1)))}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <Field>
          <FieldLabel htmlFor="schedule-date">Date</FieldLabel>
          <Input
            size="comfortable"
            id="schedule-date"
            type="date"
            value={value.timing.date}
            onChange={(e) =>
              props.onChange({
                ...value,
                timing: { type: "at", time, date: e.target.value },
              })
            }
          />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="schedule-timezone">Timezone</FieldLabel>
        <Input
          size="comfortable"
          id="schedule-timezone"
          list="automation-timezones"
          value={value.timezone ?? ""}
          onChange={(e) =>
            props.onChange({ ...value, timezone: e.target.value })
          }
        />
        <datalist id="automation-timezones">
          {["UTC", ...Intl.supportedValuesOf("timeZone")].map((zone) => (
            <option key={zone}>{zone}</option>
          ))}
        </datalist>
        <FieldDescription id="schedule-timezone-help">
          Use an IANA timezone. The schedule follows local time, including
          daylight saving time.
        </FieldDescription>
      </Field>
      <div
        role="status"
        className="flex gap-3 rounded-md bg-dashboard-fill-soft p-3 text-sm leading-relaxed"
      >
        <CalendarClock
          aria-hidden
          size={17}
          className="mt-0.5 shrink-0 text-dashboard-text-muted"
        />
        <div>
          {waiting ? (
            "Checking schedule…"
          ) : issue ? (
            <>
              <span className="text-rose-300">{issue}</span>
              {preview.error ? (
                <Button onClick={() => void preview.refetch()}>
                  Try again
                </Button>
              ) : null}
            </>
          ) : nextRun ? (
            <>
              Next run{" "}
              {new Intl.DateTimeFormat(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
                timeZone: props.value
                  ? (preview.data?.schedule.timezone ?? "UTC")
                  : props.automation.schedule.timezone,
              }).format(nextRun)}
            </>
          ) : (
            "No next run."
          )}
        </div>
      </div>
      {props.value ? (
        <Button className="w-fit" onClick={() => props.onChange(undefined)}>
          Keep saved schedule
        </Button>
      ) : null}
    </>
  );
}
