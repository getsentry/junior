import type { FileUpload } from "chat";
import {
  SANDBOX_ARTIFACTS_DIR,
  sandboxArtifactPath,
} from "@/chat/tools/sandbox/file-uploads";
import type { GeneratedArtifactFileRef } from "@/chat/tools/types";
import type { SandboxCommandResult } from "@/chat/sandbox/workspace";

/** Sandbox operations needed to make generated artifacts visible to later tools. */
export interface GeneratedArtifactSandbox {
  runCommand(input: {
    args?: string[];
    cmd: string;
  }): Promise<SandboxCommandResult>;
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

/** Persist generated artifacts into the sandbox before returning model-visible handles. */
export async function writeSandboxGeneratedArtifacts(
  sandbox: GeneratedArtifactSandbox,
  files: FileUpload[],
): Promise<GeneratedArtifactFileRef[]> {
  const mkdir = await sandbox.runCommand({
    cmd: "mkdir",
    args: ["-p", SANDBOX_ARTIFACTS_DIR],
  });
  if (mkdir.exitCode !== 0) {
    throw new Error(
      `failed to create generated artifact directory: ${await mkdir.stderr()}`,
    );
  }

  const artifacts = await Promise.all(
    files.map(async (file) => {
      const content = await fileUploadDataToBuffer(file.data);
      const artifactPath = sandboxArtifactPath(file.filename);
      return {
        content,
        ref: {
          bytes: content.byteLength,
          filename: file.filename,
          mimeType: file.mimeType,
          path: artifactPath,
        },
      };
    }),
  );

  await sandbox.writeFiles(
    artifacts.map((artifact) => ({
      content: artifact.content,
      path: artifact.ref.path,
    })),
  );

  return artifacts.map((artifact) => artifact.ref);
}
