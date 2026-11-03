#!/usr/bin/env bash
# Run the TLC checks in checks.txt and compare each result with its expected
# result. Usage: ./check.sh [filter-regex]. Needs Java 11+. Set TLA2TOOLS to
# a tla2tools.jar, or the script downloads the pinned release. A violated
# check writes its trace to .out/<instance>.<property>.trace.json; print it
# with trace.py.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
out="${OUT:-$here/.out}"
filter="${1:-.}"
version=1.8.0
sha=c57d4d7bbee3ed2c89c32cb9c60cac728f751e80e2570bc4b7368ae39291fc21
jar="${TLA2TOOLS:-$here/.cache/tla2tools-$version.jar}"
mkdir -p "$out"

if [ ! -f "$jar" ]; then
  mkdir -p "$(dirname "$jar")"
  curl -fsSL -o "$jar" \
    "https://github.com/tlaplus/tlaplus/releases/download/v$version/tla2tools.jar" || exit 1
  echo "$sha  $jar" | sha256sum -c - >/dev/null || { echo "bad checksum: $jar"; exit 1; }
fi

: >"$out/summary.txt"
grep -vE '^\s*(#|$)' "$here/checks.txt" | grep -E "$filter" |
while read -r module instance spec kind prop expect; do
  name="$instance.$prop"
  dir="$out/work/$name"
  rm -rf "$dir" "$out/$name.trace.json" && mkdir -p "$dir"
  cp "$here/$module.tla" "$dir/"
  { cat "$here/cfg/$instance.cfg"; echo "SPECIFICATION $spec"
    for p in ${prop//,/ }; do echo "$kind $p"; done; } >"$dir/check.cfg"
  start=$(date +%s)
  (cd "$dir" && timeout "${TIMEOUT:-3600}" java -XX:+UseParallelGC -Xmx"${HEAP:-6g}" \
    -cp "$jar" tlc2.TLC -deadlock -workers "${WORKERS:-auto}" -cleanup \
    -dumpTrace json "$out/$name.trace.json" \
    -config check.cfg "$module.tla") >"$out/$name.log" 2>&1 </dev/null
  code=$?
  secs=$(($(date +%s) - start))
  if grep -q 'No error has been found' "$out/$name.log"; then got=holds
  elif grep -qE 'is violated|Temporal propert(y|ies) .*was violated|Temporal properties were violated' "$out/$name.log"; then got=violated
  else got="error($code)"; fi
  states=$(grep -oE '[0-9]+ distinct states found' "$out/$name.log" | tail -1 | cut -d' ' -f1)
  mark=PASS
  [ "$got" = "$expect" ] || mark=FAIL
  printf '%s %-26s %-15s %-34s %-9s %-9s %6ss %s states\n' \
    "$mark" "$instance" "$spec" "$prop" "$expect" "$got" "$secs" "${states:-?}" | tee -a "$out/summary.txt"
done
! grep -q '^FAIL' "$out/summary.txt"
