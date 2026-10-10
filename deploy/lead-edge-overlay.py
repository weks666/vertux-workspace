#!/usr/bin/env python3
"""Add one Lead route above the unchanged, receipt-bound KovroCity supervisor.

The private plan and rendered Caddy bytes remain on the database host. This
module never edits a historical control, receipt, Caddy snapshot, or container.
The inherited closed edge is deliberately unchanged: closing KovroCity also
removes this added public route. A later KovroCity release must retire/rebase
this overlay; an unexpected authority change fails closed.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time
import types
import urllib.error
import urllib.request

BASE_CONTROL = pathlib.Path('/usr/local/libexec/kovrocity-ui-release-0.1.11/app-update-0.1.11.py')
BASE_CONTROL_SHA = 'a4e6edd540eda7c40c8e3bf0c7801ae337e2135fa6bd322ff33cc08072676e7e'
BASE_AUTH = pathlib.Path('/var/lib/kovrocity-workspace/release-transactions/runtime-authority-0.1.6.json')
BASE_PLAN = pathlib.Path('/var/lib/kovrocity-workspace/ui-update-0.1.11/plan.json')
BASE_COMMITTED = BASE_PLAN.with_name('committed.json')
UNIT = 'kovrocity-runtime-supervisor-0.1.6.service'
LOCK = pathlib.Path('/run/lock/kovrocity-workspace-deploy.lock')
CADDY = pathlib.Path('/etc/caddy/Caddyfile')
STATE = pathlib.Path('/var/lib/vertux-lead-edge')
CONTROLS = pathlib.Path('/usr/local/libexec/vertux-lead-edge')
DROPIN = pathlib.Path('/etc/systemd/system') / (UNIT + '.d') / '99-vertux-lead-edge.conf'
SUPERVISOR_STATE = pathlib.Path('/run/kovrocity-runtime-supervisor/state.json')
ENDPOINT = 'https://vertuxdb.duckdns.org/webhook/vertux-lead-intelligence'
SHA = re.compile(r'^[0-9a-f]{64}$')
ANCHOR = b'vertuxdb.duckdns.org {'
ROUTE = b'''
    handle /webhook/vertux-lead-intelligence {
        request_body {
            max_size 64KB
        }
        header X-Vertux-Lead v1
        header Cache-Control no-store
        reverse_proxy 127.0.0.1:47921
    }
'''


class EdgeError(RuntimeError):
    """Only constant, nonsecret reason codes cross the operator boundary."""


def require(value, code):
    if not value:
        raise EdgeError(code)


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def owned_bytes(path, modes=(0o400, 0o500, 0o600), *, gid=0):
    """Read an exact root-owned, nonlinked file without following a leaf link."""
    path = pathlib.Path(path)
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == 0
            and (gid is None or before.st_gid == gid)
            and stat.S_IMODE(before.st_mode) in modes and before.st_size <= 2_000_000,
            'protected_file_identity_changed')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(fd)
        require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), 'protected_file_raced')
        chunks = []
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
            require(sum(map(len, chunks)) <= 2_000_000, 'protected_file_too_large')
        after = path.lstat()
        require((opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'protected_file_raced')
        return b''.join(chunks)
    finally:
        os.close(fd)


def record(path, *, system=False):
    raw = owned_bytes(path, (0o400, 0o500, 0o600, 0o640, 0o644) if system else (0o400, 0o500, 0o600),
                      gid=None if system else 0)
    return {'path': str(path), 'sha256': sha(raw)}


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_directory(path):
    path = pathlib.Path(path)
    if not path.exists():
        path.mkdir(mode=0o700)
        fsync_directory(path.parent)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
            and stat.S_IMODE(info.st_mode) == 0o700, 'private_directory_identity_changed')


def publish(path, raw, mode=0o400, *, replace=False):
    """Only called for files owned by this overlay, under the shared flock."""
    path = pathlib.Path(path)
    if path.exists() or path.is_symlink():
        previous = owned_bytes(path, (mode,))
        if not replace:
            require(previous == raw, 'prepared_file_changed')
            return
    temporary = path.with_name('.' + path.name + '.' + os.urandom(12).hex())
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(raw)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


@contextlib.contextmanager
def release_lock(timeout=30):
    """Use the same existing lock inode; never create, replace, or unlink it."""
    import fcntl
    info = LOCK.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == info.st_gid == 0
            and stat.S_IMODE(info.st_mode) == 0o600, 'release_lock_identity_invalid')
    fd = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        require((info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_nlink)
                == (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_gid, opened.st_mode, opened.st_nlink),
                'release_lock_identity_changed')
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < deadline, 'release_lock_busy')
                time.sleep(.1)
        current = LOCK.lstat()
        require((current.st_dev, current.st_ino, current.st_nlink) == (opened.st_dev, opened.st_ino, 1),
                'release_lock_identity_changed')
        yield
        current = LOCK.lstat()
        require((current.st_dev, current.st_ino, current.st_nlink) == (opened.st_dev, opened.st_ino, 1),
                'release_lock_identity_changed')
    finally:
        os.close(fd)


def command(args, *, check=True):
    completed = subprocess.run(args, capture_output=True, timeout=45)
    require(not check or completed.returncode == 0, 'host_command_failed')
    return completed


def property_value(unit, name):
    return command(['systemctl', 'show', unit, '--property=' + name, '--value']).stdout.decode().strip()


def base_command():
    return ['/usr/bin/python3', '-I', str(BASE_CONTROL), 'supervise']


def overlay_command(plan):
    return ['/usr/bin/python3', '-I', plan['controlPath'], 'supervise', '--plan', plan['planPath'],
            '--plan-sha256', sha(canonical(plan))]


def running_command():
    pid = property_value(UNIT, 'MainPID')
    require(re.fullmatch(r'[1-9][0-9]*', pid) is not None, 'supervisor_not_running')
    return [os.fsdecode(item) for item in pathlib.Path('/proc', pid, 'cmdline').read_bytes().split(b'\0') if item]


def service_records():
    paths = set()
    for unit in (UNIT, 'caddy.service', 'kovrocity-release-barrier-0.1.6.service'):
        fragment = property_value(unit, 'FragmentPath')
        require(fragment.startswith(('/etc/systemd/system/', '/lib/systemd/system/', '/usr/lib/systemd/system/')),
                'unexpected_service_fragment')
        paths.add(fragment)
        for path in property_value(unit, 'DropInPaths').split():
            require(path.startswith(('/etc/systemd/system/', '/run/systemd/system/', '/usr/lib/systemd/system/')),
                    'unexpected_service_dropin')
            if path != str(DROPIN):
                paths.add(path)
    return [record(path, system=True) for path in sorted(paths)]


def authority_records():
    return [record(path) for path in (BASE_CONTROL, BASE_AUTH, BASE_PLAN, BASE_COMMITTED)]


def load_original():
    raw = owned_bytes(BASE_CONTROL)
    require(sha(raw) == BASE_CONTROL_SHA, 'base_supervisor_source_changed')
    module = types.ModuleType('vertux_lead_original_supervisor')
    module.__file__ = str(BASE_CONTROL)
    exec(compile(raw, str(BASE_CONTROL), 'exec'), module.__dict__)
    # Both calls are the existing 0.1.11 path, including all previous wrappers.
    return module.bind_supervisor(module.load_base())


def idle(base):
    require(base.active_transaction() is None, 'historical_transaction_active')
    for version in range(7, 12):
        path = pathlib.Path('/var/lib/kovrocity-workspace') / ('ui-update-0.1.' + str(version)) / 'active.json'
        require(not path.exists() and not path.is_symlink(), 'application_transaction_active')


def render(original):
    require(original.count(ANCHOR) == 1 and b'/webhook/vertux-lead-intelligence' not in original,
            'unexpected_base_caddy_routes')
    require(b'\x00' not in original, 'invalid_base_caddy_bytes')
    return original.replace(ANCHOR, ANCHOR + ROUTE, 1)


def plan_paths(operation, control_sha):
    root = STATE / operation
    return {'planPath': str(root / 'plan.json'), 'originalPath': str(root / 'Caddyfile.original'),
            'candidatePath': str(root / 'Caddyfile.lead'),
            'controlPath': str(CONTROLS / control_sha / 'lead-edge-overlay.py')}


def dropin_bytes(plan):
    return ('[Service]\nExecStart=\nExecStart=' + ' '.join(overlay_command(plan)) + '\n').encode()


def validate_plan_structure(plan):
    fields = {'schemaVersion', 'kind', 'operation', 'sourceSha256', 'hostSha256', 'beforeRuntime',
              'authorityRecords', 'serviceRecords', 'baseCaddySha256', 'candidateSha256', 'closedCaddy',
              'planPath', 'originalPath', 'candidatePath', 'controlPath'}
    require(isinstance(plan, dict) and set(plan) == fields and plan['schemaVersion'] == 1
            and plan['kind'] == 'vertux.lead-edge-plan/v1', 'invalid_edge_plan')
    for name in ('operation', 'sourceSha256', 'hostSha256', 'baseCaddySha256', 'candidateSha256'):
        require(isinstance(plan[name], str) and SHA.fullmatch(plan[name]) is not None, 'invalid_edge_plan_hash')
    require(all(plan[name] == value for name, value in plan_paths(plan['operation'], plan['sourceSha256']).items()),
            'invalid_edge_plan_path')
    seed = {key: value for key, value in plan.items() if key not in {'operation', *plan_paths('a' * 64, 'b' * 64)}}
    require(sha(canonical(seed)) == plan['operation'], 'edge_plan_identity_changed')


def load_plan(operation, expected_sha, source_sha=None):
    require(isinstance(operation, str) and SHA.fullmatch(operation) is not None
            and isinstance(expected_sha, str) and SHA.fullmatch(expected_sha) is not None, 'invalid_edge_receipt')
    path = STATE / operation / 'plan.json'
    raw = owned_bytes(path, (0o400,))
    require(sha(raw) == expected_sha, 'edge_plan_hash_changed')
    plan = json.loads(raw)
    validate_plan_structure(plan)
    require(raw == canonical(plan), 'edge_plan_not_canonical')
    if source_sha is not None:
        require(plan['sourceSha256'] == source_sha, 'reviewed_source_changed')
    require(sha(owned_bytes(plan['controlPath'], (0o500,))) == plan['sourceSha256'], 'edge_control_changed')
    require(sha(owned_bytes('/etc/machine-id', (0o444, 0o644), gid=None)) == plan['hostSha256'], 'different_destination_host')
    return plan


def checked_candidate(plan, runtime):
    """No runtime field except the two Caddy fields can be replaced."""
    require(runtime == plan['beforeRuntime'], 'base_runtime_changed')
    require(authority_records() == plan['authorityRecords'], 'base_authority_changed')
    original = owned_bytes(runtime['caddySource'])
    require(sha(original) == runtime['caddySha256'] == plan['baseCaddySha256'], 'base_caddy_changed')
    require(owned_bytes(plan['originalPath'], (0o400,)) == original, 'base_snapshot_changed')
    candidate = owned_bytes(plan['candidatePath'], (0o400,))
    require(candidate == render(original) and sha(candidate) == plan['candidateSha256'], 'candidate_caddy_changed')
    updated = dict(runtime)
    updated.update(caddySource=plan['candidatePath'], caddySha256=plan['candidateSha256'])
    return updated


def bind_overlay(base, plan):
    original_authority = base.authority_runtime
    expected_sha = sha(canonical(plan))

    def authority():
        # Never substitute before the original completed receipt/identity checks.
        runtime = original_authority()
        try:
            current = load_plan(plan['operation'], expected_sha)
            require(record(base.CLOSED_CADDY) == current['closedCaddy'], 'closed_edge_changed')
            return checked_candidate(current, runtime)
        except (EdgeError, OSError, ValueError, KeyError, TypeError) as error:
            raise base.SupervisorError('lead_edge_integrity_failed') from None

    base.authority_runtime = authority
    # main, locks, active-transaction handling, close_runtime, CLOSED_CADDY and
    # install_caddy remain the original functions and use the original guards.
    return base


def caddy_matches(expected_sha):
    import grp
    raw = owned_bytes(CADDY, (0o640,), gid=grp.getgrnam('caddy').gr_gid)
    require(sha(raw) == expected_sha, 'live_caddy_changed')


def host_matches(plan):
    require(service_records() == plan['serviceRecords'], 'service_controls_changed')
    require(authority_records() == plan['authorityRecords'], 'base_authority_changed')


def probe(url, origin, expected, *, marker):
    request = urllib.request.Request(url, data=b'{"action":"overview"}',
                                    headers={'Origin': origin, 'Content-Type': 'application/json'})
    try:
        response = urllib.request.urlopen(request, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    except (OSError, urllib.error.URLError):
        raise EdgeError('edge_probe_unavailable') from None
    try:
        require(response.status == expected and (not marker or response.headers.get('X-Vertux-Lead') == 'v1'),
                'edge_probe_failed')
    finally:
        response.close()


def public_probes():
    probe(ENDPOINT, 'https://weks666.github.io', 401, marker=True)
    probe(ENDPOINT, 'https://foreign.invalid', 403, marker=True)


def prepare(source):
    with release_lock():
        require(not DROPIN.exists() and not DROPIN.is_symlink(), 'overlay_already_installed')
        require(running_command() == base_command(), 'unexpected_active_supervisor')
        base = load_original()
        idle(base)
        runtime = base.authority_runtime()
        require(runtime.get('version') == '0.1.11' and runtime.get('mode') == 'committed'
                and base.runtime_is_exact(runtime), 'base_runtime_not_ready')
        caddy_matches(runtime['caddySha256'])
        probe('http://127.0.0.1:47921/webhook/vertux-lead-intelligence', 'https://weks666.github.io', 401, marker=False)
        original = owned_bytes(runtime['caddySource'])
        require(sha(original) == runtime['caddySha256'], 'base_caddy_changed')
        candidate = render(original)
        seed = {'schemaVersion': 1, 'kind': 'vertux.lead-edge-plan/v1', 'sourceSha256': sha(source),
                'hostSha256': sha(owned_bytes('/etc/machine-id', (0o444, 0o644), gid=None)),
                'beforeRuntime': runtime, 'authorityRecords': authority_records(), 'serviceRecords': service_records(),
                'baseCaddySha256': sha(original), 'candidateSha256': sha(candidate), 'closedCaddy': record(base.CLOSED_CADDY)}
        operation = sha(canonical(seed))
        plan = {**seed, 'operation': operation, **plan_paths(operation, sha(source))}
        validate_plan_structure(plan)
        for directory in (STATE, STATE / operation, CONTROLS, CONTROLS / sha(source)):
            private_directory(directory)
        publish(plan['controlPath'], source, 0o500)
        publish(plan['originalPath'], original)
        publish(plan['candidatePath'], candidate)
        command(['caddy', 'validate', '--config', plan['candidatePath'], '--adapter', 'caddyfile'])
        publish(plan['planPath'], canonical(plan))
        return receipt(plan, 'EDGE_PREPARED')


def receipt(plan, status):
    return {'schemaVersion': 1, 'kind': 'vertux.lead-edge-receipt/v1', 'status': status,
            'operation': plan['operation'], 'planSha256': sha(canonical(plan)), 'sourceSha256': plan['sourceSha256'],
            'hostSha256': plan['hostSha256'], 'baseVersion': plan['beforeRuntime']['version'],
            'baseCaddySha256': plan['baseCaddySha256'], 'candidateSha256': plan['candidateSha256'],
            'dropinSha256': sha(dropin_bytes(plan)), 'endpoint': ENDPOINT, 'secretsPrinted': False,
            'databaseChanged': False, 'containersChanged': False}


def restart_supervisor(expected_command):
    previous_pid = property_value(UNIT, 'MainPID')
    command(['systemctl', 'daemon-reload'])
    command(['systemctl', 'restart', '--no-block', UNIT])
    # Wait only for the command to start while locked. READY requires the shared
    # lock, so waiting for active/READY here would deadlock with the supervisor.
    for _ in range(150):
        try:
            if property_value(UNIT, 'MainPID') not in {'', '0', previous_pid} and running_command() == expected_command:
                return
        except (EdgeError, OSError):
            pass
        time.sleep(.1)
    raise EdgeError('supervisor_command_start_failed')


def ready_then_start_caddy(plan, *, overlay):
    expected = overlay_command(plan) if overlay else base_command()
    expected_sha = plan['candidateSha256'] if overlay else plan['baseCaddySha256']
    for _ in range(120):
        try:
            state = json.loads(owned_bytes(SUPERVISOR_STATE, (0o600,)))
            if (running_command() == expected and property_value(UNIT, 'ActiveState') == 'active'
                    and state.get('status') == 'ready' and state.get('release') == plan['beforeRuntime']['release']):
                caddy_matches(expected_sha)
                break
        except (EdgeError, OSError, ValueError):
            pass
        time.sleep(.25)
    else:
        raise EdgeError('supervisor_ready_failed')
    # The existing Requires relationship may stop Caddy when the supervisor
    # restarts. Start it only after inherited READY and exact bytes are proven.
    command(['systemctl', 'start', 'caddy.service'])
    require(property_value('caddy.service', 'ActiveState') == 'active', 'caddy_not_active')


def verify(plan, *, overlay=True):
    expected_command = overlay_command(plan) if overlay else base_command()
    expected_sha = plan['candidateSha256'] if overlay else plan['baseCaddySha256']
    # Four observations span 7.5 seconds, exceeding several 2-second monitor
    # cycles. The earlier one-shot route smoke could pass before reconciliation.
    for attempt in range(4):
        if attempt:
            time.sleep(2.5)
        with release_lock():
            host_matches(plan)
            require(running_command() == expected_command, 'supervisor_command_changed')
            if overlay:
                require(owned_bytes(DROPIN, (0o644,)) == dropin_bytes(plan), 'overlay_dropin_changed')
            else:
                require(not DROPIN.exists() and not DROPIN.is_symlink(), 'overlay_dropin_remains')
            base = load_original()
            idle(base)
            runtime = base.authority_runtime()
            require(runtime == plan['beforeRuntime'] and base.runtime_is_exact(runtime), 'base_runtime_changed')
            if overlay:
                checked_candidate(plan, runtime)
            caddy_matches(expected_sha)
            require(property_value(UNIT, 'ActiveState') == 'active'
                    and property_value('caddy.service', 'ActiveState') == 'active', 'edge_services_not_ready')
        if overlay:
            public_probes()
    result = receipt(plan, 'EDGE_ACTIVE_VERIFIED' if overlay else 'EDGE_ROLLED_BACK')
    result.update(observations=4, observationSpanSeconds=7.5, authenticatedOwnerVerified=False)
    if overlay:
        result.update(missingAuthStatus=401, foreignOriginStatus=403, routeMarker='v1')
    return result


def rollback(plan):
    with release_lock():
        host_matches(plan)
        base = load_original()
        idle(base)
        runtime = base.authority_runtime()
        require(runtime == plan['beforeRuntime'] and base.runtime_is_exact(runtime), 'base_runtime_changed')
        if DROPIN.exists() or DROPIN.is_symlink():
            require(owned_bytes(DROPIN, (0o644,)) == dropin_bytes(plan), 'refusing_other_overlay_dropin')
            DROPIN.unlink()
            fsync_directory(DROPIN.parent)
        require(running_command() in (base_command(), overlay_command(plan)), 'unexpected_active_supervisor')
        restart_supervisor(base_command())
    ready_then_start_caddy(plan, overlay=False)
    return verify(plan, overlay=False)


def activate(plan):
    changed = False
    try:
        with release_lock():
            host_matches(plan)
            base = load_original()
            idle(base)
            runtime = base.authority_runtime()
            require(runtime == plan['beforeRuntime'] and base.runtime_is_exact(runtime), 'base_runtime_changed')
            checked_candidate(plan, runtime)
            require(record(base.CLOSED_CADDY) == plan['closedCaddy'], 'closed_edge_changed')
            require(running_command() in (base_command(), overlay_command(plan)), 'unexpected_active_supervisor')
            if DROPIN.exists() or DROPIN.is_symlink():
                require(owned_bytes(DROPIN, (0o644,)) == dropin_bytes(plan), 'refusing_other_overlay_dropin')
            else:
                caddy_matches(plan['baseCaddySha256'])
                info = DROPIN.parent.lstat()
                require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                        'supervisor_dropin_directory_invalid')
                publish(DROPIN, dropin_bytes(plan), 0o644)
            changed = True
            restart_supervisor(overlay_command(plan))
        ready_then_start_caddy(plan, overlay=True)
        return verify(plan)
    except Exception:
        if changed:
            try:
                rollback(plan)
            except Exception:
                raise EdgeError('activation_failed_rollback_incomplete') from None
            raise EdgeError('activation_failed_rolled_back') from None
        raise


def operator(request, source):
    """Called by the SSH helper; only sanitized receipts are returned."""
    require(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root_required')
    os.umask(0o077)
    require(isinstance(source, bytes) and request.get('sourceSha256') == sha(source), 'source_transfer_changed')
    mode = request.get('mode')
    if mode == 'prepare':
        return prepare(source)
    require(mode in {'activate', 'verify', 'rollback'}, 'invalid_operator_mode')
    supplied = request.get('receipt', {})
    plan = load_plan(supplied.get('operation'), supplied.get('planSha256'), sha(source))
    require(supplied.get('kind') == 'vertux.lead-edge-receipt/v1'
            and supplied.get('sourceSha256') == sha(source) and supplied.get('hostSha256') == plan['hostSha256']
            and supplied.get('candidateSha256') == plan['candidateSha256']
            and supplied.get('dropinSha256') == sha(dropin_bytes(plan)), 'reviewed_receipt_changed')
    result = {'activate': activate, 'verify': verify, 'rollback': rollback}[mode](plan)
    with release_lock():
        publish(STATE / plan['operation'] / ('receipt-' + mode + '.json'), canonical(result), 0o600, replace=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['supervise'])
    parser.add_argument('--plan', required=True)
    parser.add_argument('--plan-sha256', required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, 'root_required')
    plan_path = pathlib.Path(args.plan)
    require(plan_path.name == 'plan.json' and plan_path.parent.parent == STATE, 'invalid_edge_plan_path')
    plan = load_plan(plan_path.parent.name, args.plan_sha256, sha(owned_bytes(__file__, (0o500,))))
    base = load_original()
    return bind_overlay(base, plan).main()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        # Never reflect subprocess stderr, Caddy bytes, or an exception message.
        print(json.dumps({'status': 'EDGE_FAILED', 'reason': 'supervisor_start_failed', 'secretsPrinted': False}))
        raise SystemExit(1)
