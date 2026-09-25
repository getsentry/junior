import { describe, expect, it, vi } from "vitest";
import { linearPlugin } from "../../../../junior-linear/src/index.js";
import type { AfterMcpToolHookContext } from "@sentry/junior-plugin-api";

function baseContext(
  overrides: Partial<AfterMcpToolHookContext> = {},
): AfterMcpToolHookContext {
  return {
    db: {},
    log: {
      error() {},
      info() {},
      warn() {},
    },
    plugin: { name: "linear" },
    result: {
      structuredContent: {
        issue: {
          identifier: "ENG-123",
          url: "https://linear.app/acme/issue/ENG-123/created",
        },
      },
    },
    tool: {
      arguments: {
        team: "Engineering",
        title: "Created issue",
      },
      name: "save_issue",
    },
    ...overrides,
  };
}

describe("linear afterMcpTool annotations", () => {
  it("logs and skips annotation when the response schema does not match", async () => {
    const warn = vi.fn();
    const upsert = vi.fn(async () => undefined);
    const plugin = linearPlugin();
    const hook = plugin.hooks?.afterMcpTool;
    if (!hook) {
      throw new Error("linear afterMcpTool hook is missing");
    }

    await hook(
      baseContext({
        annotations: {
          upsert,
          async remove() {},
          async list() {
            return [];
          },
        },
        log: {
          error() {},
          info() {},
          warn,
        },
        result: {
          structuredContent: { issue: { title: "Incomplete" } },
        },
      }),
    );

    expect(warn).toHaveBeenCalledWith("linear.issue_annotation.skipped", {
      "app.reason": "unexpected_save_response",
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});
