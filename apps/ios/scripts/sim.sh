#!/bin/bash
# Run the Junior app on one throwaway simulator, then delete it.
#
#   scripts/sim.sh shots <out-dir> <shot>…   install, open each shot, save PNGs
#   scripts/sim.sh ui-test <Suite[/test]>…   build-for-testing, then run those UI tests
#
# A shot is `name|path|theme`, for example `home|/|dark` or
# `inbox|/review|light`. The path is a dashboard route; the app opens it.
#
# Machine rules (one simulator can take ~10 GB): take a machine-wide lock,
# wait for no other booted simulator and for idle CPU, build before booting,
# and always shut down and delete the device this run created.
#
# JUNIOR_IOS_REUSE_UDID=<udid> uses a simulator that is already booted
# instead of booting a second one. The run installs the app there and
# uninstalls it at the end; it never shuts that simulator down.
set -euo pipefail

ios_dir="$(cd "$(dirname "$0")/.." && pwd)"
lock_dir="/tmp/ios-simulator.lock"
device_prefix="junior-throwaway"
device_type="${JUNIOR_IOS_DEVICE:-com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}"
server="${JUNIOR_IOS_SERVER:-http://127.0.0.1:4317}"
fixed_now="${JUNIOR_IOS_NOW:-2026-08-07T12:00:00Z}"
udid=""
reused="${JUNIOR_IOS_REUSE_UDID:-}"

log() { echo "sim: $*" >&2; }

acquire_lock() {
  local waited=0
  until mkdir "$lock_dir" 2>/dev/null; do
    local owner
    owner="$(cat "$lock_dir/pid" 2>/dev/null || true)"
    # A dead owner, or no pid a minute after the lock appeared (the owner died
    # between mkdir and writing it), means the lock is stale. Rename it first:
    # only one waiter's rename succeeds, so two cannot both take over.
    if { [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; } ||
      { [[ -z "$owner" ]] && (($(date +%s) - $(stat -f %m "$lock_dir" 2>/dev/null || date +%s) > 60)); }; then
      if mv "$lock_dir" "$lock_dir.stale.$$" 2>/dev/null; then
        # Another waiter may have taken over first; if the lock we moved is
        # not the one judged stale, put it back.
        if [[ "$(cat "$lock_dir.stale.$$/pid" 2>/dev/null || true)" != "$owner" ]] &&
          mv "$lock_dir.stale.$$" "$lock_dir" 2>/dev/null; then
          continue
        fi
        log "took over a stale lock from ${owner:-an unknown run}"
        rm -rf "$lock_dir.stale.$$"
      fi
      continue
    fi
    ((waited % 30 == 0)) && log "waiting for simulator lock (held by ${owner:-unknown})"
    sleep 2
    waited=$((waited + 2))
    ((waited < 1800)) || { log "gave up waiting for the lock"; exit 1; }
  done
  echo $$ >"$lock_dir/pid"
}

release() {
  if [[ -n "$reused" ]]; then
    xcrun simctl terminate "$reused" io.sentry.junior >/dev/null 2>&1 || true
    # The UI test runner too: it aborts when opened by hand.
    for bundle in io.sentry.junior io.sentry.junior.uitests.xctrunner; do
      xcrun simctl uninstall "$reused" "$bundle" >/dev/null 2>&1 || true
    done
    log "uninstalled the app and its test runner from $reused (left it booted)"
  elif [[ -n "$udid" ]]; then
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
    log "deleted $udid"
  fi
  if [[ "$(cat "$lock_dir/pid" 2>/dev/null || true)" == "$$" ]]; then
    rm -rf "$lock_dir"
  fi
}
trap release EXIT
trap 'exit 130' INT TERM

delete_leftovers() {
  xcrun simctl list devices -j |
    jq -r --arg p "$device_prefix" '.devices[][] | select(.name | startswith($p)) | .udid' |
    while read -r stale; do
      log "deleting leftover $stale"
      xcrun simctl shutdown "$stale" >/dev/null 2>&1 || true
      xcrun simctl delete "$stale" >/dev/null 2>&1 || true
    done
}

wait_for_no_booted() {
  local waited=0
  while [[ -n "$(xcrun simctl list devices booted -j | jq -r '.devices[][] | .udid')" ]]; do
    if [[ "${JUNIOR_IOS_ALLOW_BOOTED:-0}" == "1" ]]; then
      log "other simulators are booted; continuing because JUNIOR_IOS_ALLOW_BOOTED=1"
      return
    fi
    ((waited % 60 == 0)) && log "waiting for other booted simulators to shut down"
    sleep 5
    waited=$((waited + 5))
    ((waited < 1800)) || { log "another simulator stayed booted; not booting a second one"; exit 1; }
  done
}

wait_for_idle_cpu() {
  local waited=0 idle_for=0
  while ((idle_for < 10)); do
    local idle
    idle="$(top -l 2 -n 0 -s 1 | awk '/CPU usage/ {v=$7} END {sub("%","",v); print int(v)}')"
    if ((idle >= 30)); then idle_for=$((idle_for + 2)); else idle_for=0; fi
    waited=$((waited + 2))
    ((waited < 300)) || { log "CPU stayed busy; booting anyway"; return; }
  done
}

latest_runtime() {
  xcrun simctl list runtimes -j |
    jq -r '[.runtimes[] | select(.platform == "iOS" and .isAvailable)] | sort_by(.version) | last | .identifier'
}

boot_device() {
  if [[ -n "$reused" ]]; then
    xcrun simctl list devices booted -j | jq -e --arg u "$reused" '[.devices[][] | .udid] | index($u)' >/dev/null ||
      { log "$reused is not booted"; exit 1; }
    udid="$reused"
    return
  fi
  udid="$(xcrun simctl create "$device_prefix-$$" "$device_type" "$(latest_runtime)")"
  log "created $udid"
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiMode active \
    --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
}

app_path() {
  echo "$ios_dir/.build.noindex/DerivedData/Build/Products/Debug-iphonesimulator/Junior.app"
}

cmd_shots() {
  local out="$1"
  shift
  mkdir -p "$out"
  "$ios_dir/scripts/xcbuild.sh" build -scheme Junior -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' -quiet
  acquire_lock
  delete_leftovers
  if [[ -z "$reused" ]]; then
    wait_for_no_booted
    wait_for_idle_cpu
  fi
  boot_device
  xcrun simctl install "$udid" "$(app_path)"
  for shot in "$@"; do
    IFS='|' read -r name path theme <<<"$shot"
    xcrun simctl terminate "$udid" io.sentry.junior >/dev/null 2>&1 || true
    [[ -n "$reused" ]] || xcrun simctl ui "$udid" appearance "${theme:-dark}"
    xcrun simctl launch "$udid" io.sentry.junior \
      -JuniorServer "$server" -JuniorFixedNow "$fixed_now" \
      -JuniorOpen "$path" -JuniorTheme "${theme:-dark}" -JuniorAccessToken mock-access-token >/dev/null
    sleep "${JUNIOR_IOS_SHOT_DELAY:-3}"
    xcrun simctl io "$udid" screenshot "$out/$name.png" >/dev/null
    log "saved $out/$name.png"
  done
}

cmd_ui_test() {
  (($# > 0)) || { log "name the UI tests to run, for example ui-test JuniorUITests/testHome"; exit 2; }
  local only=("$@")
  "$ios_dir/scripts/xcbuild.sh" build-for-testing -scheme JuniorUITests -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' -quiet
  acquire_lock
  delete_leftovers
  if [[ -z "$reused" ]]; then
    wait_for_no_booted
    wait_for_idle_cpu
  fi
  boot_device
  local args=()
  for test in "${only[@]}"; do args+=("-only-testing:JuniorUITests/${test#JuniorUITests/}"); done
  # On a newly booted simulator, the first accessibility snapshot can take
  # 30 seconds and miss a test's wait. Run a failed test one more time.
  # xcodebuild passes TEST_RUNNER_<name> to the tests as <name>.
  TEST_RUNNER_JUNIOR_IOS_SERVER="$server" \
  "$ios_dir/scripts/xcbuild.sh" test-without-building -scheme JuniorUITests \
    -destination "platform=iOS Simulator,id=$udid" \
    -retry-tests-on-failure -test-iterations 2 "${args[@]}"
}

case "${1:-}" in
  shots) shift; cmd_shots "$@" ;;
  ui-test) shift; cmd_ui_test "$@" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
