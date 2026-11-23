#!/bin/bash
# Run xcodebuild for the Junior iOS app with the shared compilation cache.
# One cache per machine (content-addressed, safe across checkouts); DerivedData
# stays per checkout because build products from different branches collide.
# Usage: scripts/xcbuild.sh <xcodebuild action and args…>
set -euo pipefail

ios_dir="$(cd "$(dirname "$0")/.." && pwd)"
cache_dir="${JUNIOR_IOS_CACHE:-$HOME/Library/Caches/ios-agent-build.noindex}"
derived="$ios_dir/.build.noindex/DerivedData"
mkdir -p "$cache_dir/cas" "$derived"

# The project lists files explicitly. `--use-cache` regenerates whenever the
# spec or the set of source files changes, and skips it otherwise.
(cd "$ios_dir" && xcodegen generate --quiet --use-cache --cache-path "$ios_dir/.build.noindex/xcodegen-cache")

# The prefix mappings remove the checkout path from cache keys, so a new
# worktree reuses compiled work.
exec xcodebuild \
  -project "$ios_dir/Junior.xcodeproj" \
  -derivedDataPath "$derived" \
  -jobs "${JUNIOR_IOS_JOBS:-4}" \
  -collect-test-diagnostics never \
  "$@" \
  COMPILATION_CACHE_ENABLE_CACHING=YES \
  COMPILATION_CACHE_CAS_PATH="$cache_dir/cas" \
  SWIFT_ENABLE_PREFIX_MAPPING=YES SWIFT_ENABLE_PROJECT_PREFIX_MAPPING=YES \
  CLANG_ENABLE_PREFIX_MAPPING=YES CLANG_ENABLE_PROJECT_PREFIX_MAPPING=YES \
  SWIFT_OTHER_PREFIX_MAPPINGS="$ios_dir=/^checkout" \
  CLANG_OTHER_PREFIX_MAPPINGS="$ios_dir=/^checkout" \
  COMPILER_INDEX_STORE_ENABLE=NO \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES
