import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

export function createSystemTimeTool() {
  return zodTool({
    description:
      "Return current system time in UTC and local ISO formats. Use when the user asks for current time/date context. Do not use as a substitute for historical or timezone-conversion research.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({}),
    outputSchema: juniorToolResultSchema,
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
