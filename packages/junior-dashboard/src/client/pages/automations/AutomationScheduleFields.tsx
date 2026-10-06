import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import {
  automationScheduleIntentSchema,
  automationSchedulePreviewSchema,
  type AutomationEdit,
} from "@sentry/junior/api/schema";
import { Field } from "../../components/Field";
import { Select } from "../../components/Select";
import { TextInput } from "../../components/TextInput";
import { Button } from "../../components/Button";
import { post, DashboardApiError } from "../../http";
import { cn } from "../../styles";
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
        `/api/automations/scheduled/${encodeURIComponent(props.automation.id)}/preview`,
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
        <Field label="Repeat" htmlFor="schedule-frequency">
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
        <Field label="Time" htmlFor="schedule-time">
          <TextInput
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
              <div className="grid grid-cols-7 gap-1.5">
                {[...weekdays.slice(1), weekdays[0]].map((day) => (
                  <button
                    type="button"
                    key={day}
                    aria-label={day}
                    aria-pressed={value.weekdays?.includes(day) ?? false}
                    onClick={() =>
                      props.onChange({
                        ...value,
                        weekdays: value.weekdays?.includes(day)
                          ? value.weekdays.filter((d) => d !== day)
                          : [...(value.weekdays ?? []), day],
                      })
                    }
                    className={cn(
                      "min-h-11 cursor-pointer rounded border px-1 text-xs font-medium capitalize focus-visible:outline-2 focus-visible:outline-dashboard-focus sm:min-h-10 sm:text-sm",
                      value.weekdays?.includes(day)
                        ? "border-dashboard-focus/50 bg-dashboard-focus/10 text-dashboard-focus"
                        : "border-dashboard-border-emphasis text-dashboard-text-muted hover:bg-dashboard-fill-hover",
                    )}
                  >
                    {day.slice(0, 3)}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
            <Field
              label="Interval"
              htmlFor="schedule-interval"
              help="Number of calendar periods between runs."
            >
              <TextInput
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
            </Field>
            <Field label="Start date" htmlFor="schedule-start">
              <TextInput
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
              <Field label="Day of month" htmlFor="schedule-day">
                <TextInput
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
                <Field label="Month" htmlFor="schedule-month">
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
        <Field label="Date" htmlFor="schedule-date">
          <TextInput
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
      <Field
        label="Timezone"
        htmlFor="schedule-timezone"
        help="Use an IANA timezone. The schedule follows local time, including daylight saving time."
      >
        <TextInput
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
