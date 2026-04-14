import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_CI = process.env.CI;
const ORIGINAL_LOG_FORMAT = process.env.JUNIOR_LOG_FORMAT;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function setStdoutIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, "");
}

async function loadLoggingModule() {
  vi.resetModules();
  vi.doMock("@/chat/sentry", () => ({
    captureException: undefined,
    captureMessage: undefined,
    getActiveSpan: () => undefined,
    logger: {},
    setTag: undefined,
    setUser: undefined,
    spanToJSON: () => ({}),
    withScope: undefined,
  }));
  return await import("@/chat/logging");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock("@/chat/sentry");
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_CI === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = ORIGINAL_CI;
  }
  if (ORIGINAL_LOG_FORMAT === undefined) {
    delete process.env.JUNIOR_LOG_FORMAT;
  } else {
    process.env.JUNIOR_LOG_FORMAT = ORIGINAL_LOG_FORMAT;
  }
  setStdoutIsTTY(ORIGINAL_STDOUT_IS_TTY);
});

describe("console log formatting", () => {
  it("uses a compact summary in development worker runtimes", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.CI;
    delete process.env.JUNIOR_LOG_FORMAT;
    setStdoutIsTTY(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T16:29:00.133Z"));

    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const { log } = await loadLoggingModule();

    log.info(
      "plugin_loaded",
      {
        "app.plugin.name": "github",
        "app.plugin.capability_count": 8,
        "app.plugin.config_key_count": 1,
        "app.plugin.has_mcp": false,
        "file.directory":
          "/home/dcramer/src/junior/apps/example/node_modules/@sentry/junior-github",
      },
      "Loaded plugin",
    );

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = stripAnsi(String(infoSpy.mock.calls[0]?.[0] ?? ""));
    expect(line).toMatch(
      /^\d{2}:\d{2}:\d{2} INF Loaded plugin github caps=8 config=1 mcp=no$/,
    );
    expect(line).not.toContain("event.name=");
    expect(line).not.toContain("file.directory=");
  });

  it("keeps the structured formatter in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CI;
    delete process.env.JUNIOR_LOG_FORMAT;
    setStdoutIsTTY(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T16:29:00.133Z"));

    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const { log } = await loadLoggingModule();

    log.info(
      "plugin_loaded",
      {
        "app.plugin.name": "github",
        "app.plugin.capability_count": 8,
      },
      "Loaded plugin",
    );

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = stripAnsi(String(infoSpy.mock.calls[0]?.[0] ?? ""));
    expect(line).toContain("2026-04-14T16:29:00.133Z INF Loaded plugin");
    expect(line).toContain("event.name=plugin_loaded");
    expect(line).toContain("app.plugin.name=github");
    expect(line).toContain("app.plugin.capability_count=8");
  });
});
