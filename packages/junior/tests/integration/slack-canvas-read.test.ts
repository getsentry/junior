import { beforeEach, describe, expect, it } from "vitest";
import { createSlackCanvasReadTool } from "@/chat/tools/slack/canvas-tools";
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
});
