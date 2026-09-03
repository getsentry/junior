#!/bin/sh
set -eu

workspace_root=$(cd "$(dirname "$0")/.." && pwd)
archive_dir=$(mktemp -d)
trap 'rm -rf "$archive_dir"' EXIT

for package_name in \
  junior \
  junior-dashboard \
  junior-github \
  junior-gocd \
  junior-linear \
  junior-memory \
  junior-plugin-api \
  junior-sentry \
  junior-vercel
do
  package_dir="$workspace_root/packages/$package_name"
  archive="$archive_dir/$package_name.tgz"
  pnpm --dir "$package_dir" --config.ignore-scripts=true pack --out "$archive" >/dev/null
  pnpm --dir "$workspace_root" exec attw "$archive" --profile esm-only --quiet
done
