#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${FLEET_GITHUB_REPO:-xepes0/sui-fleet-manager}"
TAG="${FLEET_RELEASE_TAG:-staging-latest}"
SERVICE="${FLEET_SERVICE:-sui-fleet-manager.service}"
BIN_PATH="${FLEET_BIN_PATH:-/opt/sui-fleet-manager/fleet-manager}"
DATA_DIR="${FLEET_DATA_DIR:-/var/lib/sui-fleet-manager}"
BACKUP_ROOT="${FLEET_DEPLOY_BACKUP_DIR:-/var/backups/sui-fleet-manager}"
HEALTH_URL="${FLEET_HEALTH_URL:-https://127.0.0.1:18780/healthz}"

ASSET="fleet-manager-linux-amd64"
BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

if [[ ${EUID} -ne 0 ]]; then
  echo "error: run this deploy script as root" >&2
  exit 1
fi

for cmd in curl sha256sum systemctl install mktemp cp rm mkdir date; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "error: required command not found: $cmd" >&2
    exit 1
  }
done

if [[ ! -x "$BIN_PATH" ]]; then
  echo "error: current fleet-manager binary not found: $BIN_PATH" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "==> Downloading ${REPO} ${TAG}"
curl --proto '=https' --tlsv1.2 -fL   --retry 3 --retry-all-errors   "$BASE_URL/$ASSET"   -o "$tmpdir/$ASSET"

curl --proto '=https' --tlsv1.2 -fL   --retry 3 --retry-all-errors   "$BASE_URL/$ASSET.sha256"   -o "$tmpdir/$ASSET.sha256"

echo "==> Verifying SHA256"
(
  cd "$tmpdir"
  sha256sum -c "$ASSET.sha256"
)

chmod 0755 "$tmpdir/$ASSET"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$BACKUP_ROOT/$stamp"
mkdir -p "$backup_dir"

echo "==> Backing up current binary"
cp -a "$BIN_PATH" "$backup_dir/fleet-manager.before"

echo "==> Stopping $SERVICE"
systemctl stop "$SERVICE"

for file in fleet.db fleet.db-wal fleet.db-shm; do
  if [[ -e "$DATA_DIR/$file" ]]; then
    cp -a "$DATA_DIR/$file" "$backup_dir/$file"
  fi
done

rollback() {
  echo "==> Deployment failed; rolling back" >&2
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true

  install -m 0755 "$backup_dir/fleet-manager.before" "$BIN_PATH"

  if [[ -e "$backup_dir/fleet.db" ]]; then
    rm -f "$DATA_DIR/fleet.db" "$DATA_DIR/fleet.db-wal" "$DATA_DIR/fleet.db-shm"
    for file in fleet.db fleet.db-wal fleet.db-shm; do
      if [[ -e "$backup_dir/$file" ]]; then
        cp -a "$backup_dir/$file" "$DATA_DIR/$file"
      fi
    done
  fi

  systemctl start "$SERVICE" || true

  if systemctl is-active --quiet "$SERVICE"; then
    echo "==> Rollback service is running"
  else
    echo "error: rollback completed but service is not active" >&2
  fi

  echo "Backup retained at: $backup_dir" >&2
  exit 1
}

echo "==> Installing verified binary"
if ! install -m 0755 "$tmpdir/$ASSET" "$BIN_PATH"; then
  rollback
fi

echo "==> Starting $SERVICE"
if ! systemctl start "$SERVICE"; then
  rollback
fi

echo "==> Waiting for health check"
healthy=0
for _ in {1..15}; do
  if systemctl is-active --quiet "$SERVICE" &&      curl -kfsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" -ne 1 ]]; then
  rollback
fi

echo "==> Deployment successful"
sha256sum "$BIN_PATH"
systemctl --no-pager --full status "$SERVICE" | head -30 || true
echo "Backup retained at: $backup_dir"
