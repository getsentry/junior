import type {
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "@/chat/plugins/types";
import {
  DOCKER_CLI_WRAPPER_SCRIPT,
  DOCKER_COMPOSE_CLI_WRAPPER_SCRIPT,
  DOCKER_DAEMON_JSON,
  DOCKER_ENSURE_SCRIPT,
} from "@/chat/sandbox/docker";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";

// Verify additions by installing them in a stock Vercel node22 sandbox. Package
// availability differs from upstream Fedora, and entries install in this order.
export const GLOBAL_RUNTIME_DEPENDENCIES: PluginRuntimeDependency[] = [
  { type: "system", package: "docker" },
  { type: "system", package: "spal-release" },
  { type: "system", package: "ripgrep" },
];

function writeFileCommand(
  path: string,
  contents: string,
  mode = "0644",
): string {
  const payload = Buffer.from(contents, "utf8").toString("base64");
  return [
    `printf '%s' '${payload}' | base64 -d > ${path}`,
    `chmod ${mode} ${path}`,
  ].join("\n");
}

function writeExecutableCommand(path: string, contents: string): string {
  return writeFileCommand(path, contents, "0755");
}

// AL2023 does not package Docker Compose. Keep this version compatible with
// the buildx plugin bundled by its Docker package. Also install a dockerd
// helper and PATH wrappers so nested Docker works after snapshot boot.
export const GLOBAL_RUNTIME_POSTINSTALL: PluginRuntimePostinstallCommand[] = [
  {
    cmd: "sh",
    args: [
      "-c",
      [
        "set -eu",
        'case "$(uname -m)" in',
        '  x86_64) asset="x86_64"; sha256="7af95166a730b87e172d4fc9aefea8725d3c6c7327d59149267b452114ddb7d4" ;;',
        '  aarch64) asset="aarch64"; sha256="49082844b87f03cdcd5f5bbef1ba8c9c897b7a2dfb80cea18d61ec8ca6117e0c" ;;',
        '  *) echo "unsupported Docker Compose architecture: $(uname -m)" >&2; exit 1 ;;',
        "esac",
        'tmp="$(mktemp)"',
        "trap 'rm -f \"$tmp\"' EXIT",
        'curl --fail --location --silent --show-error "https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-${asset}" --output "$tmp"',
        'echo "${sha256}  ${tmp}" | sha256sum --check --status',
        // Keep the real Compose binary off PATH; the wrapper below starts dockerd.
        'install -D -m 0755 "$tmp" /usr/local/libexec/junior-docker-compose',
        "mkdir -p /usr/local/lib/docker/cli-plugins /usr/local/libexec /etc/docker /usr/local/bin",
        `mkdir -p ${SANDBOX_WORKSPACE_ROOT}/.junior/bin`,
        writeFileCommand("/etc/docker/daemon.json", DOCKER_DAEMON_JSON),
        writeExecutableCommand(
          "/usr/local/bin/junior-ensure-docker",
          DOCKER_ENSURE_SCRIPT,
        ),
        // docker compose plugin delegates to the real Compose binary.
        "ln -sfn /usr/local/libexec/junior-docker-compose /usr/local/lib/docker/cli-plugins/docker-compose",
        // PATH wrappers auto-start dockerd for both CLI entrypoints.
        writeExecutableCommand(
          "/usr/local/bin/docker-compose",
          DOCKER_COMPOSE_CLI_WRAPPER_SCRIPT,
        ),
        writeExecutableCommand(
          `${SANDBOX_WORKSPACE_ROOT}/.junior/bin/docker`,
          DOCKER_CLI_WRAPPER_SCRIPT,
        ),
        writeExecutableCommand(
          `${SANDBOX_WORKSPACE_ROOT}/.junior/bin/docker-compose`,
          DOCKER_COMPOSE_CLI_WRAPPER_SCRIPT,
        ),
        // Prefer the wrapper over /usr/bin/docker for non-login shells too.
        writeExecutableCommand(
          "/usr/local/bin/docker",
          DOCKER_CLI_WRAPPER_SCRIPT,
        ),
      ].join("\n"),
    ],
    sudo: true,
  },
];
