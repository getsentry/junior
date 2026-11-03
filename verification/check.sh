#!/usr/bin/env bash
# Run the model checks in checks.txt and compare each result with its
# expected result. Usage: ./check.sh [filter-regex]
# Needs quint (npm i -g @informalsystems/quint) and Java 17+. Keep JOBS low:
# each TLC run starts its own Java process.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
out="${OUT:-$here/.out}"
jobs="${JOBS:-1}"
filter="${1:-.}"
mkdir -p "$out"

run_one() {
  local n="$1" file="$2" main="$3" kind="$4" prop="$5" expect="$6"
  local port=$((8900 + n)) log="$out/$main.$prop.log" flag
  case "$kind" in
    inv) flag="--invariant" ;;
    temporal) flag="--temporal" ;;
  esac
  local dir="$out/work/$main.$prop"
  mkdir -p "$dir"
  local start=$(date +%s)
  (cd "$dir" && timeout "${TIMEOUT:-3600}" quint verify --backend tlc \
    --server-endpoint "localhost:$port" --main "$main" "$flag" "$prop" \
    "$here/$file") >"$log" 2>&1
  local code=$? secs=$(( $(date +%s) - start ))
  local got states
  if grep -q '^\[ok\]' "$log"; then got=holds
  elif grep -q '^\[violation\]' "$log"; then got=violated
  else got="error($code)"; fi
  states=$(grep -oE '[0-9]+ distinct states found' "$log" | tail -1 | cut -d' ' -f1)
  local mark=PASS
  [ "$got" = "$expect" ] || mark=FAIL
  printf '%s %-34s %-34s %-9s %-9s %6ss %s states\n' "$mark" "$main" "$prop" "$expect" "$got" "$secs" "${states:-?}"
}
export -f run_one
export here out

grep -vE '^\s*(#|$)' "$here/checks.txt" | grep -E "$filter" | nl -w1 -s' ' |
  xargs -P "$jobs" -L 1 bash -c 'run_one "$@"' _ | tee "$out/summary.txt"
! grep -q '^FAIL' "$out/summary.txt"
