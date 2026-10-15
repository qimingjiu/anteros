#!/usr/bin/env bash
# Source-only incremental release. Keeps production config, credentials,
# persona, database, model selection, schedules and the QQ container intact.
# Usage: bash deploy/update-runtime.sh SSH_HOST [SSH_PORT]
set -Eeuo pipefail

DEST=${1:?Usage: bash deploy/update-runtime.sh SSH_HOST [SSH_PORT]}
PORT=${2:-22}
[[ "$DEST" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo 'Invalid SSH host.' >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || { echo 'Invalid SSH port.' >&2; exit 2; }
PORT=$((10#$PORT))
(( PORT >= 1 && PORT <= 65535 )) || { echo 'Invalid SSH port.' >&2; exit 2; }
PROJ=$(cd "$(dirname "$0")/.." && pwd)
LOCAL_ROOT=$(cd "${TMPDIR:-/tmp}" && pwd -P)
LOCAL_WORK=$(mktemp -d "$LOCAL_ROOT/qq-bot-runtime.XXXXXXXX")
trap '[[ "$LOCAL_WORK" == "$LOCAL_ROOT"/qq-bot-runtime.* ]] && rm -rf -- "$LOCAL_WORK"' EXIT
ARCHIVE_NAME="qq-bot-runtime-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}${RANDOM}.tgz"
PAYLOAD=(src scripts assets test package.json package-lock.json tsconfig.json README.md config.example.yaml config.sim.yaml)
for entry in "${PAYLOAD[@]}"; do
  [[ -e "$PROJ/$entry" && ! -L "$PROJ/$entry" ]] || { echo "Missing or symlinked payload: $entry" >&2; exit 1; }
done
tar -czf "$LOCAL_WORK/$ARCHIVE_NAME" -C "$PROJ" "${PAYLOAD[@]}"
scp -q -o BatchMode=yes -o ConnectTimeout=10 -P "$PORT" "$LOCAL_WORK/$ARCHIVE_NAME" "$DEST:/tmp/$ARCHIVE_NAME"
ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$PORT" "$DEST" "bash -s -- /tmp/$ARCHIVE_NAME" <<'REMOTE_SCRIPT'
set -Eeuo pipefail
umask 077
readonly BOT=/opt/qq-group-bot
readonly SERVICE=qq-group-bot
ARCHIVE=${1:?Missing archive}
[[ "$ARCHIVE" =~ ^/tmp/qq-bot-runtime-[A-Za-z0-9-]+\.tgz$ ]] || { echo 'Invalid archive path.' >&2; exit 2; }
[[ $(id -u) == 0 && -d "$BOT" && ! -L "$BOT" ]] || { echo 'Expected root and the existing bot directory.' >&2; exit 1; }
for entry in config.yaml .env persona.md; do
  [[ -f "$BOT/$entry" && ! -L "$BOT/$entry" ]] || { echo "Missing or symlinked production file: $entry" >&2; exit 1; }
done
systemctl is-active --quiet "$SERVICE"
SERVICE_USER=$(systemctl show "$SERVICE" -p User --value)
[[ -z "$SERVICE_USER" || "$SERVICE_USER" == root ]] || { echo 'Expected the existing root bot service.' >&2; exit 1; }
WORK=$(mktemp -d /opt/qq-group-bot-runtime-update.XXXXXXXX)
STAGE="$WORK/staging"
BACKUP="/opt/qq-group-bot-backups/runtime-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"
MANAGED=(src scripts assets test dist package.json package-lock.json tsconfig.json README.md config.example.yaml config.sim.yaml)
ACTIVATED=0
SUCCESS=0

production_fingerprint() {
  sha256sum "$BOT/config.yaml" "$BOT/.env" "$BOT/persona.md" | sha256sum | cut -d ' ' -f 1
}
health() {
  node --input-type=module - "$WORK/before-status.json" <<'NODE'
import fs from 'node:fs';
const before=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const deadline=Date.now()+90000;
while(Date.now()<deadline) {
  try {
    const response=await fetch('http://127.0.0.1:8642/api/status',{signal:AbortSignal.timeout(3000)});
    if(response.ok) {
      const now=await response.json();
      const unchanged=['model','documents','phoneContext','autoReply'].every(key=> {
        // Runtime diagnostics are new, changing observations, not configuration.
        if(key==='phoneContext') return ['enabled','configured','source','provider','scope'].every(field=>now[key]?.[field]===before[key]?.[field]);
        return JSON.stringify(now[key])===JSON.stringify(before[key]);
      });
      if(now.provider?.connection==='connected' && now.provider?.login==='online' && unchanged) {
        console.log('QQ connected/online; existing model, documents, phone configuration and conversation settings preserved.');
        process.exit(0);
      }
    }
  } catch {}
  await new Promise(resolve=>setTimeout(resolve,2000));
}
console.error('Bot health check failed. No private configuration was printed.');
process.exit(1);
NODE
}
finish() {
  local result=$?
  trap - EXIT INT TERM
  if (( result != 0 && ACTIVATED == 1 )); then
    echo "Release failed; restoring previous source from $BACKUP." >&2
    set +e
    if ! systemctl stop "$SERVICE"; then
      echo "Could not stop the bot safely; kept $WORK and $BACKUP without restoring files." >&2
      exit "$result"
    fi
    local recovery=0
    for entry in "${MANAGED[@]}"; do
      [[ ! -L "$BOT/$entry" ]] || { recovery=1; break; }
      # BOT and entry names are fixed, source-only directories above.
      rm -rf -- "$BOT/$entry" || { recovery=1; break; }
    done
    # This release never changes production config; keep any concurrent edit.
    if (( recovery == 0 )); then tar -xzf "$BACKUP/source-and-config.tgz" --exclude=config.yaml -C "$BOT" || recovery=1; fi
    if [[ -d "$WORK/original-node_modules" && ! -L "$BOT/node_modules" ]]; then
      rm -rf -- "$BOT/node_modules"
      mv "$WORK/original-node_modules" "$BOT/node_modules" || recovery=1
    fi
    systemctl start "$SERVICE" || recovery=1
    health || recovery=1
    if (( recovery != 0 )); then
      echo "Recovery requires attention; kept $WORK and $BACKUP." >&2
      exit "$result"
    fi
    echo 'Previous source restored and QQ is online.' >&2
  fi
  rm -f -- "$ARCHIVE"
  [[ "$WORK" == /opt/qq-group-bot-runtime-update.* ]] && rm -rf -- "$WORK"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$STAGE" "$WORK/npm-cache" "$WORK/tmp"
install -d -m 0700 /opt/qq-group-bot-backups "$BACKUP"
BACKUP_ENTRIES=(config.yaml)
for entry in "${MANAGED[@]}" node_modules; do
  [[ ! -L "$BOT/$entry" ]] || { echo "Refusing symlinked server entry: $entry" >&2; exit 1; }
  if [[ "$entry" != node_modules && -e "$BOT/$entry" ]]; then BACKUP_ENTRIES+=("$entry"); fi
done
FINGERPRINT=$(production_fingerprint)
node --input-type=module - "$WORK/before-status.json" <<'NODE'
import fs from 'node:fs';
const response=await fetch('http://127.0.0.1:8642/api/status',{signal:AbortSignal.timeout(4000)});
if(!response.ok) throw new Error('Could not read existing bot health');
const status=await response.json();
if(status.provider?.connection!=='connected'||status.provider?.login!=='online') throw new Error('Expected QQ online before update');
fs.writeFileSync(process.argv[2],JSON.stringify({model:status.model,documents:status.documents,phoneContext:status.phoneContext,autoReply:status.autoReply}),{mode:0o600});
NODE
tar -czf "$BACKUP/source-and-config.tgz" -C "$BOT" "${BACKUP_ENTRIES[@]}"
chmod 0600 "$BACKUP/source-and-config.tgz"
echo "Source/config backup: $BACKUP"
tar -xzf "$ARCHIVE" -C "$STAGE"
for entry in .env config.yaml persona.md data; do
  [[ ! -e "$STAGE/$entry" ]] || { echo 'Payload includes private configuration or runtime data.' >&2; exit 1; }
done
clean_npm() {
  env -i PATH="$PATH" TMPDIR="$WORK/tmp" LANG=C.UTF-8 \
    npm --prefix "$STAGE" --cache="$WORK/npm-cache" --userconfig=/dev/null "$@"
}
echo 'Validating the isolated release while the existing bot stays online.'
clean_npm ci --no-audit --no-fund
clean_npm run typecheck
clean_npm test
clean_npm run build
[[ $(production_fingerprint) == "$FINGERPRINT" ]] || { echo 'Production config changed during validation; live service untouched.' >&2; exit 1; }
echo 'Activating the validated source.'
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
for entry in src scripts assets test dist; do
  find "$BOT/$entry" -type d -exec chmod 0755 {} +
  find "$BOT/$entry" -type f -exec chmod 0644 {} +
done
[[ $(production_fingerprint) == "$FINGERPRINT" ]] || { echo 'Private config fingerprint changed during activation.' >&2; exit 1; }
systemctl start "$SERVICE"
health
systemctl is-active --quiet "$SERVICE"
SUCCESS=1
echo "Runtime fixes deployed. Source/config backup: $BACKUP."
REMOTE_SCRIPT
