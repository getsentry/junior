import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { afterAll, describe, it } from "vitest";
import {
  ToolExecutionEnvironmentUnavailableError,
  type OutputChunk,
  type ToolExecutionEnvironment,
  type ToolExecutionEnvironmentManager,
} from "@/core/tool-execution-environment/types";
import { instrumentToolExecutionEnvironmentManager } from "@/core/tool-execution-environment/instrument";
import { vercelToolExecutionEnvironmentManager } from "@/core/tool-execution-environment/vercel";

const TEST_TIMEOUT_MS = 3 * 60 * 1000;
const ENVIRONMENT_TIMEOUT_MS = 10 * 60 * 1000;

type ManagerUnderTest = {
  manager: ToolExecutionEnvironmentManager;
  /** Stops the environment from outside, the way a provider timeout does. */
  stop(id: string): Promise<void>;
  /** Deletes the environment and everything it stored. */
  remove(id: string): Promise<void>;
};

/**
 * The contract every `ToolExecutionEnvironmentManager` keeps, proved against
 * a real provider. Each provider calls it once. The tests run concurrently,
 * so each one creates its own environment and shares no remote state.
 */
function describeManagerContract(
  name: string,
  enabled: boolean,
  setup: () => ManagerUnderTest,
): void {
  describe
    .skipIf(!enabled)
    .concurrent(`${name} tool execution environment`, () => {
      const created: string[] = [];
      const underTest = setup();

      async function createEnvironment(): Promise<{
        id: string;
        environment: ToolExecutionEnvironment;
      }> {
        const id = `junior-contract-${randomUUID()}`;
        created.push(id);
        const environment = await underTest.manager.create(
          { id, timeoutMs: ENVIRONMENT_TIMEOUT_MS },
          AbortSignal.timeout(TEST_TIMEOUT_MS),
        );
        return { id, environment };
      }

      afterAll(async () => {
        await Promise.all(created.map((id) => underTest.remove(id)));
      }, TEST_TIMEOUT_MS);

      it(
        "streams each output stream and returns a non-zero exit code",
        async ({ expect }) => {
          const { environment } = await createEnvironment();
          const chunks: OutputChunk[] = [];

          const result = await environment.exec(
            ["bash", "-c", "echo out; echo err >&2; exit 3"],
            {
              signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
              onOutputChunk: (chunk) => chunks.push(chunk),
            },
          );

          expect(result).toEqual({ exitCode: 3 });
          expect(joined(chunks, "stdout")).toBe("out\n");
          expect(joined(chunks, "stderr")).toBe("err\n");
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "kills a command that passes its timeout and throws",
        async ({ expect }) => {
          const { environment } = await createEnvironment();

          await expect(
            environment.exec(["sleep", "60"], {
              signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
              timeoutMs: 1_000,
              onOutputChunk: () => {},
            }),
          ).rejects.toMatchObject({ name: "TimeoutError" });
          expect(await isRunning(environment, "sleep")).toBe(false);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "kills a command when the caller aborts and throws the reason",
        async ({ expect }) => {
          const { environment } = await createEnvironment();
          const controller = new AbortController();
          const reason = new Error("caller stopped");
          setTimeout(() => controller.abort(reason), 1_000);

          await expect(
            environment.exec(["sleep", "60"], {
              signal: controller.signal,
              onOutputChunk: () => {},
            }),
          ).rejects.toBe(reason);
          expect(await isRunning(environment, "sleep")).toBe(false);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "runs argv without a shell, in the given cwd, with the given env",
        async ({ expect }) => {
          const { environment } = await createEnvironment();
          const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
          const workDir = `${environment.cwd}/work`;
          await environment.writeFile("work/.keep", new Uint8Array(), signal);

          expect(await stdoutOf(environment, ["echo", "$HOME"], {})).toBe(
            "$HOME\n",
          );
          expect(await stdoutOf(environment, ["pwd"], { cwd: workDir })).toBe(
            `${workDir}\n`,
          );
          expect(
            await stdoutOf(environment, ["printenv", "JUNIOR_CONTRACT"], {
              env: { JUNIOR_CONTRACT: "set" },
            }),
          ).toBe("set\n");
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "writes bytes into missing directories, replaces them, and reads them back",
        async ({ expect }) => {
          const { environment } = await createEnvironment();
          const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
          const content = new Uint8Array([0, 255, 10, 128, 1]);

          await environment.writeFile(
            "nested/dir/file.bin",
            new TextEncoder().encode("replaced below"),
            signal,
          );
          await environment.writeFile("nested/dir/file.bin", content, signal);

          expect(
            await read(environment, "nested/dir/file.bin", signal),
          ).toEqual(content);
          expect(await environment.readFile("missing.bin", signal)).toBe(
            undefined,
          );
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "returns the same environment when create is retried with its id",
        async ({ expect }) => {
          const { id, environment } = await createEnvironment();
          const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
          const content = new TextEncoder().encode("kept");
          await environment.writeFile("kept.txt", content, signal);

          const again = await underTest.manager.create(
            { id, timeoutMs: ENVIRONMENT_TIMEOUT_MS },
            signal,
          );

          expect(await read(again, "kept.txt", signal)).toEqual(content);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "returns undefined when resuming an id that never existed",
        async ({ expect }) => {
          expect(
            await underTest.manager.resume(
              `junior-contract-missing-${randomUUID()}`,
              AbortSignal.timeout(TEST_TIMEOUT_MS),
            ),
          ).toBe(undefined);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "throws Unavailable after a stop, and resume keeps the files",
        async ({ expect }) => {
          const { id, environment } = await createEnvironment();
          const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
          const content = new TextEncoder().encode("survives");
          await environment.writeFile("survives.txt", content, signal);

          // Injected fault: the provider stops the environment, as its own
          // timeout or a deploy does.
          await underTest.stop(id);

          await expect(
            environment.exec(["true"], { signal, onOutputChunk: () => {} }),
          ).rejects.toBeInstanceOf(ToolExecutionEnvironmentUnavailableError);
          const resumed = await underTest.manager.resume(id, signal);
          expect(resumed).toBeDefined();
          if (!resumed) return;
          expect(await read(resumed, "survives.txt", signal)).toEqual(content);
        },
        TEST_TIMEOUT_MS,
      );
    });
}

function joined(chunks: OutputChunk[], stream: OutputChunk["stream"]): string {
  return chunks
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.text)
    .join("");
}

async function stdoutOf(
  environment: ToolExecutionEnvironment,
  argv: readonly string[],
  options: { cwd?: string; env?: Record<string, string> },
): Promise<string> {
  const chunks: OutputChunk[] = [];
  await environment.exec(argv, {
    ...options,
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    onOutputChunk: (chunk) => chunks.push(chunk),
  });
  return joined(chunks, "stdout");
}

async function read(
  environment: ToolExecutionEnvironment,
  path: string,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const stream = await environment.readFile(path, signal);
  if (!stream) return undefined;
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function isRunning(
  environment: ToolExecutionEnvironment,
  processName: string,
): Promise<boolean> {
  const result = await environment.exec(["pgrep", "-x", processName], {
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    onOutputChunk: () => {},
  });
  return result.exitCode === 0;
}

/**
 * Needs Vercel Sandbox credentials that the SDK finds on its own, and creates
 * real sandboxes. Set `JUNIOR_VERCEL_SANDBOX_TEST=1` to run it.
 */
describeManagerContract(
  "Vercel",
  Boolean(process.env["JUNIOR_VERCEL_SANDBOX_TEST"]),
  () => ({
    // Instrumented, as production uses it, so the spans pass every result
    // and error through unchanged.
    manager: instrumentToolExecutionEnvironmentManager(
      vercelToolExecutionEnvironmentManager,
    ),
    async stop(id) {
      const sandbox = await Sandbox.get({ name: id });
      await sandbox.stop();
    },
    async remove(id) {
      const sandbox = await Sandbox.get({ name: id });
      await sandbox.delete();
    },
  }),
);
