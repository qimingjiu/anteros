import importlib.util
import json
import pathlib
import subprocess
import tempfile
import time
import types
import unittest
from unittest.mock import patch


class CompletionTest(unittest.TestCase):
    def execute(self, authorization='authorized', matched=True, expired=False, timeout=False):
        spec = importlib.util.spec_from_file_location('completion', pathlib.Path(__file__).with_name('complete-device-login.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = pathlib.Path(temporary.name)
        module.BASE, module.LOCK, module.RESULT = base, base/'lock', base/'result.json'
        (base/'device-login.public.json').write_text(json.dumps({'started_at':int(time.time())-(700 if expired else 0)}))
        (base/'device-login.private.json').write_text(json.dumps({'expires_in':600}))
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            if command[0] == 'systemctl':
                return types.SimpleNamespace(returncode=0)
            if command[-1].endswith('poll-device-login.py'):
                if timeout:
                    raise subprocess.TimeoutExpired('poll', 1)
                (base/'device-status.public.json').write_text(json.dumps({'status':authorization, 'reason':'access_denied'}))
            elif command[-1].endswith('validate-user.py'):
                if not matched:
                    return types.SimpleNamespace(returncode=4)
                (base/'user-token.enabled.json').write_text(json.dumps({'identityMatched':True}))
            elif command[-1].endswith('probe.mjs'):
                (base/'acceptance.json').write_text(json.dumps({'readonlyChecks':[{'tool':'list','isError':False,'code':0,'count':0}]}))
                (base/'discovery.json').write_text(json.dumps({'tools':[{},{}]}))
            else:
                self.fail('unexpected subprocess')
            return types.SimpleNamespace(returncode=0)

        with patch.object(module.subprocess, 'run', run):
            module.main()
        self.assertFalse(module.LOCK.exists())
        return json.loads(module.RESULT.read_text()), calls

    def test_matching_identity_completes_once_without_business_commands(self):
        result, calls = self.execute()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['toolCount'], 2)
        self.assertEqual(sum(command[0]=='systemctl' for command in calls), 1)
        self.assertEqual(len(calls), 4)

    def test_foreign_identity_never_restarts(self):
        result, calls = self.execute(matched=False)
        self.assertEqual(result['reason'], 'identity_not_matched')
        self.assertFalse(any(command[0]=='systemctl' for command in calls))

    def test_denied_authorization_never_validates_or_restarts(self):
        result, calls = self.execute(authorization='failed')
        self.assertEqual(result['reason'], 'access_denied')
        self.assertEqual(len(calls), 1)

    def test_expired_authorization_does_not_start_another_flow(self):
        result, calls = self.execute(expired=True)
        self.assertEqual(result['status'], 'expired')
        self.assertEqual(calls, [])

    def test_poll_timeout_stops_without_restart(self):
        result, calls = self.execute(timeout=True)
        self.assertEqual(result['reason'], 'timeout')
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
