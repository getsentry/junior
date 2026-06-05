import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOauthResumeSlackFixture,
  makeResumeDiagnostics,
} from "../../fixtures/oauth-resume-slack";
import {
  getCapturedSlackApiCalls,
  getCapturedSlackFileUploadCalls,
  queueSlackApiError,
} from "../../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createOauthResumeSlackFixture>>;

describe("oauth resume slack file delivery", () => {
  beforeEach(async () => {
    testbed = await createOauthResumeSlackFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("delivers resumed reply files through the shared reply planner", async () => {
    await testbed.resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.004",
      connectedText: "Connected. Continuing...",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        requester: { userId: "U123" },
      },
      generateReply: async () =>
        ({
          text: "Here is the resumed artifact.",
          files: [
            {
              data: Buffer.from("resume-file"),
              filename: "resume.txt",
            },
          ],
          diagnostics: makeResumeDiagnostics(),
        }) as any,
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(2);
    expect(postCalls[0]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.004",
      text: "Connected. Continuing...",
    });
    expect(postCalls[1]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.004",
      text: "Here is the resumed artifact.",
    });
    expect(getCapturedSlackApiCalls("files.getUploadURLExternal")).toHaveLength(
      1,
    );
    expect(getCapturedSlackApiCalls("files.completeUploadExternal")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.004",
        }),
      }),
    ]);
    expect(getCapturedSlackFileUploadCalls()).toHaveLength(1);
  });

  it("keeps the resumed reply visible when file upload followups fail", async () => {
    queueSlackApiError("files.completeUploadExternal", {
      error: "upload_failed",
    });

    await testbed.resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.005",
      connectedText: "Connected. Continuing...",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        requester: { userId: "U123" },
      },
      generateReply: async () =>
        ({
          text: "Here is the resumed artifact.",
          files: [
            {
              data: Buffer.from("resume-file"),
              filename: "resume.txt",
            },
          ],
          diagnostics: makeResumeDiagnostics(),
        }) as any,
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.005",
          text: "Connected. Continuing...",
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.005",
          text: "Here is the resumed artifact.",
        }),
      }),
    ]);
    expect(getCapturedSlackApiCalls("files.getUploadURLExternal")).toHaveLength(
      1,
    );
    expect(
      getCapturedSlackApiCalls("files.completeUploadExternal"),
    ).toHaveLength(1);
  });
});
