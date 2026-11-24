#!/bin/sh
# Builds the app in release mode and wraps the binary in Yarvis.app, signed
# ad hoc, so it can be opened from Finder and post notifications (which need
# a bundle identifier). Usage: scripts/make-app.sh [output dir, default build/]
set -eu
cd "$(dirname "$0")/.."
out="${1:-build}"
app="$out/Yarvis.app"

swift build -c release --product YarvisMac
bin="$(swift build -c release --show-bin-path)/YarvisMac"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/Yarvis"

# The Review page draws verification flow diagrams with Mermaid, taken from
# the repo's node_modules rather than kept in this package. Without it the
# page shows each diagram's source instead.
mermaid="../../node_modules/mermaid/dist/mermaid.min.js"
if [ -f "$mermaid" ]; then
  cp "$mermaid" "$app/Contents/Resources/mermaid.min.js"
else
  echo "No $mermaid (run bun install at the repo root); flow diagrams will show as source." >&2
fi
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.yarvis.mac</string>
  <key>CFBundleName</key><string>Yarvis</string>
  <key>CFBundleDisplayName</key><string>Yarvis</string>
  <key>CFBundleExecutable</key><string>Yarvis</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <!-- Plain http is allowed only to a server on this Mac; the app refuses it elsewhere. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# The hardened runtime stops another process from loading code into the app
# and reading the token through its Keychain access.
codesign --force --sign - --options runtime --timestamp=none "$app"
codesign --verify --strict "$app"
echo "Built $app"
