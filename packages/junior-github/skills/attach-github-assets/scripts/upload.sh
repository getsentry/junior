#!/usr/bin/env bash
set -euo pipefail

file_path="${1:-}"
repository="${2:-}"

if [[ -z "$file_path" ]]; then
  echo "Usage: upload.sh <file-path> [owner/repo]" >&2
  exit 1
fi

if [[ ! -f "$file_path" ]]; then
  echo "Error: File not found: $file_path" >&2
  exit 1
fi

filename=$(basename "$file_path")
extension="${filename##*.}"
extension=$(printf '%s' "$extension" | tr '[:upper:]' '[:lower:]')

case "$extension" in
  png) mime_type="image/png" ;;
  jpg|jpeg) mime_type="image/jpeg" ;;
  gif) mime_type="image/gif" ;;
  webp) mime_type="image/webp" ;;
  svg) mime_type="image/svg+xml" ;;
  mov) mime_type="video/quicktime" ;;
  mp4) mime_type="video/mp4" ;;
  webm) mime_type="video/webm" ;;
  *)
    echo "Error: Unsupported file type '.$extension'. Supported: png, jpg, jpeg, gif, webp, svg, mov, mp4, webm" >&2
    exit 1
    ;;
esac

if [[ -z "$repository" ]] && command -v jr-rpc >/dev/null 2>&1; then
  repository=$(jr-rpc config get github.repo 2>/dev/null || true)
fi

if [[ -z "$repository" ]]; then
  remote_url=$(git remote get-url origin 2>/dev/null || true)
  case "$remote_url" in
    git@github.com:*) repository="${remote_url#git@github.com:}" ;;
    https://github.com/*) repository="${remote_url#https://github.com/}" ;;
  esac
  repository="${repository%.git}"
fi

if [[ ! "$repository" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
  echo "Error: Could not resolve a GitHub repository. Pass owner/repo as the second argument or configure github.repo." >&2
  exit 1
fi

repository_id=$(gh api "repos/$repository" --jq '.id')
encoded_name=$(printf '%s' "$filename" | jq -sRr @uri)
encoded_mime=$(printf '%s' "$mime_type" | jq -sRr @uri)
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

http_code=$(curl --silent --show-error \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/octet-stream' \
  --header 'Accept: application/json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  --data-binary "@$file_path" \
  "https://uploads.github.com/user-attachments/assets?name=$encoded_name&content_type=$encoded_mime&repository_id=$repository_id")

if [[ "$http_code" != "201" ]]; then
  echo "Error: Upload failed with HTTP $http_code" >&2
  cat "$response_file" >&2
  exit 1
fi

asset_url=$(jq -r '.url // empty' "$response_file")
if [[ -z "$asset_url" ]]; then
  echo "Error: GitHub upload response did not include an asset URL." >&2
  cat "$response_file" >&2
  exit 1
fi

printf '%s\n' "$asset_url"
