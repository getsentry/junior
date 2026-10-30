import { beforeEach, describe, expect, it } from "vitest";
import { createCanvas } from "@/chat/slack/tool-support/canvas/api";
import {
  authTestOk,
  canvasesAccessSetOk,
  canvasesCreateOk,
  conversationsInfoOk,
  conversationsMembersOk,
  filesInfoOk,
} from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
  queueSlackRateLimit,
} from "../msw/handlers/slack-api";

describe("createCanvas", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN =
      process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
  });

  it("grants DM members write access by user id because Slack rejects DM channel ids", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_DM" }),
    });
    queueSlackApiResponse("auth.test", {
      body: authTestOk({ userId: "U_JUNIOR" }),
    });
    queueSlackApiResponse("conversations.members", {
      body: conversationsMembersOk({ members: ["U_JUNIOR", "U_HUMAN"] }),
    });
    queueSlackApiResponse("canvases.access.set", {
      body: canvasesAccessSetOk(),
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F_DM",
        permalink: "https://example.invalid/files/F_DM",
      }),
    });

    const created = await createCanvas({
      title: "Title",
      markdown: "Body",
      channelId: "D12345",
    });

    expect(created).toEqual({
      canvasId: "F_DM",
      permalink: "https://example.invalid/files/F_DM",
    });
    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(1);
    expect(
      getCapturedSlackApiCalls("conversations.members")[0]?.params,
    ).toMatchObject({ channel: "D12345" });

    const accessCalls = getCapturedSlackApiCalls("canvases.access.set");
    expect(accessCalls).toHaveLength(1);
    expect(accessCalls[0]?.params).toMatchObject({
      canvas_id: "F_DM",
      access_level: "write",
      user_ids: ["U_HUMAN"],
    });
    expect(accessCalls[0]?.params).not.toHaveProperty("channel_ids");

    expect(
      getCapturedSlackApiCalls("conversations.canvases.create"),
    ).toHaveLength(0);
  });

  it("grants group DM members write access by user id", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_MPIM" }),
    });
    queueSlackApiResponse("conversations.info", {
      body: conversationsInfoOk({ channelId: "G12345", isMpim: true }),
    });
    queueSlackApiResponse("auth.test", {
      body: authTestOk({ userId: "U_JUNIOR" }),
    });
    queueSlackApiResponse("conversations.members", {
      body: conversationsMembersOk({
        members: ["U_ALICE", "U_JUNIOR", "U_BOB"],
      }),
    });
    queueSlackApiResponse("canvases.access.set", {
      body: canvasesAccessSetOk(),
    });

    await createCanvas({
      title: "Title",
      markdown: "Body",
      channelId: "G12345",
    });

    const accessCalls = getCapturedSlackApiCalls("canvases.access.set");
    expect(accessCalls).toHaveLength(1);
    expect(accessCalls[0]?.params).toMatchObject({
      canvas_id: "F_MPIM",
      access_level: "write",
      user_ids: ["U_ALICE", "U_BOB"],
    });
    expect(accessCalls[0]?.params).not.toHaveProperty("channel_ids");
  });

  it("grants channel write access after canvases.create for C/G channels", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_CHANNEL" }),
    });
    queueSlackApiResponse("canvases.access.set", {
      body: canvasesAccessSetOk(),
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F_CHANNEL",
        permalink: "https://example.invalid/files/F_CHANNEL",
      }),
    });

    const created = await createCanvas({
      title: "Title",
      markdown: "Body",
      channelId: "C12345",
    });

    expect(created).toEqual({
      canvasId: "F_CHANNEL",
      permalink: "https://example.invalid/files/F_CHANNEL",
    });

    const canvasCreateCalls = getCapturedSlackApiCalls("canvases.create");
    expect(canvasCreateCalls).toHaveLength(1);
    expect(canvasCreateCalls[0]?.params).toMatchObject({
      title: "Title",
      document_content: {
        type: "markdown",
        markdown: "Body",
      },
    });
    expect(canvasCreateCalls[0]?.params).not.toHaveProperty("channel_id");

    const accessCalls = getCapturedSlackApiCalls("canvases.access.set");
    expect(accessCalls).toHaveLength(1);
    expect(accessCalls[0]?.params).toMatchObject({
      canvas_id: "F_CHANNEL",
      access_level: "write",
      channel_ids: ["C12345"],
    });

    expect(
      getCapturedSlackApiCalls("conversations.canvases.create"),
    ).toHaveLength(0);
  });

  it("succeeds when access.set fails (best-effort grant)", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_ACCESS_FAIL" }),
    });
    queueSlackApiError("canvases.access.set", {
      error: "not_in_channel",
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F_ACCESS_FAIL",
        permalink: "https://example.invalid/files/F_ACCESS_FAIL",
      }),
    });

    const created = await createCanvas({
      title: "Title",
      markdown: "Body",
      channelId: "C12345",
    });

    expect(created).toEqual({
      canvasId: "F_ACCESS_FAIL",
      permalink: "https://example.invalid/files/F_ACCESS_FAIL",
    });
    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("canvases.access.set")).toHaveLength(1);
  });

  it("creates a standalone canvas when no channel id is provided", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_STANDALONE" }),
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F_STANDALONE",
        permalink: "https://example.invalid/files/F_STANDALONE",
      }),
    });

    const created = await createCanvas({
      title: "Title",
      markdown: "Body",
    });

    expect(created).toEqual({
      canvasId: "F_STANDALONE",
      permalink: "https://example.invalid/files/F_STANDALONE",
    });
    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("canvases.access.set")).toHaveLength(0);
  });

  it("normalizes rejected markdown before canvas create", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_NORM" }),
    });
    queueSlackApiResponse("canvases.access.set", {
      body: canvasesAccessSetOk(),
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F_NORM",
        permalink: "https://example.invalid/files/F_NORM",
      }),
    });

    await createCanvas({
      title: "Title",
      markdown: "#### Deep heading\n1. Parent\n   - Child\n   > Quoted child",
      channelId: "C12345",
    });

    const canvasCreateCalls = getCapturedSlackApiCalls("canvases.create");
    expect(canvasCreateCalls).toHaveLength(1);
    expect(canvasCreateCalls[0]?.params).toMatchObject({
      document_content: {
        type: "markdown",
        markdown: "### Deep heading\n1. Parent\n   • Child\n   Quoted child",
      },
    });
  });

  it("returns created canvas when permalink lookup fails", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_NO_LINK" }),
    });
    queueSlackApiResponse("canvases.access.set", {
      body: canvasesAccessSetOk(),
    });
    queueSlackApiError("files.info", {
      error: "internal_error",
    });

    const created = await createCanvas({
      title: "Title",
      markdown: "Body",
      channelId: "C12345",
    });

    expect(created).toEqual({
      canvasId: "F_NO_LINK",
      permalink: undefined,
    });
    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("files.info")).toHaveLength(1);
  });

  it("retries canvas creation after rate limit", async () => {
    queueSlackRateLimit("canvases.create", 0);
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "F_RETRIED" }),
    });
    queueSlackApiResponse("canvases.access.set", {
      body: canvasesAccessSetOk(),
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "F_RETRIED",
        permalink: "https://example.invalid/files/F_RETRIED",
      }),
    });

    const created = await createCanvas({
      title: "Retry test",
      markdown: "Body",
      channelId: "C12345",
    });

    expect(created).toEqual({
      canvasId: "F_RETRIED",
      permalink: "https://example.invalid/files/F_RETRIED",
    });
    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(2);
  });
});
