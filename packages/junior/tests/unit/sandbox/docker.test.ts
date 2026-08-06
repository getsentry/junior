import { describe, expect, it, vi } from "vitest";
import {
  DOCKER_ENSURE_SCRIPT,
  ensureDockerDaemon,
} from "@/chat/sandbox/docker";

describe("sandbox docker helpers", () => {
  it("starts dockerd through sudo and waits for the socket", () => {
    expect(DOCKER_ENSURE_SCRIPT).toContain("exec sudo -n");
    expect(DOCKER_ENSURE_SCRIPT).toContain("nohup dockerd");
    expect(DOCKER_ENSURE_SCRIPT).toContain("SOCK=/var/run/docker.sock");
    expect(DOCKER_ENSURE_SCRIPT).toContain('--host="unix://$SOCK"');
    expect(DOCKER_ENSURE_SCRIPT).toContain("overlay2");
    expect(DOCKER_ENSURE_SCRIPT).toContain("chmod 666");
  });

  it("best-effort invokes junior-ensure-docker when present", async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    await ensureDockerDaemon({ runCommand });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "bash",
        args: expect.arrayContaining([
          expect.stringContaining("junior-ensure-docker"),
        ]),
      }),
    );
  });
});
