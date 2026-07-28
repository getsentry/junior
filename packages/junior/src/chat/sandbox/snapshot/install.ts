import type {
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "@/chat/plugins/types";
import { runNonInteractiveCommand } from "@/chat/sandbox/noninteractive-command";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type { SandboxSession } from "@/chat/sandbox/workspace";
import { trace } from "@/chat/sandbox/snapshot/span";

async function runOrThrow(
  sandbox: SandboxSession,
  params: {
    cmd: string;
    args?: string[];
    sudo?: boolean;
  },
  label: string,
): Promise<void> {
  const result = await runNonInteractiveCommand(sandbox, params);
  if (result.exitCode === 0) {
    return;
  }

  const detail =
    result.stderr.trim() || result.stdout.trim() || "command failed";
  throw new Error(`${label} failed: ${detail}`);
}

async function tryRun(
  sandbox: SandboxSession,
  params: {
    cmd: string;
    args?: string[];
    sudo?: boolean;
  },
): Promise<boolean> {
  const result = await runNonInteractiveCommand(sandbox, params);
  return result.exitCode === 0;
}

async function installGh(sandbox: SandboxSession): Promise<void> {
  const installed = await tryRun(sandbox, {
    cmd: "dnf",
    args: ["install", "-y", "gh"],
    sudo: true,
  });
  if (installed) {
    return;
  }

  const repoAdded = await tryRun(sandbox, {
    cmd: "dnf",
    args: [
      "config-manager",
      "addrepo",
      "--from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo",
    ],
    sudo: true,
  });
  if (!repoAdded) {
    await runOrThrow(
      sandbox,
      {
        cmd: "dnf",
        args: ["install", "-y", "dnf-command(config-manager)"],
        sudo: true,
      },
      "dnf install dnf-command(config-manager)",
    );
    await runOrThrow(
      sandbox,
      {
        cmd: "dnf",
        args: [
          "config-manager",
          "--add-repo",
          "https://cli.github.com/packages/rpm/gh-cli.repo",
        ],
        sudo: true,
      },
      "dnf config-manager --add-repo gh-cli.repo",
    );
  }

  await runOrThrow(
    sandbox,
    {
      cmd: "dnf",
      args: ["install", "-y", "gh", "--repo", "gh-cli"],
      sudo: true,
    },
    "dnf install gh --repo gh-cli",
  );
}

function filePath(url: string, sha256: string): string {
  let basename = "package.rpm";
  try {
    const candidate = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    if (candidate) {
      basename = candidate;
    }
  } catch {
    // Manifest parsing validates URL shape; retain a safe fallback for callers.
  }

  const sanitized = basename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `/tmp/junior-runtime-${sha256.slice(0, 12)}-${sanitized}`;
}

async function installUrl(
  sandbox: SandboxSession,
  dependency: Extract<PluginRuntimeDependency, { type: "system"; url: string }>,
): Promise<void> {
  const rpmPath = filePath(dependency.url, dependency.sha256);
  await runOrThrow(
    sandbox,
    {
      cmd: "curl",
      args: ["-fsSL", dependency.url, "-o", rpmPath],
    },
    `curl download ${dependency.url}`,
  );

  const checksum = await runNonInteractiveCommand(sandbox, {
    cmd: "sha256sum",
    args: [rpmPath],
  });
  const expected = dependency.sha256;
  const actual = checksum.stdout.trim().split(/\s+/)[0]?.toLowerCase();
  if (checksum.exitCode !== 0) {
    const detail =
      checksum.stderr.trim() || checksum.stdout.trim() || "command failed";
    throw new Error(`sha256sum failed: ${detail}`);
  }
  if (!actual) {
    throw new Error("sha256sum produced empty output");
  }
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${dependency.url}: expected ${expected}, got ${actual}`,
    );
  }

  await runOrThrow(
    sandbox,
    {
      cmd: "dnf",
      args: ["install", "-y", rpmPath],
      sudo: true,
    },
    `dnf install ${dependency.url}`,
  );
}

/** Install declared system and npm dependencies into a snapshot sandbox. */
export async function dependencies(
  sandbox: SandboxSession,
  values: PluginRuntimeDependency[],
): Promise<void> {
  const system = values.filter(
    (
      dependency,
    ): dependency is Extract<PluginRuntimeDependency, { type: "system" }> =>
      dependency.type === "system",
  );
  const npm = values
    .filter(
      (
        dependency,
      ): dependency is Extract<PluginRuntimeDependency, { type: "npm" }> =>
        dependency.type === "npm",
    )
    .map((dependency) => `${dependency.package}@${dependency.version}`);

  if (system.length > 0) {
    await trace(
      "sandbox.snapshot.install_system",
      "sandbox.snapshot.install.system",
      {
        "app.sandbox.snapshot.install.system_count": system.length,
      },
      async () => {
        for (const dependency of system) {
          if ("url" in dependency) {
            await installUrl(sandbox, dependency);
          } else if (dependency.package === "gh") {
            await installGh(sandbox);
          } else {
            await runOrThrow(
              sandbox,
              {
                cmd: "dnf",
                args: ["install", "-y", dependency.package],
                sudo: true,
              },
              `dnf install ${dependency.package}`,
            );
          }
        }
      },
    );
  }

  if (npm.length > 0) {
    await trace(
      "sandbox.snapshot.install_npm",
      "sandbox.snapshot.install.npm",
      {
        "app.sandbox.snapshot.install.npm_count": npm.length,
      },
      async () => {
        await runOrThrow(
          sandbox,
          {
            cmd: "npm",
            args: [
              "install",
              "--global",
              "--prefix",
              `${SANDBOX_WORKSPACE_ROOT}/.junior`,
              ...npm,
            ],
          },
          "npm install",
        );
      },
    );
  }
}

/** Run declared postinstall commands after dependency binaries are available. */
export async function postinstall(
  sandbox: SandboxSession,
  commands: PluginRuntimePostinstallCommand[],
): Promise<void> {
  if (commands.length === 0) {
    return;
  }

  await trace(
    "sandbox.snapshot.runtime_postinstall",
    "sandbox.snapshot.runtime_postinstall",
    {
      "app.sandbox.snapshot.runtime_postinstall.count": commands.length,
    },
    async () => {
      for (const command of commands) {
        const result = await runNonInteractiveCommand(sandbox, {
          cmd: command.cmd,
          args: command.args,
          login: true,
          pathPrefix: `${SANDBOX_WORKSPACE_ROOT}/.junior/bin:$PATH`,
          ...(command.sudo !== undefined ? { sudo: command.sudo } : {}),
        });
        if (result.exitCode !== 0) {
          const detail =
            result.stderr.trim() || result.stdout.trim() || "command failed";
          throw new Error(
            `runtime-postinstall ${command.cmd} failed: ${detail}`,
          );
        }
      }
    },
  );
}
