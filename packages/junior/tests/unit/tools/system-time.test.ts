import { describe, expect, it } from "vitest";
import { createSystemTimeTool } from "@/chat/tools/system-time";

describe("systemTime", () => {
  it("projects only its stable time fields into private traces", async () => {
    const systemTime = createSystemTimeTool();
    const result = await systemTime.execute!(
      systemTime.prepareArguments!({}),
      {},
    );

    expect(systemTime.privateTraceResult?.(result)).toEqual({
      ok: true,
      status: "success",
      unix_ms: result.unix_ms,
      iso_utc: result.iso_utc,
      iso_local: result.iso_local,
      timezone_offset_minutes: result.timezone_offset_minutes,
    });
  });
});
