import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { afterAll, describe, it } from "vitest";
import {
  ToolExecutionEnvironmentUnavailableError,
  type OutputChunk,
  type ToolExecutionEnvironment,
  type ToolExecutionEnvironmentManager,
} from "@/core/tool-execution-environment/types";
import { dockerRequest } from "@/core/tool-execution-environment/docker/api";
import { createDockerToolExecutionEnvironmentManager } from "@/core/tool-execution-environment/docker";
import { instrumentToolExecutionEnvironmentManager } from "@/core/tool-execution-environment/instrument";
import {
  createVercelToolExecutionEnvironmentManager,
  type VercelCredentials,
} from "@/core/tool-execution-environment/vercel";

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
          expect(await isRunning(environment, ["sleep", "60"])).toBe(false);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "kills a command when the caller aborts and throws the reason",
        async ({ expect }) => {
          const { environment } = await createEnvironment();
          const controller = new AbortController();
          const reason = new Error("caller stopped");

          const running = environment.exec(["sleep", "60"], {
            signal: controller.signal,
            onOutputChunk: () => {},
          });
          // Also proves that isRunning sees a running command, so the false
          // checks below mean something.
          await expect
            .poll(() => isRunning(environment, ["sleep", "60"]), {
              timeout: TEST_TIMEOUT_MS,
            })
            .toBe(true);
          controller.abort(reason);

          await expect(running).rejects.toBe(reason);
          expect(await isRunning(environment, ["sleep", "60"])).toBe(false);
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

// Reads /proc, so it needs no tool from the image. The command line is
// matched at its end, because Amazon Linux runs coreutils through one binary,
// and it comes in through env, so this check never matches itself.
async function isRunning(
  environment: ToolExecutionEnvironment,
  argv: readonly string[],
): Promise<boolean> {
  const result = await environment.exec(
    [
      "sh",
      "-c",
      'for p in /proc/[0-9]*; do case "$(tr "\\0" " " < "$p/cmdline" 2>/dev/null)" in *"$COMMAND_LINE ") exit 0 ;; esac; done; exit 1',
    ],
    {
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      env: { COMMAND_LINE: argv.join(" ") },
      onOutputChunk: () => {},
    },
  );
  return result.exitCode === 0;
}

// CI has a token, not OIDC. Without one, the SDK uses its own OIDC auth.
function vercelCredentialsFromEnv(): VercelCredentials | undefined {
  const token = process.env["VERCEL_TOKEN"];
  const teamId = process.env["VERCEL_TEAM_ID"];
  const projectId = process.env["VERCEL_PROJECT_ID"];
  if (!token || !teamId || !projectId) return undefined;
  return { token, teamId, projectId };
}

/**
 * Creates real sandboxes, so it runs only when `JUNIOR_VERCEL_SANDBOX_TEST=1`.
 * It uses `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` when all
 * three are set, and the SDK's OIDC auth otherwise.
 */
describeManagerContract(
  "Vercel",
  Boolean(process.env["JUNIOR_VERCEL_SANDBOX_TEST"]),
  () => {
    const credentials = vercelCredentialsFromEnv();
    return {
      // Instrumented, as production uses it, so the spans pass every result
      // and error through unchanged.
      manager: instrumentToolExecutionEnvironmentManager(
        createVercelToolExecutionEnvironmentManager(credentials),
      ),
      async stop(id) {
        const sandbox = await Sandbox.get({ ...credentials, name: id });
        await sandbox.stop();
      },
      async remove(id) {
        const sandbox = await Sandbox.get({ ...credentials, name: id });
        await sandbox.delete();
      },
    };
  },
);

/**
 * Creates real containers on the local Docker daemon, so it runs only when
 * `JUNIOR_DOCKER_SANDBOX_TEST=1`. Amazon Linux 2023 is the base image of
 * Vercel Sandbox.
 */
describeManagerContract(
  "Docker",
  Boolean(process.env["JUNIOR_DOCKER_SANDBOX_TEST"]),
  () => ({
    manager: instrumentToolExecutionEnvironmentManager(
      createDockerToolExecutionEnvironmentManager({
        image: "amazonlinux:2023",
      }),
    ),
    async stop(id) {
      await dockerRequest({
        method: "POST",
        path: `/containers/${id}/stop`,
        query: { t: 0 },
      });
    },
    async remove(id) {
      await dockerRequest({
        method: "DELETE",
        path: `/containers/${id}`,
        query: { force: true },
      });
    },
  }),
);
