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
      unix_ms: result.unix_ms,
      iso_utc: result.iso_utc,
      iso_local: result.iso_local,
      timezone: result.timezone,
      timezone_offset_minutes: result.timezone_offset_minutes,
    });
    expect(result.timezone).toBeNull();
  });

  it("returns local wall time for a valid IANA timezone", async () => {
    const systemTime = createSystemTimeTool();
    const result = await systemTime.execute!(
      systemTime.prepareArguments!({ timezone: "America/Los_Angeles" }),
      {},
    );

    expect(result.timezone).toBe("America/Los_Angeles");
    expect(result.iso_utc).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(result.iso_local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(result.timezone_offset_minutes).not.toBe(0);
    expect(systemTime.privateTraceResult?.(result)).toEqual({
      unix_ms: result.unix_ms,
      iso_utc: result.iso_utc,
      iso_local: result.iso_local,
      timezone: "America/Los_Angeles",
      timezone_offset_minutes: result.timezone_offset_minutes,
    });
  });

  it("rejects invalid IANA timezones", async () => {
    const systemTime = createSystemTimeTool();
    await expect(
      systemTime.execute!(
        systemTime.prepareArguments!({ timezone: "not/a-zone" }),
        {},
      ),
    ).rejects.toMatchObject({
      name: "ToolInputError",
      message: "timezone must be a valid IANA time zone.",
    });
  });
});
