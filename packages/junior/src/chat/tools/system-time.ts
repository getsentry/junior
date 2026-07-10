import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

const systemTimeOutputSchema = juniorToolResultSchema.extend({
  unix_ms: z.number(),
  iso_utc: z.string(),
  iso_local: z.string(),
  timezone_offset_minutes: z.number(),
});

export function createSystemTimeTool() {
  return zodTool({
    description:
      "Return current system time in UTC and local ISO formats. Use when the user asks for current time/date context. Do not use as a substitute for historical or timezone-conversion research.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({}),
    outputSchema: systemTimeOutputSchema,
    privateTraceResult: (result) => ({
      ok: result.ok,
      status: result.status,
      unix_ms: result.unix_ms,
      iso_utc: result.iso_utc,
      iso_local: result.iso_local,
      timezone_offset_minutes: result.timezone_offset_minutes,
    }),
    execute: async () => {
      const now = new Date();
      const details = {
        unix_ms: now.getTime(),
        iso_utc: now.toISOString(),
        iso_local: new Date(now.getTime() - now.getTimezoneOffset() * 60000)
          .toISOString()
          .replace("Z", ""),
        timezone_offset_minutes: now.getTimezoneOffset(),
      };
      return {
        ok: true,
        status: "success" as const,
        data: details,
        ...details,
      };
    },
  });
}
