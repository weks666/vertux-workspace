"""Offline broker acceptance: socket pairs and fixture subprocesses, no Docker."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import types
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[1] / "deploy" / "lead-browser-broker.py"
SPEC = importlib.util.spec_from_file_location("lead_browser_broker_fixture_module", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
PIN = "sha256:" + "a" * 64
PROFILE = "/etc/vertux-lead-browser/seccomp.json"
FIXTURE_CHILD = """
import json, sys, time
mode = sys.argv[1]
if mode == 'stall':
    time.sleep(60)
elif mode == 'drain':
    while sys.stdin.buffer.read(65536): pass
else:
    initial = json.loads(sys.stdin.buffer.readline())
    sys.stderr.write('private fixture diagnostic, never forward\\n')
    print(json.dumps({'type':'request','id':1,'url':initial['url'],'method':'GET','resourceType':'document'}), flush=True)
    response = json.loads(sys.stdin.buffer.readline())
    assert response['id'] == 1
    print(json.dumps({'type':'result','url':initial['url'],'html':'<h1>Offline fixture</h1>'}), flush=True)
"""


def name():
    return "vertux-lead-render-" + str(uuid.uuid4())


class FakeDocker:
    def __init__(self, mode="render"):
        self.mode = mode
        self.launches = []
        self.commands = []
        self.labels = {}
        self.processes = []
        self.started = threading.Event()
        self.spoof = False

    def popen(self, argv, **options):
        self.launches.append((argv, options))
        assert argv[0:2] == ["/usr/bin/docker", "run"]
        assert options["env"] == MODULE.SAFE_ENV
        assert options.get("shell") is None
        container = argv[argv.index("--name") + 1]
        labels = dict(argv[index + 1].split("=", 1) for index, part in enumerate(argv) if part == "--label")
        self.labels[container] = labels
        process = subprocess.Popen([sys.executable, "-u", "-c", FIXTURE_CHILD, self.mode], **options)
        self.processes.append(process)
        self.started.set()
        return process

    def command(self, argv, **options):
        self.commands.append((argv, options))
        assert argv[0] == "/usr/bin/docker"
        assert options["env"] == MODULE.SAFE_ENV
        assert options.get("shell") is None
        if argv[1] == "inspect":
            container = argv[-1]
            labels = self.labels.get(container)
            if not labels:
                return types.SimpleNamespace(returncode=1, stdout=b"")
            owner = "foreign-owner" if self.spoof else labels[MODULE.OWNER_LABEL]
            identifier = hashlib.sha256(container.encode()).hexdigest()
            text = " ".join([identifier, owner, labels[MODULE.REQUEST_LABEL]])
            return types.SimpleNamespace(returncode=0, stdout=text.encode())
        if argv[1:3] == ["rm", "--force"]:
            assert len(argv) == 4 and len(argv[3]) == 64
            return types.SimpleNamespace(returncode=0, stdout=b"")
        raise AssertionError("Unexpected fixture command")

    @property
    def removals(self):
        return [argv for argv, _ in self.commands if argv[1] == "rm"]


class Session:
    def __init__(self, broker, argv, initial=b""):
        self.client, server = socket.socketpair()
        self.client.settimeout(3)
        self.thread = threading.Thread(target=broker.handle, args=(server,), daemon=True)
        self.thread.start()
        self.client.sendall(json.dumps({"argv": argv}).encode() + b"\n" + initial)
        self.buffer = b""

    def line(self):
        while b"\n" not in self.buffer:
            chunk = self.client.recv(65536)
            if not chunk:
                raise EOFError("fixture stream closed")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def send(self, value):
        self.client.sendall(json.dumps(value).encode() + b"\n")

    def finish(self):
        self.client.close()
        self.thread.join(timeout=5)
        if self.thread.is_alive():
            raise AssertionError("broker fixture did not terminate")


class BrokerTests(unittest.TestCase):
    def fixture(self, mode="render", **config):
        docker = FakeDocker(mode)
        cfg = MODULE.Config(image=PIN, seccomp=PROFILE, **config)
        broker = MODULE.Broker(cfg, popen=docker.popen, command=docker.command)
        self.addCleanup(broker.close)
        return cfg, docker, broker

    def test_pinned_image_limits_and_exact_canonical_grammar(self):
        cfg, docker, broker = self.fixture()
        container = name()
        good = cfg.canonical(container)
        self.assertEqual(broker.validate(good), ("run", container))
        self.assertEqual(broker.validate(["rm", "--force", container]), ("rm", container))
        candidates = []
        for before, after in [("--network=none", "--network=host"), ("--read-only", "--privileged"),
                              (PIN, "attacker/image:latest"), ("pwuser", "root"), ("node", "sh"),
                              ("seccomp=" + PROFILE, "seccomp=unconfined"), (container, "postgres")]:
            candidates.append([after if item == before else item for item in good])
        candidates += [good + ["-v", "/:/host"], good + ["--env", "SECRET=bad"], good + ["--label", "owner=bad"],
                       good + ["--mount", "type=bind,source=/etc,target=/host"], ["ps"], ["exec", container, "sh"],
                       ["rm", "--force", "postgres"], good[:-1], good + ["--network=none"]]
        for argv in candidates:
            with self.assertRaises(MODULE.Rejected):
                broker.validate(argv)
        for kwargs in [dict(image="image:latest", seccomp=PROFILE), dict(image=PIN, seccomp="unconfined"),
                       dict(image=PIN, seccomp=PROFILE, max_active=3), dict(image=PIN, seccomp=PROFILE, timeout=46)]:
            with self.assertRaises(MODULE.Rejected):
                MODULE.Config(**kwargs)
        self.assertEqual(docker.launches, [])

    def test_actual_node_renderer_arguments_match_broker_contract(self):
        _, _, broker = self.fixture()
        # The Node wrapper captures these from the real createBrowserRenderer,
        # so an incompatible change to either side breaks this offline test.
        self.assertIn("LEAD_TEST_RENDERER_ARGV", os.environ)
        argv = json.loads(os.environ["LEAD_TEST_RENDERER_ARGV"])
        self.assertEqual(broker.validate(argv), ("run", argv[4]))

    def test_normal_protocol_is_transparent_and_cleanup_uses_verified_container_id(self):
        cfg, docker, broker = self.fixture()
        container = name()
        initial = json.dumps({"type": "init", "url": "https://synthetic.example/"}).encode() + b"\n"
        session = Session(broker, cfg.canonical(container), initial)
        try:
            self.assertEqual(session.line(), {"type": "request", "id": 1, "url": "https://synthetic.example/", "method": "GET", "resourceType": "document"})
            session.send({"type": "response", "id": 1, "status": 200, "body": "Zml4dHVyZQ=="})
            result = session.line()
            self.assertEqual(result["html"], "<h1>Offline fixture</h1>")
            self.assertNotIn("private", json.dumps(result))
            self.assertEqual(session.client.recv(1), b"")
        finally:
            session.finish()
        self.assertEqual(len(docker.launches), 1)
        argv, options = docker.launches[0]
        for item in ["--network=none", "--read-only", "--cap-drop=ALL", "--memory=768m", "--memory-swap=768m", "--cpus=1", "--log-driver=none", "--security-opt=no-new-privileges", "seccomp=" + PROFILE]:
            self.assertIn(item, argv)
        self.assertNotIn("--env", argv)
        self.assertNotIn("--mount", argv)
        self.assertNotIn("-v", argv)
        self.assertEqual(options["env"], MODULE.SAFE_ENV)
        self.assertEqual(len(docker.removals), 1)
        self.assertEqual(docker.removals[0][-1], hashlib.sha256(container.encode()).hexdigest())
        cleanup = Session(broker, ["rm", "--force", container])
        try:
            self.assertEqual(cleanup.client.recv(4096), b"")
        finally:
            cleanup.finish()
        self.assertEqual(len(docker.removals), 1)

    def test_untracked_and_foreign_labelled_containers_can_never_be_removed(self):
        cfg, docker, broker = self.fixture("stall", timeout=0.1)
        self.assertFalse(broker.remove_owned(name()))
        self.assertEqual(docker.commands, [])
        unknown = Session(broker, ["rm", "--force", name()])
        try:
            self.assertEqual(unknown.client.recv(4096), MODULE.FAILURE)
        finally:
            unknown.finish()
        self.assertEqual(docker.commands, [])
        docker.spoof = True
        session = Session(broker, cfg.canonical(name()))
        try:
            self.assertTrue(docker.started.wait(2))
            session.thread.join(3)
            self.assertFalse(session.thread.is_alive())
        finally:
            session.finish()
        self.assertGreater(len(docker.commands), 0)
        self.assertEqual(docker.removals, [])

    def test_active_limit_duplicate_names_and_bounded_tracking_fail_closed(self):
        _, _, broker = self.fixture()
        first = name()
        broker.admit(first)
        for target in [first, name()]:
            with self.assertRaises(MODULE.Rejected):
                broker.admit(target)
        _, _, two = self.fixture(max_active=2)
        two.admit(name()); two.admit(name())
        with self.assertRaises(MODULE.Rejected):
            two.admit(name())

    def test_invalid_header_and_forbidden_command_do_not_launch_a_subprocess(self):
        _, docker, broker = self.fixture()
        for raw in [b"x" * 8193, b'{"argv":["ps"]}\n', b'{"argv":[],"env":{"SECRET":"private"}}\n', b'{invalid}\n']:
            client, server = socket.socketpair()
            client.settimeout(2)
            thread = threading.Thread(target=broker.handle, args=(server,), daemon=True)
            thread.start()
            try:
                client.sendall(raw)
                self.assertEqual(client.recv(4096), MODULE.FAILURE)
            finally:
                client.close(); thread.join(3)
            self.assertFalse(thread.is_alive())
        self.assertEqual(docker.launches, [])

    def test_hard_timeout_and_caller_eof_kill_fixture_and_cleanup(self):
        for by_eof in [False, True]:
            cfg, docker, broker = self.fixture("stall", timeout=0.1 if not by_eof else 2)
            session = Session(broker, cfg.canonical(name()))
            try:
                self.assertTrue(docker.started.wait(2))
                start = time.monotonic()
                if by_eof:
                    session.client.shutdown(socket.SHUT_WR)
                session.thread.join(3)
                self.assertFalse(session.thread.is_alive())
                self.assertLess(time.monotonic() - start, 2)
                self.assertIsNotNone(docker.processes[0].poll())
                self.assertEqual(len(docker.removals), 1)
            finally:
                session.finish()

    def test_oversized_protocol_line_stops_child_without_unbounded_buffering(self):
        cfg, docker, broker = self.fixture("drain", timeout=3)
        session = Session(broker, cfg.canonical(name()))
        try:
            self.assertTrue(docker.started.wait(2))
            try:
                session.client.sendall(b"x" * (MODULE.LINE_LIMIT + 1))
            except OSError:
                pass
            session.thread.join(4)
            self.assertFalse(session.thread.is_alive())
            self.assertIsNotNone(docker.processes[0].poll())
            self.assertEqual(len(docker.removals), 1)
        finally:
            session.finish()


if __name__ == "__main__":
    unittest.main(verbosity=2)
