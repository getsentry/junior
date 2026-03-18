import { describe, expect, it } from "vitest";

import { respondStatusFormatters } from "@/chat/respond";

describe("respond status formatters", () => {
  it("avoids infrastructure language in shell statuses", () => {
    expect(respondStatusFormatters.formatToolStatus("bash")).toBe(
      "Working in the shell",
    );
    expect(
      respondStatusFormatters.formatToolStatusWithInput("bash", {
        command: "pnpm test",
      }),
    ).toBe("Running pnpm");
    expect(
      respondStatusFormatters.formatToolResultStatusWithInput("bash", {
        command: "pnpm test",
      }),
    ).toBe("Reviewed results from pnpm");
    expect(
      respondStatusFormatters.formatToolStatusWithInput("bash", {
        command: 'CI=1 DEBUG=1 "/usr/local/bin/pnpm" test',
      }),
    ).toBe("Running pnpm");
  });

  it("keeps file statuses free of sandbox wording", () => {
    expect(
      respondStatusFormatters.formatToolStatusWithInput("readFile", {
        path: "/workspace/src/app.ts",
      }),
    ).toBe("Reading file app.ts");
    expect(
      respondStatusFormatters.formatToolStatusWithInput("writeFile", {
        path: "/workspace/src/app.ts",
      }),
    ).toBe("Updating file app.ts");
    expect(
      respondStatusFormatters.formatToolResultStatusWithInput("writeFile", {
        path: "/workspace/src/app.ts",
      }),
    ).toBe("Updated file app.ts");
  });
});
