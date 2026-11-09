#!/bin/bash
# Deploys the bridge into a Proxmox LXC container, creating the container on the first run.
# Run it from your Mac in this checkout; it ships the committed code over SSH, so the container
# needs no GitHub access. Run it again after pulling changes to update.
#
#   ./deploy/proxmox/deploy.sh root@192.168.1.151 --awtrix-host 192.168.1.50
#
# Options (all optional after the first run):
#   --ctid N            Container ID (default: the existing tc002-now-playing container, else the next free ID)
#   --awtrix-host IP    Clock's IP; written to the config on first run, or updated if given later
#   --template NAME     LXC template (default: the cached Ubuntu 24.04 one)
#   --storage NAME      Root disk storage (default: local-lvm)
set -euo pipefail

PVE="${1:?Usage: deploy.sh root@<proxmox-host> [--ctid N] [--awtrix-host IP]}"
shift
CTID=""
AWTRIX_HOST=""
TEMPLATE="local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
STORAGE="local-lvm"
HOSTNAME_CT="tc002-now-playing"
while [ $# -gt 0 ]; do
  case "$1" in
    --ctid) CTID="$2"; shift 2 ;;
    --awtrix-host) AWTRIX_HOST="$2"; shift 2 ;;
    --template) TEMPLATE="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "Note: uncommitted changes are not deployed; only HEAD is shipped." >&2
fi

pve() { ssh -o BatchMode=yes "$PVE" "$@"; }
ct() { pve pct exec "$CTID" -- "$@"; }
# SSH flattens arguments into one string, so anything with quoting goes in as a script on stdin.
ct_script() { pve "pct exec $CTID -- bash -s"; }

if [ -z "$CTID" ]; then
  CTID="$(pve "pct list | awk '\$NF == \"$HOSTNAME_CT\" {print \$1}'" | head -1)"
fi

if [ -z "$CTID" ] || ! pve pct status "$CTID" >/dev/null 2>&1; then
  CTID="${CTID:-$(pve pvesh get /cluster/nextid)}"
  echo "==> Creating container $CTID ($HOSTNAME_CT)"
  pve pct create "$CTID" "$TEMPLATE" \
    --hostname "$HOSTNAME_CT" --unprivileged 1 --features nesting=1 \
    --cores 1 --memory 512 --swap 256 --rootfs "$STORAGE:4" \
    --net0 name=eth0,bridge=vmbr0,ip=dhcp --onboot 1 \
    --tags tc002 --description "'TC002 Now Playing bridge (github.com/jermdw/tc002-now-playing)'"
fi

if [ "$(pve pct status "$CTID" | awk '{print $2}')" != "running" ]; then
  echo "==> Starting container $CTID"
  pve pct start "$CTID"
fi

echo "==> Waiting for the network"
for _ in $(seq 1 30); do
  IP="$(ct hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$IP" ] && ct getent hosts deb.nodesource.com >/dev/null 2>&1 && break
  sleep 2
done
[ -n "${IP:-}" ] || { echo "Container has no IP address" >&2; exit 1; }

if ! ct_script <<<'command -v node >/dev/null && node -e "process.exit(+process.versions.node.split(\".\")[0] >= 22 ? 0 : 1)"'; then
  echo "==> Installing Node.js 22 from the NodeSource apt repository"
  ct_script <<'SCRIPT'
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg openssl >/dev/null
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs >/dev/null
SCRIPT
fi

echo "==> Shipping $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
ct_script <<'SCRIPT'
id tc002 >/dev/null 2>&1 || useradd --system --home-dir /var/lib/tc002-now-playing --shell /usr/sbin/nologin tc002
install -d -o tc002 -g tc002 -m 0750 /var/lib/tc002-now-playing
rm -rf /opt/tc002-now-playing.new && mkdir -p /opt/tc002-now-playing.new
SCRIPT
git -C "$REPO_ROOT" archive --format=tar HEAD src berry package.json package-lock.json deploy/proxmox/tc002-now-playing.service \
  | pve "pct exec $CTID -- tar -x -C /opt/tc002-now-playing.new"
ct_script <<'SCRIPT'
  set -e
  cd /opt/tc002-now-playing.new
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  install -m 0644 deploy/proxmox/tc002-now-playing.service /etc/systemd/system/tc002-now-playing.service
  rm -rf /opt/tc002-now-playing.old
  [ -d /opt/tc002-now-playing ] && mv /opt/tc002-now-playing /opt/tc002-now-playing.old
  mv /opt/tc002-now-playing.new /opt/tc002-now-playing
  rm -rf /opt/tc002-now-playing.old
SCRIPT

ENV_FILE=/etc/tc002-now-playing.env
if ! ct test -f "$ENV_FILE"; then
  echo "==> Writing $ENV_FILE with a new push token"
  ct_script <<SCRIPT
umask 027
cat > $ENV_FILE <<CONF
AWTRIX_HOST=${AWTRIX_HOST}
AWTRIX_PORT=80
AWTRIX_APP_NAME=now-playing
AUTO_INSTALL_SCRIPT=true
PORT=8765
SERVER_LAN_URL=http://${IP}:8765
PUSH_TOKEN=\$(openssl rand -hex 32)
CONF
chgrp tc002 $ENV_FILE
SCRIPT
elif [ -n "$AWTRIX_HOST" ]; then
  ct_script <<<"sed -i 's/^AWTRIX_HOST=.*/AWTRIX_HOST=${AWTRIX_HOST}/' $ENV_FILE"
fi
# Keep SERVER_LAN_URL in step if DHCP handed out a new address
ct_script <<<"sed -i 's#^SERVER_LAN_URL=.*#SERVER_LAN_URL=http://${IP}:8765#' $ENV_FILE"

echo "==> Restarting the service"
ct systemctl daemon-reload
ct systemctl enable --quiet tc002-now-playing
ct systemctl restart tc002-now-playing
for _ in $(seq 1 15); do
  ct curl -fsS -o /dev/null http://127.0.0.1:8765/healthz 2>/dev/null && break
  sleep 1
done
ct curl -fsS -o /dev/null http://127.0.0.1:8765/healthz || { ct journalctl -u tc002-now-playing -n 30 --no-pager; exit 1; }

cat <<DONE

Bridge is running in container $CTID: http://${IP}:8765
Config: $ENV_FILE inside the container (pct enter $CTID). Logs: journalctl -u tc002-now-playing
Reserve ${IP} for this container in your router so the clock and the Mac agent keep finding it.
DONE
