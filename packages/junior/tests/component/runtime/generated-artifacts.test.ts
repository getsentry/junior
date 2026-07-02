import type { FileUpload } from "chat";
import { describe, expect, it } from "vitest";
import { writeSandboxGeneratedArtifacts } from "@/chat/runtime/generated-artifacts";
import { SANDBOX_ARTIFACTS_DIR } from "@/chat/tools/sandbox/file-uploads";
import type { SandboxCommandResult } from "@/chat/sandbox/workspace";

const GENERATED_IMAGE_PATH = `${SANDBOX_ARTIFACTS_DIR}/generated.png`;

function commandResult(overrides: Partial<SandboxCommandResult> = {}) {
  return {
    exitCode: 0,
    stdout: async () => "",
    stderr: async () => "",
    ...overrides,
  } satisfies SandboxCommandResult;
}

describe("writeSandboxGeneratedArtifacts", () => {
  it("writes generated files to sandbox artifact paths before returning refs", async () => {
    const commands: Array<{ args?: string[]; cmd: string }> = [];
    const writes: Array<{ content: string | Uint8Array; path: string }> = [];
    const sandbox = {
      runCommand: async (input: { args?: string[]; cmd: string }) => {
        commands.push(input);
        return commandResult();
      },
      writeFiles: async (
        files: Array<{ content: string | Uint8Array; path: string }>,
      ) => {
        writes.push(...files);
      },
    };
    const generated: FileUpload[] = [
      {
        data: Buffer.from("image-bytes"),
        filename: "generated.png",
        mimeType: "image/png",
      },
    ];

    const refs = await writeSandboxGeneratedArtifacts(sandbox, generated);

    expect(commands).toEqual([
      { cmd: "mkdir", args: ["-p", SANDBOX_ARTIFACTS_DIR] },
    ]);
    expect(writes).toEqual([
      {
        content: Buffer.from("image-bytes"),
        path: GENERATED_IMAGE_PATH,
      },
    ]);
    expect(refs).toEqual([
      {
        bytes: Buffer.from("image-bytes").byteLength,
        filename: "generated.png",
        mimeType: "image/png",
        path: GENERATED_IMAGE_PATH,
      },
    ]);
  });

  it("fails before returning refs when the artifact directory cannot be created", async () => {
    const sandbox = {
      runCommand: async () =>
        commandResult({
          exitCode: 1,
          stderr: async () => "permission denied",
        }),
      writeFiles: async () => {
        throw new Error("writeFiles should not run");
      },
    };

    await expect(
      writeSandboxGeneratedArtifacts(sandbox, [
        {
          data: Buffer.from("image-bytes"),
          filename: "generated.png",
          mimeType: "image/png",
        },
      ]),
    ).rejects.toThrow(
      "failed to create generated artifact directory: permission denied",
    );
  });
});
