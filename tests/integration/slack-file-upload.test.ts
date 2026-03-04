import { beforeEach, describe, expect, it } from "vitest";
import { uploadFilesToThread } from "@/chat/slack-actions/client";
import { filesCompleteUploadOk, filesGetUploadUrlOk } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  getCapturedSlackFileUploadCalls,
  queueSlackApiError,
  queueSlackApiResponse,
  queueSlackRateLimit
} from "../msw/handlers/slack-api";

describe("uploadFilesToThread", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
  });

  it("calls Slack file upload endpoints with correct channel, thread, and file metadata", async () => {
    queueSlackApiResponse("files.getUploadURLExternal", {
      body: filesGetUploadUrlOk({
        fileId: "F_TEST_1",
        uploadUrl: "https://files.slack.com/upload/v1/F_TEST_1"
      })
    });
    queueSlackApiResponse("files.completeUploadExternal", {
      body: filesCompleteUploadOk({
        files: [{ id: "F_TEST_1" }]
      })
    });

    const testFile = {
      data: Buffer.from("image-data"),
      filename: "image.png"
    };

    await uploadFilesToThread({
      channelId: "C-test",
      threadTs: "1700000000.000",
      files: [testFile]
    });

    const uploadUrlCalls = getCapturedSlackApiCalls("files.getUploadURLExternal");
    expect(uploadUrlCalls).toHaveLength(1);
    expect(uploadUrlCalls[0]?.params).toMatchObject({
      filename: "image.png",
      length: String(testFile.data.length)
    });

    const externalUploadCalls = getCapturedSlackFileUploadCalls();
    expect(externalUploadCalls).toHaveLength(1);
    expect(externalUploadCalls[0]?.byteLength).toBeGreaterThan(0);

    const completeCalls = getCapturedSlackApiCalls("files.completeUploadExternal");
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]?.params).toMatchObject({
      channel_id: "C-test",
      thread_ts: "1700000000.000"
    });
    expect(completeCalls[0]?.params.files).toEqual([
      {
        id: "F_TEST_1",
        title: "image.png"
      }
    ]);
  });

  it("uploads multiple files and posts both to Slack external upload URLs", async () => {
    queueSlackApiResponse("files.getUploadURLExternal", {
      body: filesGetUploadUrlOk({
        fileId: "F_TEST_1",
        uploadUrl: "https://files.slack.com/upload/v1/F_TEST_1"
      })
    });
    queueSlackApiResponse("files.getUploadURLExternal", {
      body: filesGetUploadUrlOk({
        fileId: "F_TEST_2",
        uploadUrl: "https://files.slack.com/upload/v1/F_TEST_2"
      })
    });
    queueSlackApiResponse("files.completeUploadExternal", {
      body: filesCompleteUploadOk({
        files: [{ id: "F_TEST_1" }, { id: "F_TEST_2" }]
      })
    });

    const files = [
      { data: Buffer.from("img1"), filename: "a.png" },
      { data: Buffer.from("img2"), filename: "b.jpg" }
    ];

    await uploadFilesToThread({
      channelId: "C-multi",
      threadTs: "1700000001.000",
      files
    });

    const uploadUrlCalls = getCapturedSlackApiCalls("files.getUploadURLExternal");
    expect(uploadUrlCalls).toHaveLength(2);
    expect(uploadUrlCalls[0]?.params).toMatchObject({ filename: "a.png", length: String(files[0].data.length) });
    expect(uploadUrlCalls[1]?.params).toMatchObject({ filename: "b.jpg", length: String(files[1].data.length) });

    const externalUploadCalls = getCapturedSlackFileUploadCalls();
    expect(externalUploadCalls).toHaveLength(2);

    const completeCalls = getCapturedSlackApiCalls("files.completeUploadExternal");
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]?.params).toMatchObject({
      channel_id: "C-multi",
      thread_ts: "1700000001.000"
    });
    expect(completeCalls[0]?.params.files).toEqual([
      { id: "F_TEST_1", title: "a.png" },
      { id: "F_TEST_2", title: "b.jpg" }
    ]);
  });

  it("retries getUploadURLExternal after rate limit and still uploads file", async () => {
    queueSlackRateLimit("files.getUploadURLExternal", 0);
    queueSlackApiResponse("files.getUploadURLExternal", {
      body: filesGetUploadUrlOk({
        fileId: "F_RETRY",
        uploadUrl: "https://files.slack.com/upload/v1/F_RETRY"
      })
    });
    queueSlackApiResponse("files.completeUploadExternal", {
      body: filesCompleteUploadOk({
        files: [{ id: "F_RETRY" }]
      })
    });

    await uploadFilesToThread({
      channelId: "C-retry",
      threadTs: "1700000002.000",
      files: [{ data: Buffer.from("retry-data"), filename: "retry.png" }]
    });

    expect(getCapturedSlackApiCalls("files.getUploadURLExternal")).toHaveLength(2);
    expect(getCapturedSlackFileUploadCalls()).toHaveLength(1);
    expect(getCapturedSlackApiCalls("files.completeUploadExternal")).toHaveLength(1);
  });

  it("throws missing_scope when completeUploadExternal fails", async () => {
    queueSlackApiResponse("files.getUploadURLExternal", {
      body: filesGetUploadUrlOk({
        fileId: "F_SCOPE",
        uploadUrl: "https://files.slack.com/upload/v1/F_SCOPE"
      })
    });
    queueSlackApiError("files.completeUploadExternal", {
      error: "missing_scope",
      needed: "files:write",
      provided: "chat:write"
    });

    await expect(
      uploadFilesToThread({
        channelId: "C-scope",
        threadTs: "1700000003.000",
        files: [{ data: Buffer.from("scope-data"), filename: "scope.png" }]
      })
    ).rejects.toMatchObject({
      name: "SlackActionError",
      code: "missing_scope",
      needed: "files:write",
      provided: "chat:write"
    });
  });
});
