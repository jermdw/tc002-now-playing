#!/bin/bash
# Installs the Now Playing agent as a launchd service, so it starts at login and restarts if it exits.
# Usage: BRIDGE_URL=http://192.168.1.100:8765 PUSH_TOKEN=... ./agent/install-launchd.sh
set -euo pipefail

: "${PUSH_TOKEN:?Set PUSH_TOKEN to the same value as the bridge}"
BRIDGE_URL="${BRIDGE_URL:-http://127.0.0.1:8765}"

LABEL="local.tc002-now-playing.agent"
AGENT_PATH="$(cd "$(dirname "$0")" && pwd)/mac-now-playing-agent.mjs"
NODE_PATH="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/tc002-now-playing-agent.log"

mkdir -p "$(dirname "$PLIST")"
touch "$PLIST"
chmod 600 "$PLIST" # holds the push token

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$AGENT_PATH</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRIDGE_URL</key><string>$BRIDGE_URL</string>
    <key>PUSH_TOKEN</key><string>$PUSH_TOKEN</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed $LABEL (logs: $LOG)"
echo "To remove it:"
echo "  launchctl bootout gui/$(id -u)/$LABEL && rm \"$PLIST\""
