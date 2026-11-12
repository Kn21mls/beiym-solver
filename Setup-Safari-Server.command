#!/bin/bash
set -euo pipefail
cd -- "$(dirname "$0")"

app="$PWD/Beyim Server.app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.beyimsolver.local-server</string>
  <key>CFBundleName</key><string>Beyim Server</string>
  <key>CFBundleExecutable</key><string>BeyimServer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>com.beyimsolver.local-server</string>
    <key>CFBundleURLSchemes</key><array><string>beyim-solver</string></array>
  </dict></array>
</dict>
</plist>
PLIST
swiftc macos/BeyimServer.swift -o "$app/Contents/MacOS/BeyimServer"
open "$app"
echo 'Готово. Сервер можно запускать из панели Beyim Solver в Safari.'
