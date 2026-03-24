import { describe, expect, it } from "vitest";
import { enforceAttachmentClaimTruth } from "@/chat/services/attachment-claims";

describe("enforceAttachmentClaimTruth", () => {
  it("keeps normal responses unchanged when no attachment claim exists", () => {
    const text = "Screenshot captured. Title: Example";
    expect(enforceAttachmentClaimTruth(text, false)).toBe(text);
  });

  it("keeps attachment claim responses unchanged when files are attached", () => {
    const text = "Here's the screenshot. The image is attached below.";
    expect(enforceAttachmentClaimTruth(text, true)).toBe(text);
  });

  it("adds corrective note when response claims attachment without files", () => {
    const text =
      "Here's the real screenshot of https://example.com.\n\nScreenshot attached below.";
    const result = enforceAttachmentClaimTruth(text, false);

    expect(result).toContain("No file was attached in this turn.");
    expect(result).toContain("attach the file");
    expect(result).not.toContain("attachFile");
  });
});
