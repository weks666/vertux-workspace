"""Offline edge tests: synthetic bytes, mocked host operations, no SSH/network."""
from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


edge = load('lead_edge_test_target', ROOT / 'deploy/lead-edge-overlay.py')
helper = load('lead_edge_helper_test_target', ROOT / 'scripts/lead-edge-release.py')


class SupervisorError(RuntimeError):
    pass


class PathBytes(dict):
    def __init__(self, values):
        super().__init__()
        for path, value in values.items(): self[path] = value

    def __getitem__(self, path): return super().__getitem__(str(path).replace('\\', '/'))
    def __setitem__(self, path, value): super().__setitem__(str(path).replace('\\', '/'), value)


class FakeDropin:
    def __init__(self, exists=False):
        self.present = exists
        self.removed = 0
        self.parent = types.SimpleNamespace(lstat=lambda: types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0))

    def exists(self): return self.present
    def is_symlink(self): return False
    def unlink(self):
        self.present = False
        self.removed += 1


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        # These defaults make an accidental real command or network call fatal.
        self.stack.enter_context(mock.patch.object(edge, 'command', side_effect=AssertionError('unexpected host command')))
        self.stack.enter_context(mock.patch.object(edge.urllib.request, 'urlopen', side_effect=AssertionError('unexpected network')))
        self.original = (b'vertuxdb.duckdns.org {\n'
                         b' @trusted_nexus remote_ip 192.0.2.10\n'
                         b' handle @trusted_nexus {\n'
                         b'  reverse_proxy 127.0.0.1:4188 {\n'
                         b'   header_up X-KovroCity-Ingress-Secret SYNTHETIC_ONLY\n'
                         b'  }\n }\n handle { reverse_proxy 127.0.0.1:8000 }\n}\n')
        self.runtime = {'caddySource': '/synthetic/immutable/Caddyfile', 'caddySha256': edge.sha(self.original),
                        'version': '0.1.11', 'mode': 'committed', 'release': '/synthetic/releases/0.1.11',
                        'databaseId': 'd' * 64, 'databaseImage': 'sha256:' + 'e' * 64, 'webId': 'f' * 64,
                        'workerId': 'a' * 64, 'image': 'sha256:' + 'b' * 64, 'workerRequired': True,
                        'authorizationId': 'c' * 32}
        self.source = b'# synthetic reviewed overlay source\n'
        self.machine = b'synthetic-machine-id\n'
        self.records = [{'path': str(edge.BASE_CONTROL), 'sha256': edge.BASE_CONTROL_SHA}]
        seed = {'schemaVersion': 1, 'kind': 'vertux.lead-edge-plan/v1', 'sourceSha256': edge.sha(self.source),
                'hostSha256': edge.sha(self.machine), 'beforeRuntime': self.runtime,
                'authorityRecords': copy.deepcopy(self.records), 'serviceRecords': [], 'baseCaddySha256': edge.sha(self.original),
                'candidateSha256': edge.sha(edge.render(self.original)),
                'closedCaddy': {'path': str(pathlib.Path('/synthetic/closed')), 'sha256': edge.sha(b'CLOSED')}}
        operation = edge.sha(edge.canonical(seed))
        self.plan = {**seed, 'operation': operation, **edge.plan_paths(operation, edge.sha(self.source))}
        self.files = PathBytes({self.runtime['caddySource']: self.original,
                      self.plan['originalPath']: self.original,
                      self.plan['candidatePath']: edge.render(self.original),
                      self.plan['controlPath']: self.source,
                      self.plan['planPath']: edge.canonical(self.plan),
                      '/etc/machine-id': self.machine,
                      '/synthetic/closed': b'CLOSED'})
        self.stack.enter_context(mock.patch.object(edge, 'owned_bytes', side_effect=lambda path, *args, **kwargs: self.files[str(path)]))
        self.stack.enter_context(mock.patch.object(edge, 'authority_records', side_effect=lambda: copy.deepcopy(self.records)))
        self.base = types.SimpleNamespace(authority_runtime=mock.Mock(side_effect=lambda: copy.deepcopy(self.runtime)),
                                          SupervisorError=SupervisorError, CLOSED_CADDY=pathlib.Path('/synthetic/closed'),
                                          main=mock.Mock(), active_transaction=mock.Mock(return_value=None),
                                          runtime_is_exact=mock.Mock(return_value=True), install_caddy=mock.Mock(),
                                          close_runtime=mock.Mock(), claim_reconciliation_lock=mock.Mock())

    def test_render_keeps_every_original_byte_and_exact_route(self):
        candidate = edge.render(self.original)
        self.assertEqual(candidate.replace(edge.ROUTE, b'', 1), self.original)
        self.assertEqual(candidate.count(b'handle /webhook/vertux-lead-intelligence {'), 1)
        self.assertIn(b'max_size 64KB', candidate)
        self.assertIn(b'reverse_proxy 127.0.0.1:47921', candidate)
        for invalid in (b'other.example { }', self.original * 2, candidate, self.original + b'\0'):
            with self.subTest(invalid=len(invalid)), self.assertRaises(edge.EdgeError):
                edge.render(invalid)

    def test_only_two_runtime_fields_change_after_original_validation(self):
        original_functions = {name: getattr(self.base, name) for name in
                              ('main', 'active_transaction', 'close_runtime', 'install_caddy', 'claim_reconciliation_lock')}
        original_authority = self.base.authority_runtime
        edge.bind_overlay(self.base, self.plan)
        actual = self.base.authority_runtime()
        original_authority.assert_called_once_with()
        differences = {key for key in actual if actual[key] != self.runtime[key]}
        self.assertEqual(differences, {'caddySource', 'caddySha256'})
        self.assertEqual(actual['caddySource'], self.plan['candidatePath'])
        self.assertEqual(actual['caddySha256'], self.plan['candidateSha256'])
        self.assertEqual(self.runtime['caddySource'], '/synthetic/immutable/Caddyfile')
        for name, function in original_functions.items():
            self.assertIs(getattr(self.base, name), function)
        self.assertEqual(self.base.CLOSED_CADDY, pathlib.Path('/synthetic/closed'))

    def test_original_guard_failure_is_not_replaced_by_overlay_authority(self):
        original_error = SupervisorError('synthetic original guard refused')
        self.base.authority_runtime.side_effect = original_error
        with mock.patch.object(edge, 'load_plan') as check:
            edge.bind_overlay(self.base, self.plan)
            with self.assertRaises(SupervisorError) as caught:
                self.base.authority_runtime()
        self.assertIs(caught.exception, original_error)
        check.assert_not_called()
        self.base.install_caddy.assert_not_called()

    def test_modified_candidate_or_base_or_receipt_fails_closed(self):
        for path in (self.plan['candidatePath'], self.plan['originalPath'], self.runtime['caddySource']):
            with self.subTest(path=path):
                original = self.files[path]
                self.files[path] = original + b'UNAUTHORIZED EXTRA ROUTE\n'
                with self.assertRaises(edge.EdgeError):
                    edge.checked_candidate(self.plan, self.runtime)
                self.files[path] = original
        self.records.append({'path': '/synthetic/changed-receipt', 'sha256': '0' * 64})
        with self.assertRaisesRegex(edge.EdgeError, 'base_authority_changed'):
            edge.checked_candidate(self.plan, self.runtime)

    def test_failure_and_transaction_closure_keep_original_closed_edge(self):
        closed_calls = []
        self.base.close_runtime = lambda reason: closed_calls.append(self.base.CLOSED_CADDY)
        original_close = self.base.close_runtime
        edge.bind_overlay(self.base, self.plan)
        self.files[self.plan['candidatePath']] += b'BAD'
        with self.assertRaisesRegex(SupervisorError, '^lead_edge_integrity_failed$'):
            self.base.authority_runtime()
        self.assertIs(self.base.close_runtime, original_close)
        self.base.close_runtime('inherited failure closure')
        self.base.close_runtime('inherited active transaction closure')
        self.assertEqual(closed_calls, [pathlib.Path('/synthetic/closed')] * 2)
        self.assertNotIn(b'/webhook/vertux-lead-intelligence', self.files[str(self.base.CLOSED_CADDY)])

    def test_plan_binds_host_source_and_exact_private_paths(self):
        loaded = edge.load_plan(self.plan['operation'], edge.sha(edge.canonical(self.plan)), edge.sha(self.source))
        self.assertEqual(loaded, self.plan)
        for path in ('/etc/machine-id', self.plan['controlPath'], self.plan['planPath']):
            with self.subTest(path=path):
                old = self.files[path]
                self.files[path] += b'DRIFT'
                with self.assertRaises(edge.EdgeError):
                    edge.load_plan(self.plan['operation'], edge.sha(edge.canonical(self.plan)), edge.sha(self.source))
                self.files[path] = old
        invalid = copy.deepcopy(self.plan)
        invalid['candidatePath'] = '/etc/caddy/Caddyfile'
        with self.assertRaisesRegex(edge.EdgeError, 'invalid_edge_plan_path'):
            edge.validate_plan_structure(invalid)
        with self.assertRaisesRegex(edge.EdgeError, 'invalid_edge_receipt'):
            edge.load_plan('../outside', 'a' * 64)

    def test_runtime_drift_does_not_rebind_other_containers_or_versions(self):
        for key in ('databaseId', 'webId', 'workerId', 'version', 'release'):
            changed = {**self.runtime, key: 'unexpected'}
            with self.subTest(key=key), self.assertRaisesRegex(edge.EdgeError, 'base_runtime_changed'):
                edge.checked_candidate(self.plan, changed)

    def test_receipt_has_no_rendered_config_or_provider_material(self):
        result = edge.receipt(self.plan, 'EDGE_PREPARED')
        encoded = json.dumps(result)
        self.assertNotIn('SYNTHETIC_ONLY', encoded)
        self.assertNotIn('beforeRuntime', result)
        self.assertNotIn('sourceBase64', result)
        self.assertFalse(result['secretsPrinted'])
        self.assertEqual(result['candidateSha256'], edge.sha(edge.render(self.original)))
        self.assertNotIn('/api/kovrocity', edge.dropin_bytes(self.plan).decode())

    def test_helper_rejects_changed_reviewed_source_without_ssh(self):
        receipt = edge.receipt(self.plan, 'EDGE_PREPARED')
        request = helper.make_request('activate', self.source, receipt)
        self.assertEqual(request['receipt'], receipt)
        with self.assertRaises(ValueError):
            helper.make_request('activate', self.source + b'changed', receipt)
        with self.assertRaises(ValueError):
            helper.make_request('rollback', self.source, None)

    def test_same_argv_old_pid_is_not_accepted_as_restart(self):
        process_values = iter(['110', '110', '110', '220'])
        commands = []
        with (mock.patch.object(edge, 'property_value', side_effect=lambda *args: next(process_values)),
              mock.patch.object(edge, 'command', side_effect=lambda args: commands.append(args)),
              mock.patch.object(edge, 'running_command', return_value=edge.overlay_command(self.plan)) as running,
              mock.patch.object(edge.time, 'sleep') as sleep):
            edge.restart_supervisor(edge.overlay_command(self.plan))
        self.assertEqual(sleep.call_count, 2)
        running.assert_called_once_with()
        self.assertEqual(commands, [['systemctl', 'daemon-reload'], ['systemctl', 'restart', '--no-block', edge.UNIT]])

    def test_verification_spans_monitor_cycles_and_checks_both_origins(self):
        with (mock.patch.object(edge, 'release_lock', side_effect=contextlib.nullcontext),
              mock.patch.object(edge, 'host_matches'), mock.patch.object(edge, 'load_original', return_value=self.base),
              mock.patch.object(edge, 'idle'), mock.patch.object(edge, 'running_command', return_value=edge.overlay_command(self.plan)),
              mock.patch.object(edge, 'caddy_matches') as caddy, mock.patch.object(edge, 'property_value', return_value='active'),
              mock.patch.object(edge, 'public_probes') as probes, mock.patch.object(edge.time, 'sleep') as sleep):
            self.files[str(edge.DROPIN)] = edge.dropin_bytes(self.plan)
            result = edge.verify(self.plan)
        self.assertEqual(probes.call_count, 4)
        self.assertEqual(caddy.call_count, 4)
        self.assertEqual(sleep.call_args_list, [mock.call(2.5)] * 3)
        self.assertEqual(result['status'], 'EDGE_ACTIVE_VERIFIED')
        self.assertFalse(result['authenticatedOwnerVerified'])
        with mock.patch.object(edge, 'probe') as probe:
            edge.public_probes()
        self.assertEqual(probe.call_args_list, [mock.call(edge.ENDPOINT, 'https://weks666.github.io', 401, marker=True),
                                               mock.call(edge.ENDPOINT, 'https://foreign.invalid', 403, marker=True)])

    def install_lifecycle_fakes(self, *, exists=False):
        lock = {'held': False}
        @contextlib.contextmanager
        def owned_lock():
            self.assertFalse(lock['held'])
            lock['held'] = True
            try: yield
            finally: lock['held'] = False
        dropin = FakeDropin(exists)
        self.stack.enter_context(mock.patch.object(edge, 'DROPIN', dropin))
        self.stack.enter_context(mock.patch.object(edge, 'release_lock', side_effect=owned_lock))
        for name in ('host_matches', 'idle', 'caddy_matches', 'fsync_directory'):
            self.stack.enter_context(mock.patch.object(edge, name))
        self.stack.enter_context(mock.patch.object(edge, 'load_original', return_value=self.base))
        self.stack.enter_context(mock.patch.object(edge, 'running_command', return_value=edge.base_command()))
        self.stack.enter_context(mock.patch.object(edge, 'record', return_value=self.plan['closedCaddy']))
        self.stack.enter_context(mock.patch.object(edge, 'owned_bytes', side_effect=lambda path, *args, **kwargs:
                                                 edge.dropin_bytes(self.plan) if path is dropin else self.files[str(path)]))
        writes = []
        def publish(path, raw, mode):
            self.assertTrue(lock['held'])
            self.assertIs(path, dropin)
            self.assertEqual(raw, edge.dropin_bytes(self.plan))
            self.assertEqual(mode, 0o644)
            dropin.present = True
            writes.append(path)
        self.stack.enter_context(mock.patch.object(edge, 'publish', side_effect=publish))
        def restart(expected):
            self.assertTrue(lock['held'])
        def ready(plan, *, overlay):
            self.assertFalse(lock['held'])
        restart_mock = self.stack.enter_context(mock.patch.object(edge, 'restart_supervisor', side_effect=restart))
        ready_mock = self.stack.enter_context(mock.patch.object(edge, 'ready_then_start_caddy', side_effect=ready))
        self.stack.enter_context(mock.patch.object(edge, 'verify', side_effect=lambda plan, overlay=True:
                                                 edge.receipt(plan, 'EDGE_ACTIVE_VERIFIED' if overlay else 'EDGE_ROLLED_BACK')))
        return lock, dropin, writes, restart_mock, ready_mock

    def test_activate_only_publishes_own_dropin_and_waits_ready_after_unlock(self):
        lock, dropin, writes, restarted, ready = self.install_lifecycle_fakes()
        result = edge.activate(self.plan)
        self.assertTrue(dropin.present)
        self.assertEqual(writes, [dropin])
        restarted.assert_called_once_with(edge.overlay_command(self.plan))
        ready.assert_called_once_with(self.plan, overlay=True)
        self.assertFalse(lock['held'])
        self.assertEqual(result['status'], 'EDGE_ACTIVE_VERIFIED')
        self.base.install_caddy.assert_not_called()

    def test_failed_activation_rolls_back_own_layer_with_base_command(self):
        lock, dropin, writes, restarted, ready = self.install_lifecycle_fakes()
        def ready_outcome(plan, *, overlay):
            self.assertFalse(lock['held'])
            if overlay:
                raise edge.EdgeError('synthetic_probe_failed')
        ready.side_effect = ready_outcome
        with self.assertRaisesRegex(edge.EdgeError, '^activation_failed_rolled_back$'):
            edge.activate(self.plan)
        self.assertFalse(dropin.present)
        self.assertEqual(dropin.removed, 1)
        self.assertEqual(restarted.call_args_list, [mock.call(edge.overlay_command(self.plan)), mock.call(edge.base_command())])
        self.assertEqual(writes, [dropin])

    def test_rollback_refuses_to_remove_another_dropin(self):
        lock, dropin, writes, restarted, ready = self.install_lifecycle_fakes(exists=True)
        with mock.patch.object(edge, 'owned_bytes', return_value=b'ANOTHER CONTROL'):
            with self.assertRaisesRegex(edge.EdgeError, 'refusing_other_overlay_dropin'):
                edge.rollback(self.plan)
        self.assertTrue(dropin.present)
        self.assertEqual(dropin.removed, 0)
        restarted.assert_not_called()

    def test_shared_lock_rejects_replaced_inode_without_creating_a_lock(self):
        before = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_nlink=1, st_uid=0, st_gid=0, st_dev=1, st_ino=23)
        replaced = types.SimpleNamespace(**{**vars(before), 'st_ino': 24})
        path = types.SimpleNamespace(lstat=mock.Mock(side_effect=[before, replaced]))
        fake_fcntl = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=mock.Mock())
        with (mock.patch.object(edge, 'LOCK', path), mock.patch.dict(sys.modules, {'fcntl': fake_fcntl}),
              mock.patch.object(edge.os, 'O_NOFOLLOW', 0x80000, create=True),
              mock.patch.object(edge.os, 'open', return_value=70) as opened,
              mock.patch.object(edge.os, 'fstat', return_value=before), mock.patch.object(edge.os, 'close') as close):
            with self.assertRaisesRegex(edge.EdgeError, 'release_lock_identity_changed'):
                with edge.release_lock():
                    self.fail('replaced lock must never be entered')
        self.assertEqual(opened.call_args.args[1] & os.O_CREAT, 0)
        fake_fcntl.flock.assert_called_once_with(70, 3)
        close.assert_called_once_with(70)

    def test_shared_lock_waits_for_owner_and_preserves_same_inode(self):
        info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_nlink=1, st_uid=0, st_gid=0, st_dev=1, st_ino=23)
        path = types.SimpleNamespace(lstat=mock.Mock(return_value=info))
        fake_fcntl = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=mock.Mock(side_effect=[BlockingIOError, None]))
        with (mock.patch.object(edge, 'LOCK', path), mock.patch.dict(sys.modules, {'fcntl': fake_fcntl}),
              mock.patch.object(edge.os, 'O_NOFOLLOW', 0x80000, create=True),
              mock.patch.object(edge.os, 'open', return_value=70), mock.patch.object(edge.os, 'fstat', return_value=info),
              mock.patch.object(edge.os, 'close') as close, mock.patch.object(edge.time, 'sleep') as sleep):
            with edge.release_lock():
                close.assert_not_called()
        self.assertEqual(fake_fcntl.flock.call_count, 2)
        sleep.assert_called_once_with(.1)
        close.assert_called_once_with(70)


if __name__ == '__main__':
    unittest.main()
