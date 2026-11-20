import { useMemo } from "react";
import { useLocalStorage } from "@uidotdev/usehooks";
import { dateTimeFormat, getDashboardTimeZone } from "../time";

const storageKey = "junior:event-log:time-mode";

/** Share the browser-only UTC/local preference between event rows and details. */
export function useEventTime() {
  const [mode, setMode] = useLocalStorage<"utc" | "local">(storageKey, "utc");
  const local = mode === "local";
  const localTimeZone = getDashboardTimeZone();
  const timeZone = local ? localTimeZone : "UTC";
  const formatters = useMemo(() => {
    const clock: Intl.DateTimeFormatOptions = {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
      numberingSystem: "latn",
    };
    return {
      clock: dateTimeFormat(clock),
      timestamp: dateTimeFormat({
        ...clock,
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZoneName: "short",
      }),
      // The details header is narrow, so it leaves out milliseconds.
      shortTimestamp: dateTimeFormat({
        ...clock,
        fractionalSecondDigits: undefined,
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZoneName: "short",
      }),
      // A log can span both standard time and daylight-saving time.
      zone: dateTimeFormat({
        timeZone,
        timeZoneName: "shortGeneric",
      }),
    };
  }, [timeZone]);
  const label = local
    ? (formatters.zone
        .formatToParts()
        .find((part) => part.type === "timeZoneName")?.value ?? localTimeZone)
    : "UTC";

  return {
    local,
    label,
    title: local
      ? `${localTimeZone} · Switch to UTC`
      : `UTC · Switch to local time (${localTimeZone})`,
    toggle() {
      setMode(local ? "utc" : "local");
    },
    formatClock(value: string) {
      return formatters.clock.format(new Date(value));
    },
    formatTimestamp(value: string) {
      return formatters.timestamp.format(new Date(value));
    },
    formatShortTimestamp(value: string) {
      return formatters.shortTimestamp.format(new Date(value));
    },
  };
}
