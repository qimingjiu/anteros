#!/usr/bin/env bash
# Incremental EventTap reader compatibility. Does not replace .env, persona,
# chat databases, persisted model choices, or the SnowLuma container.
# Required environment: OWNER_QQ=123456789 OWNER_WAKE_ALIASES="昵称甲,昵称乙,昵称丙" \
#   SUPABASE_PROJECT_URL=https://<project-ref>.supabase.co PRESENCE_SOURCE_OWNER=azhan PRESENCE_DEVICE_ID=phone-main
# Usage (Git Bash / Linux): bash deploy/update-eventtap.sh your-server [22]
set -Eeuo pipefail

DEST=${1:?Usage: bash deploy/update-eventtap.sh SSH_HOST [SSH_PORT]}
PORT=${2:-22}
[[ "$DEST" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo 'Invalid SSH host.' >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || { echo 'Invalid SSH port.' >&2; exit 2; }
PORT=$((10#$PORT))
(( PORT >= 1 && PORT <= 65535 )) || { echo 'Invalid SSH port.' >&2; exit 2; }
OWNER_QQ=${OWNER_QQ:?set OWNER_QQ to the bot owner QQ}
OWNER_WAKE_ALIASES=${OWNER_WAKE_ALIASES:?set OWNER_WAKE_ALIASES to comma-separated owner wake aliases}
[[ "$OWNER_WAKE_ALIASES" != ,* && "$OWNER_WAKE_ALIASES" != *, && "$OWNER_WAKE_ALIASES" != *,,* && "$OWNER_WAKE_ALIASES" != *[$'\n\r']* ]] || { echo 'Invalid OWNER_WAKE_ALIASES (comma-separated, no empty entries).' >&2; exit 2; }
[[ "$OWNER_QQ" =~ ^[0-9]{5,15}$ ]] || { echo 'Invalid OWNER_QQ.' >&2; exit 2; }
IFS=',' read -r -a OWNER_WAKE_ALIAS_LIST <<< "$OWNER_WAKE_ALIASES"
for index in "${!OWNER_WAKE_ALIAS_LIST[@]}"; do
  entry=${OWNER_WAKE_ALIAS_LIST[$index]}
  entry="${entry#"${entry%%[![:space:]]*}"}"
  entry="${entry%"${entry##*[![:space:]]}"}"
  [[ -n "$entry" && ! "$entry" == *[[:cntrl:]]* && ${#entry} -le 100 ]] || { echo 'Invalid OWNER_WAKE_ALIASES entry.' >&2; exit 2; }
  OWNER_WAKE_ALIAS_LIST[$index]=$entry
done
SUPABASE_PROJECT_URL=${SUPABASE_PROJECT_URL:?set SUPABASE_PROJECT_URL to your Supabase project URL}
[[ "$SUPABASE_PROJECT_URL" =~ ^https://[a-z0-9-]+\.supabase\.co$ ]] || { echo 'Invalid SUPABASE_PROJECT_URL.' >&2; exit 2; }
PRESENCE_SOURCE_OWNER=${PRESENCE_SOURCE_OWNER:?set PRESENCE_SOURCE_OWNER to the EventTap owner label}
PRESENCE_DEVICE_ID=${PRESENCE_DEVICE_ID:?set PRESENCE_DEVICE_ID to the phone device id}
for v in "$PRESENCE_SOURCE_OWNER" "$PRESENCE_DEVICE_ID"; do
  [[ "$v" =~ ^[A-Za-z0-9_-]{1,100}$ ]] || { echo 'Invalid PRESENCE_SOURCE_OWNER / PRESENCE_DEVICE_ID (slug characters only).' >&2; exit 2; }
done
REMOTE_OWNER_ARGS=$(printf '%q ' "$OWNER_QQ" "$SUPABASE_PROJECT_URL" "$PRESENCE_SOURCE_OWNER" "$PRESENCE_DEVICE_ID" "${OWNER_WAKE_ALIAS_LIST[@]}")
PROJ=$(cd "$(dirname "$0")/.." && pwd)
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10 -p "$PORT")
LOCAL_TMP_ROOT=$(cd "${TMPDIR:-/tmp}" && pwd -P)
LOCAL_WORK=$(mktemp -d "$LOCAL_TMP_ROOT/qq-bot-eventtap.XXXXXXXX")
trap '[[ "$LOCAL_WORK" == "$LOCAL_TMP_ROOT"/qq-bot-eventtap.* ]] && rm -rf -- "$LOCAL_WORK"' EXIT
ARCHIVE_NAME="qq-bot-eventtap-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}${RANDOM}.tgz"

# config.sim.yaml is a mock-only fixture required by the repository tests.
# Production .env/config.yaml/persona.md/data/ are deliberately absent.
PAYLOAD=(src scripts assets test package.json package-lock.json tsconfig.json README.md config.example.yaml config.sim.yaml)
for entry in "${PAYLOAD[@]}"; do
  [[ -e "$PROJ/$entry" && ! -L "$PROJ/$entry" ]] || { echo "Missing or symlinked payload entry: $entry" >&2; exit 1; }
done
tar -czf "$LOCAL_WORK/$ARCHIVE_NAME" -C "$PROJ" "${PAYLOAD[@]}"
echo 'Uploading the EventTap-compatible source and mock tests.'
scp -q -o BatchMode=yes -o ConnectTimeout=10 -P "$PORT" "$LOCAL_WORK/$ARCHIVE_NAME" "$DEST:/tmp/$ARCHIVE_NAME"

ssh "${SSHOPT[@]}" "$DEST" "bash -s -- /tmp/$ARCHIVE_NAME $REMOTE_OWNER_ARGS" <<'REMOTE_SCRIPT'
set -Eeuo pipefail
umask 077
readonly BOT=/opt/qq-group-bot
readonly SERVICE=qq-group-bot
readonly CONTAINER=snowluma
readonly STATUS_URL=http://127.0.0.1:8642/api/status
ARCHIVE=${1:?Missing archive path}
OWNER_QQ=${2:?Missing owner QQ}
[[ "$OWNER_QQ" =~ ^[0-9]{5,15}$ ]] || { echo 'Invalid owner QQ.' >&2; exit 2; }
SUPABASE_PROJECT_URL=${3:?Missing Supabase project URL}
[[ "$SUPABASE_PROJECT_URL" =~ ^https://[a-z0-9-]+\.supabase\.co$ ]] || { echo 'Invalid Supabase project URL.' >&2; exit 2; }
PRESENCE_SOURCE_OWNER=${4:?Missing presence source owner}
PRESENCE_DEVICE_ID=${5:?Missing presence device id}
for v in "$PRESENCE_SOURCE_OWNER" "$PRESENCE_DEVICE_ID"; do
  [[ "$v" =~ ^[A-Za-z0-9_-]{1,100}$ ]] || { echo 'Invalid presence source owner / device id.' >&2; exit 2; }
done
OWNER_WAKE_ALIAS_LIST=("${@:6}")
((${#OWNER_WAKE_ALIAS_LIST[@]} >= 1)) || { echo 'Missing owner wake aliases.' >&2; exit 2; }
for entry in "${OWNER_WAKE_ALIAS_LIST[@]}"; do
  [[ -n "$entry" && ! "$entry" == *[[:cntrl:]]* && ${#entry} -le 100 ]] || { echo 'Invalid owner wake alias.' >&2; exit 2; }
done
[[ "$ARCHIVE" =~ ^/tmp/qq-bot-eventtap-[A-Za-z0-9-]+\.tgz$ ]] || { echo 'Invalid archive path.' >&2; exit 2; }
[[ $(id -u) == 0 ]] || { echo 'Run the remote update as root.' >&2; exit 1; }
[[ -d "$BOT" && ! -L "$BOT" ]] || { echo 'Expected a real /opt/qq-group-bot directory.' >&2; exit 1; }
[[ -f "$BOT/config.yaml" && ! -L "$BOT/config.yaml" ]] || { echo 'Missing or symlinked server config.' >&2; exit 1; }
systemctl is-active --quiet "$SERVICE" || { echo 'The bot must be running before this update.' >&2; exit 1; }
SERVICE_USER=$(systemctl show "$SERVICE" -p User --value)
[[ -z "$SERVICE_USER" || "$SERVICE_USER" == root ]] || { echo 'This update expects the existing bot service to run as root.' >&2; exit 1; }
docker inspect "$CONTAINER" >/dev/null

WORK=$(mktemp -d /opt/qq-group-bot-eventtap-update.XXXXXXXX)
STAGE="$WORK/staging"
BACKUP="/opt/qq-group-bot-backups/eventtap-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"
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
  local expected_presence=${2:-false}
  node --input-type=module - "$STATUS_URL" "$require_documents" "$expected_presence" "$OWNER_QQ" "${OWNER_WAKE_ALIAS_LIST[@]}" <<'HEALTH_SCRIPT'
const [endpoint, requireDocuments, expectedPresence, ownerQq, ...aliases] = process.argv.slice(2);
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(4_000) });
    if (response.ok) {
      const status = await response.json();
      const formats = status.documents?.formats;
      const documentsReady = requireDocuments !== 'true' || (status.documents?.enabled === true
        && Array.isArray(formats) && ['md', 'docx', 'pdf'].every(format => formats.includes(format))
        && status.autoReply?.mode === 'main_model' && status.autoReply?.enabled === true
        && status.autoReply?.limits?.observerCooldownMs === 30000
        && status.autoReply?.limits?.observerMaxReplies === 3
        && status.autoReply?.summon?.priority === 'highest'
        && status.autoReply?.summon?.followupWindowMs === 120000
        && status.autoReply?.summon?.poke === true
        && ['supported', 'unverified'].includes(status.provider?.capabilities?.sendPoke)
        && status.phoneContext?.source === 'device_events'
        && status.phoneContext?.provider === 'EventTap'
        && status.phoneContext?.scope === 'owner_private'
        && status.phoneContext?.enabled === (expectedPresence === 'true')
        && status.autoReply?.summon?.ownerWakeAliases?.some(binding => binding.userId === ownerQq
          && aliases.every(alias => binding.aliases.includes(alias)))
        && !status.autoReply?.summon?.ownerWakeAliases?.some(binding => binding.userId !== ownerQq
          && binding.aliases.some(alias => aliases.includes(alias))));
      if (status.provider?.connection === 'connected' && status.provider?.login === 'online' && documentsReady) {
        console.log(requireDocuments === 'true'
          ? 'Panel reachable; QQ online; EventTap source registered; existing summons and 30-second cooldown intact.'
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
    [[ "$WORK" == /opt/qq-group-bot-eventtap-update.* ]] && rm -rf -- "$WORK"
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
  node --env-file-if-exists="$BOT/.env" --input-type=module - "$BOT/config.yaml" "$STAGE/next-config.yaml" "$STAGE/presence-enabled.txt" "$OWNER_QQ" "$SUPABASE_PROJECT_URL" "$PRESENCE_SOURCE_OWNER" "$PRESENCE_DEVICE_ID" <<'CONFIG_SCRIPT'
import fs from 'node:fs';
import YAML from 'yaml';
try {
  const [source, target, enabledFile, ownerQq, projectUrl, sourceOwner, deviceId] = process.argv.slice(2);
  if (!/^[0-9]{5,15}$/.test(ownerQq)) throw new Error();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(projectUrl)) throw new Error();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sourceOwner) || !/^[A-Za-z0-9_-]{1,100}$/.test(deviceId)) throw new Error();
  const projectRef = new URL(projectUrl).hostname.split('.')[0];
  const document = YAML.parseDocument(fs.readFileSync(source, 'utf8'));
  if (document.errors.length) throw new Error();
  if (!YAML.isMap(document.contents)) throw new Error();
  if (document.has('presence') && !YAML.isMap(document.get('presence', true))) throw new Error();
  const before = document.toJSON();
  const prior = before.presence ?? {};
  const serverKey = prior.server_key || process.env[prior.server_key_env || 'SUPABASE_SERVER_KEY'] || '';
  let privateCredential = serverKey.startsWith('sb_secret_');
  if (!privateCredential && serverKey.split('.').length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(serverKey.split('.')[1], 'base64url').toString('utf8'));
      privateCredential = claims.role === 'service_role' && claims.ref === projectRef;
    } catch {}
  }
  let enabled = false;
  if (privateCredential) {
    // Only a read probe verifies that a private key belongs to this project and can read this schema.
    // No dummy phone rows, RLS updates, response bodies, or credentials are printed.
    try {
      const url = new URL('/rest/v1/device_events', projectUrl);
      url.searchParams.set('select', 'owner,device_id,timestamp,charging,battery_level,screen_state,network_type');
      url.searchParams.set('owner', `eq.${sourceOwner}`);
      url.searchParams.set('device_id', `eq.${deviceId}`);
      url.searchParams.set('limit', '0');
      const headers = { apikey:serverKey, Accept:'application/json' };
      if (!serverKey.startsWith('sb_')) headers.Authorization = `Bearer ${serverKey}`;
      const response = await fetch(url, { headers, signal:AbortSignal.timeout(1500) });
      enabled = response.ok && Array.isArray(await response.json());
    } catch {}
  }
  document.setIn(['presence', 'enabled'], enabled);
  document.setIn(['presence', 'source'], 'device_events');
  document.setIn(['presence', 'source_owner'], sourceOwner);
  document.setIn(['presence', 'supabase_url'], projectUrl);
  document.setIn(['presence', 'owner_id'], ownerQq);
  document.setIn(['presence', 'device_id'], deviceId);
  if (!document.hasIn(['presence', 'server_key_env'])) document.setIn(['presence', 'server_key_env'], 'SUPABASE_SERVER_KEY');
  if (!document.hasIn(['presence', 'request_timeout_ms'])) document.setIn(['presence', 'request_timeout_ms'], 1500);
  if (!document.hasIn(['presence', 'cache_ttl_ms'])) document.setIn(['presence', 'cache_ttl_ms'], 30000);
  if (!document.hasIn(['presence', 'stale_retention_ms'])) document.setIn(['presence', 'stale_retention_ms'], 86400000);
  const after = document.toJSON();
  delete before.presence;
  delete after.presence;
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error();
  fs.writeFileSync(target, document.toString(), { mode: 0o600 });
  fs.writeFileSync(enabledFile, enabled ? 'true' : 'false', { mode:0o600 });
} catch {
  console.error('Could not prepare the server EventTap configuration. No config content was printed.');
  process.exit(1);
}
CONFIG_SCRIPT
)

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

echo 'Waiting up to 120 seconds for QQ login, EventTap registration, and preserved conversation features.'
EXPECTED_PRESENCE=$(cat "$STAGE/presence-enabled.txt")
wait_status true "$EXPECTED_PRESENCE"
systemctl is-active --quiet "$SERVICE"
SUCCESS=1
echo "EventTap reader compatibility deployed; private reading enabled=$EXPECTED_PRESENCE. Models, logins, documents, summons, cooldown, and memories retained. Source/config backup: $BACKUP. No QQ test messages/pokes or fake device rows sent."
REMOTE_SCRIPT
