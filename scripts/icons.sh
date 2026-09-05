#!/usr/bin/env bash
set -euo pipefail

master="${1:?usage: scripts/icons.sh <master-1024.png>}"
icons="src-tauri/icons"
icns_budget=$((1024 * 1024))

oxipng=$(type -P oxipng || echo "nix run nixpkgs#oxipng --")

master_copy="$(mktemp -t trunk-icon-master).png"
cp "$master" "$master_copy"
bun run tauri icon "$master_copy"
rm -rf "$icons/android" "$icons/ios" "$icons/64x64.png"

iconset="$(mktemp -d -t trunk-iconset)/icon.iconset"
mkdir "$iconset"
for spec in 16:16x16 32:16x16@2x 32:32x32 64:32x32@2x 128:128x128 256:256x256 512:512x512; do
    px="${spec%%:*}"
    name="${spec#*:}"
    sips -z "$px" "$px" "$master_copy" --out "$iconset/icon_$name.png" >/dev/null
done

$oxipng -o max --strip safe --nc --np --nb --quiet "$iconset"/*.png "$icons"/*.png
iconutil -c icns "$iconset" -o "$icons/icon.icns"

size=$(stat -f %z "$icons/icon.icns")
if (( size > icns_budget )); then
    echo "icon.icns is $size bytes, over the $icns_budget budget" >&2
    exit 1
fi
echo "icon.icns: $size bytes"
