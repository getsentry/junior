import type {
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "@/chat/plugins/types";

// Verify additions by installing them in a stock Vercel node22 sandbox. Package
// availability differs from upstream Fedora, and entries install in this order.
export const GLOBAL_RUNTIME_DEPENDENCIES: PluginRuntimeDependency[] = [
  { type: "system", package: "docker" },
  { type: "system", package: "spal-release" },
  { type: "system", package: "ripgrep" },
];

// AL2023 does not package Docker Compose. Keep this version compatible with
// the buildx plugin bundled by its Docker package.
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
        'install -D -m 0755 "$tmp" /usr/local/bin/docker-compose',
        "mkdir -p /usr/local/lib/docker/cli-plugins",
        "ln -sf /usr/local/bin/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose",
      ].join("\n"),
    ],
    sudo: true,
  },
];
