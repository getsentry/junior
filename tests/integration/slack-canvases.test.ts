import { beforeEach, describe, expect, it } from "vitest";
import { createCanvas } from "@/chat/slack-actions/canvases";
import { canvasesCreateOk, conversationsCanvasesCreateOk, filesInfoOk } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
  queueSlackRateLimit
} from "../msw/handlers/slack-api";

describe("createCanvas", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
  });

  it("uses canvases.create for DM channels", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_DM" })
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F_DM",
        permalink: "https://example.invalid/files/F_DM"
      })
    });

    const created = await createCanvas({
      title: "Title",
      markdown: "Body",
      channelId: "D12345"
    });

    expect(created).toEqual({
      canvasId: "F_DM",
      permalink: "https://example.invalid/files/F_DM"
    });

    const canvasCreateCalls = getCapturedSlackApiCalls("canvases.create");
    expect(canvasCreateCalls).toHaveLength(1);
    expect(canvasCreateCalls[0]?.params).toMatchObject({
      title: "Title",
      document_content: {
        type: "markdown",
        markdown: "Body"
      }
    });

    expect(getCapturedSlackApiCalls("conversations.canvases.create")).toHaveLength(0);

    const fileInfoCalls = getCapturedSlackApiCalls("files.info");
    expect(fileInfoCalls).toHaveLength(1);
    expect(fileInfoCalls[0]?.params).toMatchObject({ file: "F_DM" });
  });

  it("uses conversations.canvases.create for C/G channels", async () => {
    queueSlackApiResponse("conversations.canvases.create", {
      body: conversationsCanvasesCreateOk({ canvasId: "F_CHANNEL" })
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({ fileId: "F_CHANNEL", permalink: "https://example.invalid/files/F_CHANNEL" })
    });

    const created = await createCanvas({
      title: "Title",
      markdown: "Body",
      channelId: "C12345"
    });

    expect(created).toEqual({
      canvasId: "F_CHANNEL",
      permalink: "https://example.invalid/files/F_CHANNEL"
    });

    const conversationCanvasCalls = getCapturedSlackApiCalls("conversations.canvases.create");
    expect(conversationCanvasCalls).toHaveLength(1);
    expect(conversationCanvasCalls[0]?.params).toMatchObject({
      channel_id: "C12345",
      title: "Title",
      document_content: {
        type: "markdown",
        markdown: "Body"
      }
    });

    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(0);
  });

  it("uses canvases.create when channel id is not provided", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_NO_CHANNEL" })
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({ fileId: "F_NO_CHANNEL", permalink: "https://example.invalid/files/F_NO_CHANNEL" })
    });

    const created = await createCanvas({
      title: "Title",
      markdown: "Body"
    });

    expect(created).toEqual({
      canvasId: "F_NO_CHANNEL",
      permalink: "https://example.invalid/files/F_NO_CHANNEL"
    });

    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("conversations.canvases.create")).toHaveLength(0);
  });

  it("returns created canvas when permalink lookup fails", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_NO_LINK" })
    });
    queueSlackApiError("files.info", {
      error: "internal_error"
    });

    const created = await createCanvas({
      title: "Title",
      markdown: "Body",
      channelId: "D12345"
    });

    expect(created).toEqual({
      canvasId: "F_NO_LINK",
      permalink: undefined
    });
    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("files.info")).toHaveLength(1);
  });

  it("retries conversation canvas creation after rate limit", async () => {
    queueSlackRateLimit("conversations.canvases.create", 0);
    queueSlackApiResponse("conversations.canvases.create", {
      body: conversationsCanvasesCreateOk({ canvasId: "F_RETRIED" })
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({ fileId: "F_RETRIED", permalink: "https://example.invalid/files/F_RETRIED" })
    });

    const created = await createCanvas({
      title: "Retry test",
      markdown: "Body",
      channelId: "C12345"
    });

    expect(created).toEqual({
      canvasId: "F_RETRIED",
      permalink: "https://example.invalid/files/F_RETRIED"
    });
    expect(getCapturedSlackApiCalls("conversations.canvases.create")).toHaveLength(2);
  });
});
