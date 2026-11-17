import pLimit from "p-limit";
import { FAN_OUT_CONCURRENCY } from "@/chat/fan-out";
import type { FileUpload } from "chat";
import {
  sandboxGeneratedFilePath,
  type GeneratedFileRef,
} from "@/chat/tools/sandbox/file-uploads";

/** Workspace operations needed to make generated files visible to later tools. */
export interface GeneratedFileWorkspace {
  writeFiles(
    files: Array<{
      content: string | Uint8Array;
      path: string;
    }>,
  ): Promise<void>;
}

async function fileUploadDataToBuffer(
  data: FileUpload["data"],
): Promise<Buffer> {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(await data.arrayBuffer());
}

/** Write generated files into the sandbox before returning model-visible handles. */
export async function writeSandboxGeneratedFiles(
  workspace: GeneratedFileWorkspace,
  files: FileUpload[],
): Promise<GeneratedFileRef[]> {
  const limit = pLimit(FAN_OUT_CONCURRENCY);
  const generated = await Promise.all(
    files.map((file) =>
      limit(async () => {
        const content = await fileUploadDataToBuffer(file.data);
        return {
          content,
          ref: {
            bytes: content.byteLength,
            filename: file.filename,
            mime_type: file.mimeType,
            path: sandboxGeneratedFilePath(content, file.filename),
          },
        };
      }),
    ),
  );

  // Sandbox writes create missing parent directories.
  await workspace.writeFiles(
    generated.map((file) => ({
      content: file.content,
      path: file.ref.path,
    })),
  );

  return generated.map((file) => file.ref);
}
