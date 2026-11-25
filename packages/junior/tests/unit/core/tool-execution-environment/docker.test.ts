import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockerToolExecutionEnvironmentManager } from "@/core/tool-execution-environment/docker";

const IMAGE = "junior-test:1";

type Route = (request: http.IncomingMessage) => {
  status: number;
  body?: unknown;
};

async function startFakeDocker(route: Route) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fake-docker-"));
  const socket = path.join(dir, "docker.sock");
  const calls: string[] = [];
  const server = http.createServer((request, response) => {
    calls.push(
      `${request.method} ${new URL(request.url ?? "", "http://x").pathname.replace(/^\/v[\d.]+/, "")}`,
    );
    request.resume();
    request.on("end", () => {
      const { status, body } = route(request);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? "" : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  vi.stubEnv("DOCKER_HOST", `unix://${socket}`);
  return {
    calls,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("Docker tool execution environment manager", () => {
  let docker: Awaited<ReturnType<typeof startFakeDocker>> | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await docker?.close();
    docker = undefined;
  });

  it("resumes the container when a create after an image pull finds it already exists", async () => {
    let creates = 0;
    docker = await startFakeDocker((request) => {
      const pathname = new URL(request.url ?? "", "http://x").pathname;
      if (pathname.endsWith("/containers/create")) {
        creates += 1;
        // The image is missing at first. While it is pulled, another
        // create wins the race and makes the container.
        return creates === 1
          ? { status: 404, body: { message: `No such image: ${IMAGE}` } }
          : { status: 409, body: { message: "Conflict" } };
      }
      if (pathname.endsWith("/images/create")) return { status: 200 };
      if (pathname.endsWith("/containers/env-1/json")) {
        return {
          status: 200,
          body: {
            State: { Running: true, StartedAt: "2026-11-25T00:00:00Z" },
          },
        };
      }
      return { status: 500, body: { message: `unexpected ${pathname}` } };
    });

    const manager = createDockerToolExecutionEnvironmentManager({
      image: IMAGE,
    });
    const environment = await manager.create(
      { id: "env-1", timeoutMs: 60_000 },
      new AbortController().signal,
    );

    expect(environment.cwd).toBe("/workspace");
    expect(docker.calls).toEqual([
      "POST /containers/create",
      "POST /images/create",
      "POST /containers/create",
      "GET /containers/env-1/json",
    ]);
  });
});
