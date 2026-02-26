import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

export function createSystemTimeTool() {
  return tool({
    description: "Return current system time in UTC and local ISO formats.",
    inputSchema: Type.Object({}),
    execute: async () => {
      const now = new Date();
      return {
        ok: true,
        unix_ms: now.getTime(),
        iso_utc: now.toISOString(),
        iso_local: new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace("Z", ""),
        timezone_offset_minutes: now.getTimezoneOffset()
      };
    }
  });
}
