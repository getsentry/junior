import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOCKER_CLI_WRAPPER_SCRIPT,
  DOCKER_COMPOSE_CLI_WRAPPER_SCRIPT,
  DOCKER_ENSURE_SCRIPT,
} from "@/chat/sandbox/guest-docker";
import {
  CURL_DOWNLOAD_ARGS,
  GLOBAL_RUNTIME_DEPENDENCIES,
  GLOBAL_RUNTIME_POSTINSTALL,
} from "@/chat/sandbox/runtime-dependencies";

const run = promisify(execFile);

/** Serve `/flaky` as one 504 and then the file, and `/missing` as a 404. */
async function startDownloadServer(): Promise<{ server: Server; url: string }> {
  let flakyRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/flaky" && flakyRequests++ > 0) {
      response.end("compose");
      return;
    }
    response.statusCode = request.url === "/flaky" ? 504 : 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe("global sandbox runtime dependencies", () => {
  it("provisions core tools after their package repositories", () => {
    expect(GLOBAL_RUNTIME_DEPENDENCIES).toEqual([
      { type: "system", package: "docker" },
      { type: "system", package: "spal-release" },
      { type: "system", package: "ripgrep" },
    ]);
  });

  it("installs compose, dockerd ensure helper, and PATH wrappers", () => {
    expect(GLOBAL_RUNTIME_POSTINSTALL).toHaveLength(1);
    const script = GLOBAL_RUNTIME_POSTINSTALL[0]?.args?.[1];
    expect(script).toEqual(expect.any(String));
    expect(script).toContain(`curl ${CURL_DOWNLOAD_ARGS.join(" ")} `);
    expect(script).toContain("docker-compose-linux-");
    expect(script).toContain("/usr/local/libexec/junior-docker-compose");
    expect(script).toContain("/usr/local/bin/junior-ensure-docker");
    expect(script).toContain("/usr/local/bin/docker");
    expect(script).toContain("/usr/local/bin/docker-compose");
    expect(script).toContain("/vercel/sandbox/.junior/bin/docker");
    expect(script).toContain(
      Buffer.from(DOCKER_ENSURE_SCRIPT, "utf8").toString("base64"),
    );
    expect(script).toContain(
      Buffer.from(DOCKER_CLI_WRAPPER_SCRIPT, "utf8").toString("base64"),
    );
    expect(script).toContain(
      Buffer.from(DOCKER_COMPOSE_CLI_WRAPPER_SCRIPT, "utf8").toString("base64"),
    );
  });

  describe("snapshot downloads", () => {
    const cleanup: Array<() => Promise<void>> = [];

    afterEach(async () => {
      await Promise.all(cleanup.splice(0).map((step) => step()));
    });

    async function download(urlPath: string) {
      const { server, url } = await startDownloadServer();
      const dir = await mkdtemp(path.join(tmpdir(), "junior-download-"));
      cleanup.push(
        () => new Promise((resolve) => server.close(() => resolve())),
        () => rm(dir, { recursive: true, force: true }),
      );
      const output = path.join(dir, "file");
      await run("curl", [
        ...CURL_DOWNLOAD_ARGS,
        `${url}${urlPath}`,
        "--output",
        output,
      ]);
      return readFile(output, "utf8");
    }

    it("retries a transient upstream 504", async () => {
      await expect(download("/flaky")).resolves.toBe("compose");
    });

    it("still fails on a missing file", async () => {
      await expect(download("/missing")).rejects.toMatchObject({ code: 22 });
    });
  });
});
