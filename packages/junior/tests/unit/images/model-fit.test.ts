import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  createContextImageFitter,
  fitModelImage,
} from "@/chat/images/model-fit";
import { readImageDimensions } from "@/chat/services/image-dimensions";

async function png(width: number, height: number): Promise<ImageContent> {
  const data = await sharp({
    create: { width, height, channels: 3, background: "#3366ff" },
  })
    .png()
    .toBuffer();
  return {
    type: "image",
    data: data.toString("base64"),
    mimeType: "image/png",
  };
}

// Random pixels do not compress, so the PNG data is large.
async function noisePng(width: number, height: number): Promise<ImageContent> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = Math.floor(Math.random() * 256);
  }
  const data = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return {
    type: "image",
    data: data.toString("base64"),
    mimeType: "image/png",
  };
}

describe("fitModelImage", () => {
  it("returns an image that fits unchanged", async () => {
    const image = await png(1200, 800);

    const fitted = await fitModelImage(image);

    expect(fitted.image).toBe(image);
    expect(fitted.scaled).toBeUndefined();
  });

  it("scales a wide image to the largest size that Claude reads", async () => {
    const fitted = await fitModelImage(await png(4200, 288));

    expect(fitted.scaled).toEqual({ from: [4200, 288], to: [2576, 177] });
    expect(fitted.image.mimeType).toBe("image/png");
    expect(readImageDimensions(fitted.image)).toEqual({
      width: 2576,
      height: 177,
    });
  });

  it("turns an image upright from its EXIF orientation when it scales it", async () => {
    // Orientation 6 shows the stored pixels a quarter turn clockwise, so the
    // red top half of the stored pixels is the right half when upright.
    const redTop = await sharp({
      create: { width: 4000, height: 1500, channels: 3, background: "#f00" },
    })
      .png()
      .toBuffer();
    const data = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: "#fff" },
    })
      .composite([{ input: redTop, top: 0, left: 0 }])
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const fitted = await fitModelImage({
      type: "image",
      data: data.toString("base64"),
      mimeType: "image/jpeg",
    });

    expect(fitted.scaled).toEqual({ from: [3000, 4000], to: [1659, 2212] });
    const output = sharp(Buffer.from(fitted.image.data, "base64"));
    expect((await output.metadata()).orientation ?? 1).toBe(1);
    const { data: pixels, info } = await output
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([1659, 2212]);
    const pixel = (x: number, y: number) => [
      ...pixels.subarray(
        (y * info.width + x) * 3,
        (y * info.width + x) * 3 + 3,
      ),
    ];
    const middle = Math.floor(info.height / 2);
    expect(pixel(info.width - 10, middle)[1]).toBeLessThan(50);
    expect(pixel(10, middle)[1]).toBeGreaterThan(200);
  });

  it("re-encodes image data that is too large as JPEG", async () => {
    const image = await noisePng(1600, 1600);
    expect(image.data.length).toBeGreaterThan(5_000_000);

    const fitted = await fitModelImage(image);

    expect(fitted.scaled).toBeUndefined();
    expect(fitted.image.mimeType).toBe("image/jpeg");
    expect(fitted.image.data.length).toBeLessThanOrEqual(5_000_000);
    expect(readImageDimensions(fitted.image)).toEqual({
      width: 1600,
      height: 1600,
    });
  });
});

describe("createContextImageFitter", () => {
  it("fits images in user and tool result messages and keeps other messages", async () => {
    const small = await png(100, 100);
    const wide = await png(4200, 288);
    const user = {
      role: "user",
      content: [{ type: "text", text: "look" }, small],
      timestamp: 1,
    } as AgentMessage;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "viewImage",
      content: [wide],
      isError: false,
      timestamp: 2,
    } as AgentMessage;
    const fit = createContextImageFitter();

    const first = await fit([user, toolResult]);
    const second = await fit([user, toolResult]);

    expect(first[0]).toBe(user);
    const fittedImage = (first[1] as { content: ImageContent[] }).content[0]!;
    expect(readImageDimensions(fittedImage)).toEqual({
      width: 2576,
      height: 177,
    });
    expect((toolResult as { content: ImageContent[] }).content[0]).toBe(wide);
    // The same image is fitted once, so each request sends the same bytes.
    expect((second[1] as { content: ImageContent[] }).content[0]).toBe(
      fittedImage,
    );
  });
});
