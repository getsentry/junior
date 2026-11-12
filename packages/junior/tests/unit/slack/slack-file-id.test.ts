import { describe, expect, it } from "vitest";
import { getSlackFileId } from "@/chat/slack/attachments";

describe("getSlackFileId", () => {
  it("reads the file id from a Slack private file URL", () => {
    expect(
      getSlackFileId({
        type: "file",
        url: "https://files.slack.com/files-pri/T024ZCV9U-F0CH5D0KRUZ/x.png",
      }),
    ).toBe("F0CH5D0KRUZ");
  });
});
