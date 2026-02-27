import { describe, expect, it, vi, beforeEach } from "vitest";

const filesUploadV2Mock = vi.fn();

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    filesUploadV2 = filesUploadV2Mock;
  }
}));

describe("uploadFilesToThread", () => {
  beforeEach(() => {
    filesUploadV2Mock.mockReset();
    filesUploadV2Mock.mockResolvedValue({ ok: true });
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  });

  it("calls filesUploadV2 with correct channel, thread, and file_uploads", async () => {
    const { uploadFilesToThread } = await import("@/chat/slack-actions/client");

    const testFile = {
      data: Buffer.from("image-data"),
      filename: "image.png",
      mimeType: "image/png"
    };

    await uploadFilesToThread({
      channelId: "C-test",
      threadTs: "1700000000.000",
      files: [testFile]
    });

    expect(filesUploadV2Mock).toHaveBeenCalledTimes(1);
    expect(filesUploadV2Mock).toHaveBeenCalledWith({
      channel_id: "C-test",
      thread_ts: "1700000000.000",
      file_uploads: [
        {
          file: testFile.data,
          filename: "image.png"
        }
      ]
    });
  });

  it("passes multiple files correctly", async () => {
    const { uploadFilesToThread } = await import("@/chat/slack-actions/client");

    const files = [
      { data: Buffer.from("img1"), filename: "a.png", mimeType: "image/png" },
      { data: Buffer.from("img2"), filename: "b.jpg" }
    ];

    await uploadFilesToThread({
      channelId: "C-multi",
      threadTs: "1700000001.000",
      files
    });

    expect(filesUploadV2Mock).toHaveBeenCalledWith({
      channel_id: "C-multi",
      thread_ts: "1700000001.000",
      file_uploads: [
        { file: files[0].data, filename: "a.png" },
        { file: files[1].data, filename: "b.jpg" }
      ]
    });
  });
});
