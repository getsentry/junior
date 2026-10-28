import { describe, expect, it } from "vitest";
import { detectImageMediaType } from "@/chat/attachments/media";

describe("detectImageMediaType", () => {
  it("detects accepted image types from their file signatures", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([1, 2, 3, 4]),
      Buffer.from("WEBPVP8 "),
    ]);

    expect(
      detectImageMediaType(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      ),
    ).toBe("image/png");
    expect(detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
    expect(detectImageMediaType(Buffer.from("GIF87a..."))).toBe("image/gif");
    expect(detectImageMediaType(Buffer.from("GIF89a..."))).toBe("image/gif");
    expect(detectImageMediaType(webp)).toBe("image/webp");
  });

  it("rejects other files and truncated signatures", () => {
    expect(
      detectImageMediaType(Buffer.from("RIFF\0\0\0\0WAVE")),
    ).toBeUndefined();
    expect(detectImageMediaType(Buffer.from("GIF8"))).toBeUndefined();
    expect(detectImageMediaType(Buffer.from("not an image"))).toBeUndefined();
  });
});
