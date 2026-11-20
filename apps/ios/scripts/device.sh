#!/bin/bash
# Build Junior for the connected iPhone, install it, and open it there.
# Signing.xcconfig has the signing settings; run `make signing` first. With more
# than one iPhone connected, set JUNIOR_IOS_DEVICE to a device name or id.
# Usage: scripts/device.sh [app launch arguments…]
set -euo pipefail

ios_dir="$(cd "$(dirname "$0")/.." && pwd)"

devices_json="$(mktemp)"
trap 'rm -f "$devices_json"' EXIT
xcrun devicectl list devices --json-output "$devices_json" >/dev/null

# devicectl addresses a device by its CoreDevice id, xcodebuild by its UDID.
read -r device_id udid < <(
  python3 - "$devices_json" "${JUNIOR_IOS_DEVICE:-}" <<'PY'
import json, sys
wanted = sys.argv[2]
devices = [
    d for d in json.load(open(sys.argv[1]))["result"]["devices"]
    if d["hardwareProperties"].get("platform") == "iOS"
    and d["connectionProperties"].get("pairingState") == "paired"
    and (not wanted or wanted in (d["identifier"], d["hardwareProperties"].get("udid"), d["deviceProperties"].get("name")))
]
if len(devices) != 1:
    names = ", ".join(d["deviceProperties"].get("name", "?") for d in devices) or "none"
    sys.exit(f"Need one paired iPhone; found {names}. Set JUNIOR_IOS_DEVICE to choose.")
print(devices[0]["identifier"], devices[0]["hardwareProperties"]["udid"])
PY
)

"$ios_dir/scripts/xcbuild.sh" build -scheme Junior -configuration Debug \
  -destination "id=$udid" -allowProvisioningUpdates -allowProvisioningDeviceRegistration -quiet

app="$ios_dir/.build.noindex/DerivedData/Build/Products/Debug-iphoneos/Junior.app"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
xcrun devicectl device install app --device "$device_id" "$app"
# `--` keeps the app's arguments (`-JuniorServer …`) from devicectl's own options.
xcrun devicectl device process launch --device "$device_id" --terminate-existing "$bundle_id" -- "$@"
