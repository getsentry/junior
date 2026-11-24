import type { FileUpload } from "chat";
import { describe, expect, it } from "vitest";
import { writeSandboxGeneratedFiles } from "@/chat/sandbox/generated-files";
import { SANDBOX_GENERATED_DIR } from "@/chat/sandbox/file-uploads";

function createGeneratedFileSandbox() {
  const files = new Map<string, string | Uint8Array>();
  return {
    files,
    workspace: {
      writeFiles: async (
        writtenFiles: Array<{ content: string | Uint8Array; path: string }>,
      ) => {
        for (const file of writtenFiles) {
          files.set(file.path, file.content);
        }
      },
    },
  };
}

function upload(content: string, filename: string): FileUpload {
  return {
    data: Buffer.from(content),
    filename,
    mimeType: "image/png",
  };
}

describe("writeSandboxGeneratedFiles", () => {
  it("writes each file under a content hash directory with its original name", async () => {
    const fixture = createGeneratedFileSandbox();

    const refs = await writeSandboxGeneratedFiles(fixture.workspace, [
      upload("image-bytes", "generated.png"),
    ]);

    expect(refs).toEqual([
      {
        bytes: Buffer.from("image-bytes").byteLength,
        filename: "generated.png",
        mime_type: "image/png",
        path: expect.stringMatching(
          new RegExp(`^${SANDBOX_GENERATED_DIR}/[0-9a-f]{12}/generated\\.png$`),
        ),
      },
    ]);
    expect(fixture.files.get(refs[0]!.path)).toEqual(
      Buffer.from("image-bytes"),
    );
  });

  it("keeps files with the same name and different content apart", async () => {
    const fixture = createGeneratedFileSandbox();

    const refs = await writeSandboxGeneratedFiles(fixture.workspace, [
      upload("first", "logo.png"),
      upload("second", "logo.png"),
    ]);

    expect(refs[0]!.path).not.toBe(refs[1]!.path);
    expect(fixture.files.get(refs[0]!.path)).toEqual(Buffer.from("first"));
    expect(fixture.files.get(refs[1]!.path)).toEqual(Buffer.from("second"));
  });

  it("cuts a long name and keeps its extension", async () => {
    const fixture = createGeneratedFileSandbox();

    const [ref] = await writeSandboxGeneratedFiles(fixture.workspace, [
      upload("image-bytes", `${"a".repeat(200)}.png`),
    ]);

    const name = ref!.path.split("/").pop()!;
    expect(name).toBe(`${"a".repeat(56)}.png`);
    expect(ref!.filename).toBe(`${"a".repeat(200)}.png`);
  });
});
