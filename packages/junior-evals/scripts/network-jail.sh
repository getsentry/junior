#!/usr/bin/env bash
# Run an eval command where it cannot skip Roach.
#
# Usage: scripts/network-jail.sh <command> [args...]
#
# The command runs with the group `junior-evals-net`. Firewall rules let
# that group connect only to:
#
# - loopback: Roach, local fixture servers, Postgres, Redis.
# - DNS.
# - Cloudflare, on the ports of Cloudflare Tunnel. cloudflared and the Quick
#   Tunnel of the sandbox egress (`src/eval-egress.ts`) use it.
#
# The firewall rejects every other connection. So a request that does not
# use the proxy fails at once, and does not silently go live.
#
# Roach must reach upstream origins, so it starts outside the
# group. `EVAL_ROACH_LAUNCHER` gives the command for that to
# `src/recording-run.ts`.
#
# This is a guard against mistakes, not a security boundary: the command
# can still use sudo. Linux only. Needs passwordless sudo, iptables, and
# setpriv, as on GitHub Actions Ubuntu runners.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 2
fi

group=junior-evals-net
chain=JUNIOR_EVALS_NET
# From https://www.cloudflare.com/ips/.
cloudflare_v4=(
  173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22
  141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20
  197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13
  104.24.0.0/14 172.64.0.0/13 131.0.72.0/22
)
cloudflare_v6=(
  2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32
  2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
)
# HTTPS, and Cloudflare Tunnel connections to the Cloudflare network.
cloudflare_ports=443,7844

getent group "$group" >/dev/null || sudo groupadd "$group"
jail_gid=$(getent group "$group" | cut -d: -f3)

# Replace the rules of the chain. Keep one jump from OUTPUT to it.
jail_rules() {
  local tables=$1
  shift
  sudo "$tables" -N "$chain" 2>/dev/null || sudo "$tables" -F "$chain"
  sudo "$tables" -C OUTPUT -m owner --gid-owner "$jail_gid" -j "$chain" \
    2>/dev/null ||
    sudo "$tables" -I OUTPUT -m owner --gid-owner "$jail_gid" -j "$chain"
  sudo "$tables" -A "$chain" -o lo -j ACCEPT
  sudo "$tables" -A "$chain" -p udp --dport 53 -j ACCEPT
  sudo "$tables" -A "$chain" -p tcp --dport 53 -j ACCEPT
  local range
  for range in "$@"; do
    sudo "$tables" -A "$chain" -d "$range" -p tcp -m multiport \
      --dports "$cloudflare_ports" -j ACCEPT
    sudo "$tables" -A "$chain" -d "$range" -p udp --dport 7844 -j ACCEPT
  done
  sudo "$tables" -A "$chain" -p tcp -j REJECT --reject-with tcp-reset
  sudo "$tables" -A "$chain" -j REJECT
}

jail_rules iptables "${cloudflare_v4[@]}"
if command -v ip6tables >/dev/null; then
  jail_rules ip6tables "${cloudflare_v6[@]}"
fi

# `sudo` resets PATH and HOME. `setpriv` then drops root again.
as_user=(sudo -n -E env "PATH=$PATH" "HOME=$HOME" setpriv
  "--reuid=$(id -u)" --init-groups)
launcher=("${as_user[@]}" "--regid=$(id -g)" --)
EVAL_ROACH_LAUNCHER=$(
  node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' \
    "${launcher[@]}"
)
export EVAL_ROACH_LAUNCHER

exec "${as_user[@]}" "--regid=$jail_gid" -- "$@"
