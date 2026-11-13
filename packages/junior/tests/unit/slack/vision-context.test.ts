import type { Attachment } from "chat";
import { describe, expect, it } from "vitest";
import { createJuniorRuntimeServices } from "@/chat/app/services";

function textFile(name: string, fetchData?: () => Promise<Buffer>): Attachment {
  return {
    type: "file",
    mimeType: "text/plain",
    name,
    ...(fetchData ? { fetchData } : { data: Buffer.from(name) }),
  };
}

describe("resolveUserAttachments", () => {
  // No file is an image, so the service has no work for the vision model.
  const { resolveUserAttachments } =
    createJuniorRuntimeServices().visionContext;

  it("never inlines file bytes and stops at three files", async () => {
    const attachments = await resolveUserAttachments(
      [
        textFile("unstored.txt"),
        textFile("unreadable.txt", async () => {
          throw new Error("download failed");
        }),
        textFile("third.txt"),
        textFile("fourth.txt"),
      ],
      {},
    );

    // The failed download counts as one of the three files of a turn.
    expect(attachments.map((attachment) => attachment.filename)).toEqual([
      "unstored.txt",
      "unreadable.txt",
      "third.txt",
    ]);
    expect(attachments.every((attachment) => !attachment.data)).toBe(true);
    // Without storage, the agent has no attachment id to load.
    expect(attachments[0]?.promptText).toContain("could not be stored");
    expect(attachments[1]?.promptText).toContain(
      "could not download its content",
    );
  });
});
