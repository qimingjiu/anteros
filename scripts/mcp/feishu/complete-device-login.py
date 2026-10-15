"""Complete one owner-initiated login; no new flow, business writes or notifications."""
import json
import os
import pathlib
import subprocess
import time

BASE = pathlib.Path('/opt/qq-group-bot-mcp/feishu')
LOCK = BASE / 'login-completion.lock'
RESULT = BASE / 'login-completion.public.json'


def result(status, **fields):
    value = {'status': status, 'updatedAt': int(time.time()), **fields}
    temporary = RESULT.with_suffix('.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    os.chmod(temporary, 0o600)
    temporary.replace(RESULT)


def main():
    try:
        descriptor = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return
    try:
        os.write(descriptor, str(os.getpid()).encode())
        public = json.loads((BASE / 'device-login.public.json').read_text())
        private = json.loads((BASE / 'device-login.private.json').read_text())
        deadline = public['started_at'] + private.get('expires_in', 600)
        if time.time() >= deadline:
            result('expired')
            return
        result('waiting_for_user', expiresAt=deadline)
        completed = subprocess.run(
            ['python3', str(BASE / 'poll-device-login.py')],
            capture_output=True, timeout=max(1, deadline - time.time()) + 40,
        )
        state = json.loads((BASE / 'device-status.public.json').read_text())
        if completed.returncode or state.get('status') != 'authorized':
            reason = state.get('reason')
            result('stopped', reason=reason if reason in ['expired_token', 'invalid_grant', 'access_denied'] else 'authorization_not_completed')
            return
        validation = subprocess.run(
            ['python3', str(BASE / 'validate-user.py')],
            capture_output=True, timeout=40,
        )
        marker = BASE / 'user-token.enabled.json'
        matched = marker.exists() and json.loads(marker.read_text()).get('identityMatched') is True
        if validation.returncode or not matched:
            result('stopped', reason='identity_not_matched')
            return
        result('identity_verified', identityMatched=True)
        restart = subprocess.run(
            ['systemctl', 'restart', 'qq-group-bot'],
            capture_output=True, timeout=60,
        )
        if restart.returncode:
            result('authorized', identityMatched=True, serviceRestarted=False, reason='service_restart_failed')
            return
        probe = subprocess.run(
            ['node', str(BASE / 'probe.mjs')],
            capture_output=True, timeout=150,
        )
        if probe.returncode:
            result('authorized', identityMatched=True, serviceRestarted=True, reason='readonly_probe_failed')
            return
        acceptance = json.loads((BASE / 'acceptance.json').read_text())
        checks = [
            {key: check[key] for key in ['tool', 'isError', 'code', 'count'] if key in check}
            for check in acceptance.get('readonlyChecks', [])
        ]
        discovered = json.loads((BASE / 'discovery.json').read_text())
        ready = bool(checks) and all(not check.get('isError') and check.get('code') == 0 for check in checks)
        result('ready' if ready else 'authorized_with_permission_limits', identityMatched=True,
               serviceRestarted=True, toolCount=len(discovered.get('tools', [])), readonlyChecks=checks)
    except subprocess.TimeoutExpired:
        result('stopped', reason='timeout')
    except Exception:
        result('stopped', reason='completion_failed')
    finally:
        os.close(descriptor)
        LOCK.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
