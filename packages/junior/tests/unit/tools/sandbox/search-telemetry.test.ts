import { describe, expect, it, vi } from "vitest";
import { findFiles } from "@/chat/tools/sandbox/find-files";
import {
  type SandboxCommandRunner,
  type SandboxFileSystem,
} from "@/chat/tools/sandbox/file-utils";
import { grepFiles } from "@/chat/tools/sandbox/grep";


function asSandboxFileSystem(value: unknown): SandboxFileSystem {
  return value as SandboxFileSystem;
}

const directoryStat = { isDirectory: () => true };
const fs = asSandboxFileSystem({
  stat: async () => directoryStat,
});

describe("sandbox search telemetry", () => {
  it("reports bounded grep measurements", async () => {
    const onTelemetry = vi.fn();
    const runCommand: SandboxCommandRunner = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        type: "match",
        data: {
          path: { text: "app.ts" },
          lines: { text: "needle\n" },
          line_number: 1,
        },
      }),
    });

    await grepFiles({
      fs,
      onTelemetry,
      pattern: "needle",
      runCommand,
    });

    expect(onTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        emittedLineCount: 1,
        limit: 100,
        limitReached: false,
        parsedRecordCount: 1,
        resultCount: 1,
      }),
    );
  });

  it("reports bounded findFiles measurements", async () => {
    const onTelemetry = vi.fn();
    const runCommand: SandboxCommandRunner = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "src/app.ts\0",
    });

    await findFiles({
      fs,
      onTelemetry,
      pattern: "*.ts",
      runCommand,
    });

    expect(onTelemetry).toHaveBeenCalledWith({
      emittedLineCount: 1,
      limit: 100,
      limitReached: false,
      parsedRecordCount: 1,
      rawOutputBytes: 11,
      resultCount: 1,
      resultBytes: expect.any(Number),
    });
  });
});
