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
    ).toBe("Running pnpm test");
    expect(
      respondStatusFormatters.formatToolResultStatusWithInput("bash", {
        command: "pnpm test",
      }),
    ).toBe("Reviewed results from pnpm test");
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
