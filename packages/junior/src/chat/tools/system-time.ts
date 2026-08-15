import { z } from "zod";
import { getZonedDateTimeParts } from "@/chat/scheduled-tasks/cadence";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const systemTimeInputSchema = z.object({
  timezone: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional IANA timezone, for example America/Los_Angeles. When set, iso_local and timezone_offset_minutes are for that zone.",
    ),
});

const systemTimeOutputSchema = juniorToolOutputSchema.extend({
  unix_ms: z.number(),
  iso_utc: z.string(),
  iso_local: z.string(),
  timezone: z.string().nullable(),
  timezone_offset_minutes: z.number(),
});

/**
 * Current-time lookup for turn answers.
 *
 * Accept an optional IANA timezone so remembered local-time preferences can be
 * answered without shelling out to bash for conversion.
 */
export function createSystemTimeTool() {
  return zodTool({
    description:
      "Return current system time in UTC and optional local IANA timezone formats. Use when the user asks for current time/date context. Pass timezone when the answer should be in a known IANA zone such as America/Los_Angeles.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: systemTimeInputSchema,
    outputSchema: systemTimeOutputSchema,
    privateTraceResult: (result) => ({
      unix_ms: result.unix_ms,
      iso_utc: result.iso_utc,
      iso_local: result.iso_local,
      timezone: result.timezone,
      timezone_offset_minutes: result.timezone_offset_minutes,
    }),
    execute: async (input) => {
      const now = new Date();
      const timezone = input.timezone?.trim() || null;
      if (timezone) {
        if (!isValidTimeZone(timezone)) {
          throw new ToolInputError("timezone must be a valid IANA time zone.");
        }
        const parts = getZonedDateTimeParts(now.getTime(), timezone);
        const isoLocal = [
          String(parts.year).padStart(4, "0"),
          String(parts.month).padStart(2, "0"),
          String(parts.day).padStart(2, "0"),
        ].join("-") +
          "T" +
          [
            String(parts.hour).padStart(2, "0"),
            String(parts.minute).padStart(2, "0"),
            String(parts.second).padStart(2, "0"),
          ].join(":");
        return {
          unix_ms: now.getTime(),
          iso_utc: now.toISOString(),
          iso_local: isoLocal,
          timezone,
          timezone_offset_minutes: getTimeZoneOffsetMinutes(
            now.getTime(),
            timezone,
          ),
        };
      }

      return {
        unix_ms: now.getTime(),
        iso_utc: now.toISOString(),
        iso_local: new Date(now.getTime() - now.getTimezoneOffset() * 60000)
          .toISOString()
          .replace("Z", ""),
        timezone: null,
        timezone_offset_minutes: now.getTimezoneOffset(),
      };
    },
  });
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function getTimeZoneOffsetMinutes(timestampMs: number, timezone: string): number {
  const parts = getZonedDateTimeParts(timestampMs, timezone);
  const asUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Match Date#getTimezoneOffset: minutes to add to local time to get UTC.
  return Math.round((timestampMs - asUtcMs) / 60000);
}
