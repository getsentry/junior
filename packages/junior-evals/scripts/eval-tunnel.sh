#!/usr/bin/env bash
# Run an eval command behind an account-backed Cloudflare Tunnel.
#
# Usage:
#   scripts/eval-tunnel.sh run <command> [args...]
#   scripts/eval-tunnel.sh cleanup
#
# `run` creates one remotely managed tunnel and one proxied DNS record for
# this job, starts cloudflared, and waits until the Cloudflare nameservers
# serve the record. It then runs the command with `JUNIOR_EVAL_EGRESS_URL`
# and `JUNIOR_EVAL_EGRESS_PORT`, and without the Cloudflare variables.
# `src/eval-egress.ts` serves that port. When `run` exits, it removes the
# tunnel and the record.
#
# `cleanup` removes them if the runner stopped `run` first. CI runs it in an
# `always()` step.
#
# Needs `cf`, `cloudflared`, `jq`, `dig`, and `openssl`, and the variables
# CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, and
# CLOUDFLARE_TUNNEL_BASE_DOMAIN. See `evals/github-actions.md`.
set -euo pipefail

port=18787
# Cloudflare can take minutes to serve a new record.
dns_timeout_seconds=300
state="${RUNNER_TEMP:?}/junior-eval-tunnel.env"
export CF_QUIET=1 DO_NOT_TRACK=1

tunnel_id=""
record_id=""
connector=""

save() {
  printf 'tunnel_id=%q\nrecord_id=%q\n' "$tunnel_id" "$record_id" >"$state"
}

cleanup() {
  [[ -f "$state" ]] || return 0
  # shellcheck source=/dev/null
  source "$state"
  if [[ -n "$record_id" ]]; then
    cf dns records delete "$record_id" --force >/dev/null
    record_id=""
    save
  fi
  if [[ -n "$tunnel_id" ]]; then
    cf tunnels connections cleanup "$tunnel_id" --force >/dev/null
    cf tunnels delete "$tunnel_id" --force >/dev/null
  fi
  rm -f "$state"
  echo "Removed eval tunnel $tunnel_id"
}

stop() {
  if [[ -n "$connector" ]]; then
    kill "$connector" 2>/dev/null || true
    wait "$connector" 2>/dev/null || true
  fi
  cleanup
}

# Ask each Cloudflare nameserver directly. A recursive lookup before the
# record exists can cache NXDOMAIN for the negative TTL of the zone.
published() {
  local hostname=$1 nameserver nameservers
  nameservers=$(dig +short NS "$CLOUDFLARE_TUNNEL_BASE_DOMAIN")
  [[ -n "$nameservers" ]] || return 1
  for nameserver in $nameservers; do
    [[ -n "$(dig +short +norecurse A "$hostname" "@$nameserver")" ]] || return 1
  done
}

run() {
  : "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" \
    "${CLOUDFLARE_ZONE_ID:?}" "${CLOUDFLARE_TUNNEL_BASE_DOMAIN:?}"
  if [[ -e "$state" ]]; then
    echo "$state exists. Run cleanup first." >&2
    exit 1
  fi

  local name hostname tunnel token
  name="sentry-ci-$(openssl rand -hex 12)"
  hostname="$name.$CLOUDFLARE_TUNNEL_BASE_DOMAIN"
  trap stop EXIT
  trap 'exit 130' INT TERM

  echo "Creating eval tunnel $name at https://$hostname"
  tunnel=$(cf tunnels create --name "$name" --config-source cloudflare)
  tunnel_id=$(jq -r .id <<<"$tunnel")
  save
  token=$(jq -r .token <<<"$tunnel")
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::add-mask::$token"; fi

  cf tunnels config update "$tunnel_id" --body "$(
    jq -nc --arg hostname "$hostname" --arg service "http://127.0.0.1:$port" \
      '{config: {ingress: [{hostname: $hostname, service: $service}, {service: "http_status:404"}]}}'
  )" >/dev/null
  record_id=$(cf dns records create --body "$(
    jq -nc --arg name "$hostname" --arg content "$tunnel_id.cfargotunnel.com" \
      '{type: "CNAME", name: $name, content: $content, proxied: true, ttl: 1}'
  )" | jq -r .id)
  save

  env -u CLOUDFLARE_API_TOKEN TUNNEL_TOKEN="$token" \
    cloudflared tunnel --no-autoupdate --loglevel error --protocol http2 \
    --grace-period 5s run &
  connector=$!

  local deadline=$((SECONDS + dns_timeout_seconds))
  until published "$hostname"; do
    if ((SECONDS >= deadline)); then
      echo "Cloudflare did not serve $hostname within ${dns_timeout_seconds}s" >&2
      exit 1
    fi
    sleep 2
  done
  echo "Cloudflare serves $hostname after $((SECONDS + dns_timeout_seconds - deadline))s"

  local code=0
  env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID -u CLOUDFLARE_ZONE_ID \
    -u CLOUDFLARE_TUNNEL_BASE_DOMAIN \
    JUNIOR_EVAL_EGRESS_URL="https://$hostname" JUNIOR_EVAL_EGRESS_PORT="$port" \
    "$@" || code=$?
  exit "$code"
}

case "${1:-}" in
run)
  shift
  [[ $# -gt 0 ]] || {
    echo "Usage: $0 run <command> [args...]" >&2
    exit 2
  }
  run "$@"
  ;;
cleanup) cleanup ;;
*)
  echo "Usage: $0 <run|cleanup> ..." >&2
  exit 2
  ;;
esac
