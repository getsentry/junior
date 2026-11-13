import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createViewImageTool } from "@/chat/tools/sandbox/view-image";

const PNG_BYTES = await solidPng(4, 4);

function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#362d59" },
  })
    .png()
    .toBuffer();
}

/** Random pixels do not compress, so the PNG is about 3 bytes per pixel. */
function noisePng(width: number, height: number): Promise<Buffer> {
  return sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

async function returnedImage(result: unknown) {
  const { content } = result as {
    content: Array<{
      type: string;
      data?: string;
      text?: string;
      mimeType?: string;
    }>;
  };
  const image = content.find((part) => part.type === "image")!;
  const data = Buffer.from(image.data!, "base64");
  return {
    data,
    mimeType: image.mimeType,
    metadata: await sharp(data).metadata(),
    text: content.find((part) => part.type === "text")?.text,
  };
}

function workspace(data: Buffer | null): SandboxWorkspace {
  return {
    readFileToBuffer: vi.fn(async () => data),
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    })),
    writeFiles: vi.fn(async () => {}),
  };
}

describe("viewImage", () => {
  it("returns sandbox image bytes as Pi image content", async () => {
    const sandbox = workspace(PNG_BYTES);
    const tool = createViewImageTool(sandbox, () => true);

    await expect(tool.execute?.({ path: "preview.png" }, {})).resolves.toEqual({
      content: [
        {
          type: "image",
          data: PNG_BYTES.toString("base64"),
          mimeType: "image/png",
        },
      ],
    });
    expect(sandbox.readFileToBuffer).toHaveBeenCalledWith({
      path: "/vercel/sandbox/preview.png",
    });
  });

  it("checks the active model when the tool executes", async () => {
    let imageInputSupported = true;
    const sandbox = workspace(PNG_BYTES);
    const tool = createViewImageTool(sandbox, () => imageInputSupported);

    await expect(
      tool.execute?.({ path: "preview.png" }, {}),
    ).resolves.toBeDefined();

    imageInputSupported = false;
    await expect(tool.execute?.({ path: "preview.png" }, {})).rejects.toThrow(
      "current model does not support image inputs",
    );
    expect(sandbox.readFileToBuffer).toHaveBeenCalledTimes(1);
  });

  it("supports injected image reads without booting the sandbox", async () => {
    const sandbox = workspace(null);
    const readFile = vi.fn(async () => PNG_BYTES);
    const tool = createViewImageTool(sandbox, () => true, { readFile });

    await expect(tool.execute?.({ path: "preview.png" }, {})).resolves.toEqual({
      content: [
        {
          type: "image",
          data: PNG_BYTES.toString("base64"),
          mimeType: "image/png",
        },
      ],
    });
    expect(readFile).toHaveBeenCalledWith("/vercel/sandbox/preview.png");
    expect(sandbox.readFileToBuffer).not.toHaveBeenCalled();
  });

  it("rejects missing and unsupported files", async () => {
    const missingTool = createViewImageTool(workspace(null), () => true);
    await expect(
      missingTool.execute?.({ path: "missing.png" }, {}),
    ).rejects.toThrow("failed to read file: /vercel/sandbox/missing.png");

    const textTool = createViewImageTool(
      workspace(Buffer.from("not an image")),
      () => true,
    );
    await expect(textTool.execute?.({ path: "notes.txt" }, {})).rejects.toThrow(
      "not a readable image",
    );
  });

  it("scales wide images down to 2000 px on the longest side", async () => {
    const wide = await solidPng(4200, 288);
    const tool = createViewImageTool(workspace(wide), () => true);

    const image = await returnedImage(
      await tool.execute?.({ path: "wide.png" }, {}),
    );

    expect(image.metadata.width).toBe(2000);
    expect(image.metadata.height).toBe(137);
    expect(image.text).toBe(
      "Resized from 4200x288 to 2000x137 px to fit model image limits.",
    );
  });

  it("re-encodes images that are too many bytes for the model", async () => {
    // 1200x1200 noise is about 4.3 MB as PNG, over the 3.75 MB model limit.
    const heavy = await noisePng(1200, 1200);
    expect(heavy.byteLength).toBeGreaterThan(3_750_000);
    const tool = createViewImageTool(workspace(heavy), () => true);

    const image = await returnedImage(
      await tool.execute?.({ path: "heavy.png" }, {}),
    );

    expect(image.data.byteLength).toBeLessThanOrEqual(3_750_000);
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.metadata.format).toBe("jpeg");
  });

  it("rejects source files larger than the read limit", async () => {
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1);
    PNG_BYTES.copy(oversized);
    const tool = createViewImageTool(workspace(oversized), () => true);

    await expect(tool.execute?.({ path: "large.png" }, {})).rejects.toThrow(
      "image exceeds 26214400 bytes",
    );
  });

  it("rejects image data that cannot be decoded", async () => {
    const broken = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const tool = createViewImageTool(workspace(broken), () => true);

    await expect(tool.execute?.({ path: "broken.png" }, {})).rejects.toThrow(
      "its data cannot be decoded",
    );
  });
});
