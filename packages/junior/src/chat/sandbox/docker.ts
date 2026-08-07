import { runNonInteractiveCommand } from "@/chat/sandbox/noninteractive-command";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

/** Docker daemon config for Vercel sandbox guests (nested containers). */
export const DOCKER_DAEMON_JSON = `{
  "storage-driver": "overlay2",
  "live-restore": false
}
`;

/**
 * Start dockerd when the socket is missing and wait until `docker info` works.
 * Re-execs through sudo so the sandbox user can call it without root.
 */
export const DOCKER_ENSURE_SCRIPT = `#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -n "$0" "$@"
fi

SOCK=/var/run/docker.sock
PIDFILE=/var/run/docker.pid
LOG=/var/log/junior-dockerd.log

is_ready() {
  [ -S "$SOCK" ] && /usr/bin/docker info >/dev/null 2>&1
}

if is_ready; then
  chmod 666 "$SOCK" 2>/dev/null || true
  exit 0
fi

mkdir -p /etc/docker /var/lib/docker /var/run /var/log
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "storage-driver": "overlay2",
  "live-restore": false
}
EOF
fi

if [ -f "$PIDFILE" ]; then
  oldpid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "\${oldpid:-}" ] && ! kill -0 "$oldpid" 2>/dev/null; then
    rm -f "$PIDFILE"
  fi
fi

if [ ! -f "$PIDFILE" ] || ! kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  # dockerd must outlive this helper; nohup + background is intentional.
  nohup dockerd --host="unix://$SOCK" --pidfile="$PIDFILE" >"$LOG" 2>&1 &
fi

i=0
while [ "$i" -lt 50 ]; do
  if is_ready; then
    chmod 666 "$SOCK" 2>/dev/null || true
    exit 0
  fi
  i=$((i + 1))
  sleep 0.1
done

echo "junior-ensure-docker: dockerd failed to become ready" >&2
if [ -f "$LOG" ]; then
  tail -n 50 "$LOG" >&2 || true
fi
exit 1
`;

/** PATH wrapper so plain `docker` starts the daemon on first use. */
export const DOCKER_CLI_WRAPPER_SCRIPT = `#!/bin/sh
set -eu
if command -v junior-ensure-docker >/dev/null 2>&1; then
  junior-ensure-docker
fi
exec /usr/bin/docker "$@"
`;

/** PATH wrapper so plain `docker-compose` starts the daemon on first use. */
export const DOCKER_COMPOSE_CLI_WRAPPER_SCRIPT = `#!/bin/sh
set -eu
if command -v junior-ensure-docker >/dev/null 2>&1; then
  junior-ensure-docker
fi
exec /usr/local/libexec/junior-docker-compose "$@"
`;

/**
 * Best-effort dockerd start during sandbox prepare.
 * Missing helper is a no-op so tests and base sandboxes stay green.
 */
export async function ensureDockerDaemon(
  sandbox: Pick<SandboxWorkspace, "runCommand">,
  signal?: AbortSignal,
): Promise<void> {
  await runNonInteractiveCommand(sandbox, {
    cmd: "sh",
    args: [
      "-c",
      "command -v junior-ensure-docker >/dev/null 2>&1 && junior-ensure-docker || true",
    ],
    signal,
  });
}
