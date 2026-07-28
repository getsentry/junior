import { describe, expect, it, vi } from "vitest";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { createViewImageTool } from "@/chat/tools/sandbox/view-image";

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

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
      "unsupported image format",
    );
  });

  it("rejects images larger than the vision attachment limit", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
    PNG_BYTES.copy(oversized);
    const tool = createViewImageTool(workspace(oversized), () => true);

    await expect(tool.execute?.({ path: "large.png" }, {})).rejects.toThrow(
      "image exceeds 5242880 bytes",
    );
  });
});
