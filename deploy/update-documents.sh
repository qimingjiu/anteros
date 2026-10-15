#!/usr/bin/env bash
# Incremental document-feature deployment. Does not replace .env, persona,
# chat databases, persisted model choices, or the SnowLuma container.
# Usage (Git Bash / Linux): bash deploy/update-documents.sh your-server [22]
set -Eeuo pipefail

DEST=${1:?Usage: bash deploy/update-documents.sh SSH_HOST [SSH_PORT]}
PORT=${2:-22}
[[ "$DEST" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo 'Invalid SSH host.' >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || { echo 'Invalid SSH port.' >&2; exit 2; }
PORT=$((10#$PORT))
(( PORT >= 1 && PORT <= 65535 )) || { echo 'Invalid SSH port.' >&2; exit 2; }
PROJ=$(cd "$(dirname "$0")/.." && pwd)
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10 -p "$PORT")
LOCAL_TMP_ROOT=$(cd "${TMPDIR:-/tmp}" && pwd -P)
LOCAL_WORK=$(mktemp -d "$LOCAL_TMP_ROOT/qq-bot-documents.XXXXXXXX")
trap '[[ "$LOCAL_WORK" == "$LOCAL_TMP_ROOT"/qq-bot-documents.* ]] && rm -rf -- "$LOCAL_WORK"' EXIT
ARCHIVE_NAME="qq-bot-documents-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}${RANDOM}.tgz"

# config.sim.yaml is a mock-only fixture required by the repository tests.
# Production .env/config.yaml/persona.md/data/ are deliberately absent.
PAYLOAD=(src scripts assets test package.json package-lock.json tsconfig.json README.md config.example.yaml config.sim.yaml)
for entry in "${PAYLOAD[@]}"; do
  [[ -e "$PROJ/$entry" && ! -L "$PROJ/$entry" ]] || { echo "Missing or symlinked payload entry: $entry" >&2; exit 1; }
done
tar -czf "$LOCAL_WORK/$ARCHIVE_NAME" -C "$PROJ" "${PAYLOAD[@]}"
echo 'Uploading source, bundled fonts, and mock tests.'
scp -q -o BatchMode=yes -o ConnectTimeout=10 -P "$PORT" "$LOCAL_WORK/$ARCHIVE_NAME" "$DEST:/tmp/$ARCHIVE_NAME"

ssh "${SSHOPT[@]}" "$DEST" "bash -s -- /tmp/$ARCHIVE_NAME" <<'REMOTE_SCRIPT'
set -Eeuo pipefail
umask 077
readonly BOT=/opt/qq-group-bot
readonly SERVICE=qq-group-bot
readonly CONTAINER=snowluma
readonly DOCS=/opt/snowluma-docker/data/qq-bot-documents
readonly PROVIDER_DOCS=/app/data/qq-bot-documents
readonly STATUS_URL=http://127.0.0.1:8642/api/status
ARCHIVE=${1:?Missing archive path}
[[ "$ARCHIVE" =~ ^/tmp/qq-bot-documents-[A-Za-z0-9-]+\.tgz$ ]] || { echo 'Invalid archive path.' >&2; exit 2; }
[[ $(id -u) == 0 ]] || { echo 'Run the remote update as root.' >&2; exit 1; }
[[ -d "$BOT" && ! -L "$BOT" ]] || { echo 'Expected a real /opt/qq-group-bot directory.' >&2; exit 1; }
[[ -f "$BOT/config.yaml" && ! -L "$BOT/config.yaml" ]] || { echo 'Missing or symlinked server config.' >&2; exit 1; }
systemctl is-active --quiet "$SERVICE" || { echo 'The bot must be running before this update.' >&2; exit 1; }
SERVICE_USER=$(systemctl show "$SERVICE" -p User --value)
[[ -z "$SERVICE_USER" || "$SERVICE_USER" == root ]] || { echo 'This update expects the existing bot service to run as root.' >&2; exit 1; }
docker inspect "$CONTAINER" >/dev/null

WORK=$(mktemp -d /opt/qq-group-bot-document-update.XXXXXXXX)
STAGE="$WORK/staging"
BACKUP="/opt/qq-group-bot-backups/documents-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"
ACTIVATED=0
SUCCESS=0
RECOVERED=0
MANAGED=(src scripts assets test package.json package-lock.json tsconfig.json README.md config.example.yaml config.sim.yaml)

clean_npm() {
  local folder=$1
  shift
  # Test/install subprocesses cannot inherit live model, OneBot, or tool keys.
  env -i PATH="$PATH" HOME="$WORK/npm-home" TMPDIR="$WORK/tmp" LANG=C.UTF-8 \
    npm --prefix "$folder" --userconfig=/dev/null "$@"
}

wait_status() {
  local require_documents=$1
  node --input-type=module - "$STATUS_URL" "$require_documents" <<'HEALTH_SCRIPT'
const [endpoint, requireDocuments] = process.argv.slice(2);
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(4_000) });
    if (response.ok) {
      const status = await response.json();
      const formats = status.documents?.formats;
      const documentsReady = requireDocuments !== 'true' || (status.documents?.enabled === true
        && Array.isArray(formats) && ['md', 'docx', 'pdf'].every(format => formats.includes(format)));
      if (status.provider?.connection === 'connected' && status.provider?.login === 'online' && documentsReady) {
        console.log(requireDocuments === 'true'
          ? 'Panel reachable; QQ connected/online; md/docx/pdf documents enabled.'
          : 'Restored panel reachable; QQ connected/online.');
        process.exit(0);
      }
    }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, Math.min(5_000, Math.max(0, deadline - Date.now()))));
}
console.error('Deployment health check timed out. Configuration and panel payload were not printed.');
process.exit(1);
HEALTH_SCRIPT
}

restore_service() {
  echo "Update failed; restoring the source and config saved at $BACKUP." >&2
  systemctl stop "$SERVICE" >/dev/null 2>&1 || { echo 'Could not stop the bot for recovery.' >&2; return 1; }
  # A failure can occur before the activation loop reaches node_modules.
  if [[ ! -d "$WORK/original-node_modules" && -d "$BOT/node_modules" ]]; then
    mv "$BOT/node_modules" "$WORK/original-node_modules" || return 1
  fi
  local entry
  for entry in "${MANAGED[@]}"; do
    # BOT and the entry names are fixed above; none of these are runtime data.
    rm -rf -- "$BOT/$entry" || return 1
  done
  if ! tar -xzf "$BACKUP/source-and-config.tgz" -C "$BOT"; then
    echo "Source restoration failed; backup remains at $BACKUP." >&2
    return 1
  fi

  # Reinstall the restored lockfile in isolation. Keep old dependencies intact
  # as a fallback if the npm registry is unavailable during recovery.
  mkdir -p "$WORK/rollback-install" || return 1
  cp "$BOT/package.json" "$BOT/package-lock.json" "$WORK/rollback-install/" || return 1
  if clean_npm "$WORK/rollback-install" ci --no-audit --no-fund; then
    rm -rf -- "$BOT/node_modules" || return 1
    mv "$WORK/rollback-install/node_modules" "$BOT/node_modules" || return 1
  elif [[ -d "$WORK/original-node_modules" ]]; then
    echo 'Rollback npm ci failed; restoring the previous installed dependencies.' >&2
    rm -rf -- "$BOT/node_modules" || return 1
    mv "$WORK/original-node_modules" "$BOT/node_modules" || return 1
  else
    echo "Rollback dependencies could not be restored; backup remains at $BACKUP." >&2
    return 1
  fi
  if ! systemctl start "$SERVICE"; then
    echo "The restored bot did not start; backup remains at $BACKUP." >&2
    return 1
  fi
  systemctl is-active --quiet "$SERVICE" || return 1
  wait_status false || return 1
  echo 'Previous source/config restored and the bot is back online.' >&2
}

finish() {
  local result=$?
  trap - EXIT INT TERM
  if (( result != 0 && ACTIVATED == 1 )); then
    # Recovery must continue even when an individual command fails.
    set +e
    restore_service
    local recovery=$?
    set -e
    if (( recovery != 0 )); then
      echo "Recovery needs attention. Retained workspace: $WORK; backup: $BACKUP" >&2
      exit "$result"
    fi
    RECOVERED=1
  fi
  rm -f -- "$ARCHIVE"
  if (( SUCCESS == 1 || ACTIVATED == 0 || RECOVERED == 1 )); then
    [[ "$WORK" == /opt/qq-group-bot-document-update.* ]] && rm -rf -- "$WORK"
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$STAGE" "$WORK/npm-home" "$WORK/tmp"
install -d -m 0700 /opt/qq-group-bot-backups "$BACKUP"
BACKUP_ENTRIES=(config.yaml)
for entry in "${MANAGED[@]}" dist; do
  if [[ -e "$BOT/$entry" ]]; then
    [[ ! -L "$BOT/$entry" ]] || { echo "Refusing symlinked server entry: $entry" >&2; exit 1; }
    BACKUP_ENTRIES+=("$entry")
  fi
done
[[ ! -L "$BOT/node_modules" ]] || { echo 'Refusing symlinked server node_modules.' >&2; exit 1; }
tar -czf "$BACKUP/source-and-config.tgz" -C "$BOT" "${BACKUP_ENTRIES[@]}"
chmod 0600 "$BACKUP/source-and-config.tgz"
CONFIG_HASH=$(sha256sum "$BOT/config.yaml")
CONFIG_HASH=${CONFIG_HASH%% *}
echo "Protected source/config backup: $BACKUP"

tar -xzf "$ARCHIVE" -C "$STAGE"
[[ ! -e "$STAGE/.env" && ! -e "$STAGE/config.yaml" && ! -e "$STAGE/persona.md" && ! -e "$STAGE/data" ]] || {
  echo 'The payload unexpectedly contains production configuration or runtime data.' >&2; exit 1;
}
echo 'Installing and validating the isolated release; the live bot continues running.'
clean_npm "$STAGE" ci --no-audit --no-fund
clean_npm "$STAGE" run typecheck
clean_npm "$STAGE" test

CURRENT_CONFIG_HASH=$(sha256sum "$BOT/config.yaml")
[[ ${CURRENT_CONFIG_HASH%% *} == "$CONFIG_HASH" ]] || {
  echo 'Server config changed during validation; leaving the live bot untouched.' >&2; exit 1;
}

# Prepare a comment-preserving config update only after the isolated tests.
# No configuration content or secrets are written to stdout/stderr.
(
  cd "$STAGE"
  node --input-type=module - "$BOT/config.yaml" "$STAGE/next-config.yaml" <<'CONFIG_SCRIPT'
import fs from 'node:fs';
import YAML from 'yaml';
try {
  const [source, target] = process.argv.slice(2);
  const document = YAML.parseDocument(fs.readFileSync(source, 'utf8'));
  if (document.errors.length) throw new Error();
  if (!YAML.isMap(document.contents)) throw new Error();
  if (document.has('documents') && !YAML.isMap(document.get('documents', true))) throw new Error();
  document.setIn(['documents', 'enabled'], true);
  document.setIn(['documents', 'output_dir'], '/opt/snowluma-docker/data/qq-bot-documents');
  document.setIn(['documents', 'provider_output_dir'], '/app/data/qq-bot-documents');
  fs.writeFileSync(target, document.toString(), { mode: 0o600 });
} catch {
  console.error('Could not prepare the server documents configuration. No config content was printed.');
  process.exit(1);
}
CONFIG_SCRIPT
)

# Reuse the existing bind mount, without recreating or restarting SnowLuma.
docker inspect "$CONTAINER" --format '{{json .Mounts}}' | node -e '
let input="";
process.stdin.on("data", part => input += part);
process.stdin.on("end", () => {
  try {
    const mounts=JSON.parse(input);
    if (!mounts.some(m => m.Type==="bind" && m.Source==="/opt/snowluma-docker/data" && m.Destination==="/app/data")) throw new Error();
  } catch {
    console.error("The expected SnowLuma document bind mount is absent.");
    process.exitCode=1;
  }
});'
[[ ! -L "$DOCS" ]] || { echo 'Refusing a symlinked document directory.' >&2; exit 1; }
install -d -m 0755 "$DOCS"
docker exec --user node "$CONTAINER" sh -c \
  'test -d /app/data/qq-bot-documents && test -r /app/data/qq-bot-documents && test -x /app/data/qq-bot-documents' || {
  echo 'SnowLuma node user cannot read/traverse the shared document directory.' >&2; exit 1;
}

echo 'Activating the validated release.'
ACTIVATED=1
systemctl stop "$SERVICE"
mkdir "$WORK/original-source"
for entry in "${MANAGED[@]}"; do
  [[ ! -L "$BOT/$entry" ]] || { echo "Server entry became a symlink: $entry" >&2; exit 1; }
  if [[ -e "$BOT/$entry" ]]; then mv "$BOT/$entry" "$WORK/original-source/$entry"; fi
  mv "$STAGE/$entry" "$BOT/$entry"
done
if [[ -d "$BOT/node_modules" ]]; then mv "$BOT/node_modules" "$WORK/original-node_modules"; fi
mv "$STAGE/node_modules" "$BOT/node_modules"
# The deployment workspace is private, but published source and assets must
# have ordinary read/traverse permissions before starting the service.
for entry in src scripts assets test; do
  find "$BOT/$entry" -type d -exec chmod 0755 {} +
  find "$BOT/$entry" -type f -exec chmod 0644 {} +
done
install -m "$(stat -c %a "$BOT/config.yaml")" "$STAGE/next-config.yaml" "$BOT/config.yaml"
systemctl start "$SERVICE"

echo 'Waiting up to 120 seconds for the panel, QQ login, and document capability.'
wait_status true
systemctl is-active --quiet "$SERVICE"
SUCCESS=1
echo "Document deployment complete. Backup retained at $BACKUP. No QQ files were sent by this script."
REMOTE_SCRIPT
