import { beforeEach, describe, expect, it } from "vitest";
import { createSlackCanvasReadTool } from "@/chat/slack/tools/canvas/read";
import { filesInfoOk } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
  queueSlackPrivateFileDownload,
} from "../msw/handlers/slack-api";

describe("createSlackCanvasReadTool", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN =
      process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
  });

  it("reads canvas content from a Slack canvas URL", async () => {
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F0AU9MRL63T",
        title: "Issue with GitHub tools",
        permalink: "https://sentry.slack.com/docs/T024ZCV9U/F0AU9MRL63T",
        urlPrivate:
          "https://files.slack.com/files-pri/T024ZCV9U-F0AU9MRL63T/issue.md",
        filetype: "quip",
        mimetype: "text/plain",
      }),
    });
    queueSlackPrivateFileDownload({
      status: 200,
      body: "# Issue with GitHub tools\n\nBody text",
    });

    const tool = createSlackCanvasReadTool();
    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasRead execute function missing");
    }

    const result = await tool.execute(
      { canvas: "https://sentry.slack.com/docs/T024ZCV9U/F0AU9MRL63T" },
      {} as never,
    );

    expect(result).toMatchObject({
      ok: true,
      canvas_id: "F0AU9MRL63T",
      title: "Issue with GitHub tools",
      permalink: "https://sentry.slack.com/docs/T024ZCV9U/F0AU9MRL63T",
      filetype: "quip",
      mimetype: "text/plain",
      truncated: false,
      content: "# Issue with GitHub tools\n\nBody text",
    });

    const infoCalls = getCapturedSlackApiCalls("files.info");
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]?.params).toMatchObject({ file: "F0AU9MRL63T" });
  });

  it("reads canvas content from a bare canvas ID", async () => {
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F0ABCDEF",
        urlPrivate: "https://files.slack.com/files-pri/T000-F0ABCDEF/canvas.md",
      }),
    });
    queueSlackPrivateFileDownload({
      status: 200,
      body: "canvas body",
    });

    const tool = createSlackCanvasReadTool();
    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasRead execute function missing");
    }

    const result = await tool.execute({ canvas: "F0ABCDEF" }, {} as never);

    expect(result).toMatchObject({
      ok: true,
      canvas_id: "F0ABCDEF",
      content: "canvas body",
    });
  });

  it("reads a bounded line range and exposes continuation details", async () => {
    const body = Array.from(
      { length: 1005 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F0LONG",
        urlPrivate: "https://files.slack.com/files-pri/T000-F0LONG/canvas.md",
      }),
    });
    queueSlackPrivateFileDownload({ status: 200, body });

    const tool = createSlackCanvasReadTool();
    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasRead execute function missing");
    }

    const result = (await tool.execute({ canvas: "F0LONG" }, {} as never)) as {
      ok: true;
      truncated: boolean;
      content: string;
      original_byte_length: number;
      start_line: number;
      end_line: number;
      total_lines: number;
      continuation?: {
        arguments: Record<string, unknown>;
        reason?: string;
      };
    };

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content).toBe(
      Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`).join(
        "\n",
      ),
    );
    expect(result.start_line).toBe(1);
    expect(result.end_line).toBe(1000);
    expect(result.total_lines).toBe(1005);
    expect(result.continuation).toEqual({
      arguments: {
        canvas: "F0LONG",
        offset: 1001,
        limit: 1000,
      },
      reason: "file has more lines",
    });
    expect(result.original_byte_length).toBe(body.length);
  });

  it("reads a requested line window", async () => {
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F0WINDOW",
        urlPrivate: "https://files.slack.com/files-pri/T000-F0WINDOW/canvas.md",
      }),
    });
    queueSlackPrivateFileDownload({
      status: 200,
      body: "one\ntwo\nthree\nfour",
    });

    const tool = createSlackCanvasReadTool();
    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasRead execute function missing");
    }

    const result = await tool.execute(
      { canvas: "F0WINDOW", offset: 2, limit: 2 },
      {} as never,
    );

    expect(result).toMatchObject({
      ok: true,
      canvas_id: "F0WINDOW",
      content: "two\nthree",
      start_line: 2,
      end_line: 3,
      total_lines: 4,
      truncated: true,
      continuation: {
        arguments: {
          canvas: "F0WINDOW",
          offset: 4,
          limit: 2,
        },
      },
    });
  });

  it("normalizes lowercase canvas IDs", async () => {
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F0LOWER",
        urlPrivate: "https://files.slack.com/files-pri/T000-F0LOWER/canvas.md",
      }),
    });
    queueSlackPrivateFileDownload({
      status: 200,
      body: "lowercase artifact id body",
    });

    const tool = createSlackCanvasReadTool();
    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasRead execute function missing");
    }

    const result = await tool.execute({ canvas: "f0lower" }, {} as never);

    expect(result).toMatchObject({
      ok: true,
      canvas_id: "F0LOWER",
      content: "lowercase artifact id body",
    });
  });

  it("returns an error when canvas input is unparseable", async () => {
    const tool = createSlackCanvasReadTool();
    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasRead execute function missing");
    }

    const result = await tool.execute(
      { canvas: "https://example.com/not-a-canvas" },
      {} as never,
    );

    expect(result).toMatchObject({ ok: false });
    expect(getCapturedSlackApiCalls("files.info")).toHaveLength(0);
  });

  it("returns an error when files.info fails", async () => {
    queueSlackApiError("files.info", { error: "not_found" });

    const tool = createSlackCanvasReadTool();
    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasRead execute function missing");
    }

    const result = await tool.execute(
      { canvas: "https://sentry.slack.com/docs/T024ZCV9U/F0AU9MRL63T" },
      {} as never,
    );

    expect(result).toMatchObject({
      ok: false,
      canvas_id: "F0AU9MRL63T",
    });
  });

  it("returns an error when canvas has no downloadable URL", async () => {
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({ fileId: "F0ABCDEF" }),
    });

    const tool = createSlackCanvasReadTool();
    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasRead execute function missing");
    }

    const result = await tool.execute({ canvas: "F0ABCDEF" }, {} as never);

    expect(result).toMatchObject({ ok: false, canvas_id: "F0ABCDEF" });
  });

  it("rejects non-Canvas Slack files before download", async () => {
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F0SCRIPT",
        filetype: "javascript",
        mimetype: "application/javascript",
        urlPrivate: "https://files.slack.com/files-pri/T000-F0SCRIPT/app.js",
      }),
    });

    const tool = createSlackCanvasReadTool();
    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasRead execute function missing");
    }

    const result = await tool.execute({ canvas: "F0SCRIPT" }, {} as never);

    expect(result).toMatchObject({ ok: false, canvas_id: "F0SCRIPT" });
    expect((result as { error: string }).error).toContain("Canvas document");
  });
});
