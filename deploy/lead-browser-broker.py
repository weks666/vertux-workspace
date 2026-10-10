#!/usr/bin/env python3
"""Root-owned, bounded Unix-socket adapter for the isolated lead renderer.

The application never receives a Docker socket. Its Docker-looking argv is only
a request format: this daemon compares it with a fixed grammar and constructs
the real command itself. No caller command, mount, env, image or seccomp override
is forwarded. There is no shell and no credential-file lookup.
"""
import dataclasses
import json
import os
import re
import signal
import socket
import stat
import subprocess
import threading
import time
import uuid

HEADER_LIMIT = 8192
LINE_LIMIT = 3 * 1024 * 1024
INPUT_LIMIT = 16 * 1024 * 1024
OUTPUT_LIMIT = 8 * 1024 * 1024
NAME = re.compile(r"vertux-lead-render-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
IMAGE = re.compile(r"(?:sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9._:/-]{0,150}@sha256:[0-9a-f]{64})\Z")
OWNER_LABEL = "io.vertux.lead-browser.owner"
REQUEST_LABEL = "io.vertux.lead-browser.request"
SAFE_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "DOCKER_HOST": "unix:///var/run/docker.sock", "DOCKER_CONFIG": "/nonexistent"}
FAILURE = b'{"type":"error","code":"RENDERER_UNAVAILABLE"}\n'


class Rejected(Exception):
    """Stable internal failure without reflecting caller input."""


@dataclasses.dataclass(frozen=True)
class Config:
    image: str
    seccomp: str
    socket_path: str = "/run/vertux-lead-browser/broker.sock"
    gid: int = 0
    max_active: int = 1
    timeout: float = 45.0

    def __post_init__(self):
        if not IMAGE.fullmatch(self.image or ""):
            raise Rejected("pinned_image_required")
        if not re.fullmatch(r"/[A-Za-z0-9_./-]{1,180}", self.seccomp or "") or ".." in self.seccomp.split("/"):
            raise Rejected("fixed_seccomp_required")
        if not re.fullmatch(r"/[A-Za-z0-9_./-]{1,100}", self.socket_path) or ".." in self.socket_path.split("/"):
            raise Rejected("socket_path_invalid")
        if not isinstance(self.gid, int) or self.gid < 0 or self.max_active not in (1, 2) or not (0.05 <= self.timeout <= 45):
            raise Rejected("limits_invalid")

    def canonical(self, name):
        return ["run", "--rm", "--pull=never", "--name", name, "--network=none", "--read-only", "--init", "--user", "pwuser",
                "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=768m", "--cpus=1", "--shm-size=256m",
                "--tmpfs", "/tmp:rw,nosuid,nodev,size=192m", "-i", "--security-opt", "seccomp=" + self.seccomp,
                "--entrypoint", "node", self.image, "/app/lead-server/browser-renderer.mjs", "--isolated-child"]


@dataclasses.dataclass
class Run:
    name: str
    nonce: str = dataclasses.field(default_factory=lambda: uuid.uuid4().hex)
    stop: threading.Event = dataclasses.field(default_factory=threading.Event)
    cleanup_lock: threading.Lock = dataclasses.field(default_factory=threading.Lock)
    removed: bool = False
    active: bool = True
    finished_at: float = 0.0
    process: object = None


class Broker:
    def __init__(self, config, *, popen=subprocess.Popen, command=subprocess.run):
        self.config = config
        self.popen = popen
        self.command = command
        self.owner = uuid.uuid4().hex
        self.lock = threading.Lock()
        self.runs = {}
        self.closed = False

    def validate(self, argv):
        if not isinstance(argv, list) or len(argv) > 40 or any(not isinstance(item, str) or len(item) > 300 for item in argv):
            raise Rejected("argv_invalid")
        if len(argv) == 3 and argv[:2] == ["rm", "--force"] and NAME.fullmatch(argv[2]):
            return "rm", argv[2]
        if len(argv) >= 5 and NAME.fullmatch(argv[4]) and argv == self.config.canonical(argv[4]):
            return "run", argv[4]
        raise Rejected("argv_rejected")

    def admit(self, name):
        with self.lock:
            # Bounded replay history also permits a parent's delayed cleanup.
            expired = [key for key, value in self.runs.items() if not value.active and time.monotonic() - value.finished_at > 300]
            for key in expired:
                del self.runs[key]
            if self.closed or name in self.runs or len(self.runs) >= 256 or sum(run.active for run in self.runs.values()) >= self.config.max_active:
                raise Rejected("renderer_busy")
            run = Run(name)
            self.runs[name] = run
            return run

    def launch_argv(self, run):
        args = self.config.canonical(run.name)
        position = args.index("--entrypoint")
        args[position:position] = ["--label", OWNER_LABEL + "=" + self.owner, "--label", REQUEST_LABEL + "=" + run.nonce,
                                   "--log-driver=none", "--memory-swap=768m"]
        return ["/usr/bin/docker", *args]

    def remove_owned(self, name):
        with self.lock:
            run = self.runs.get(name)
        if run is None:
            return False
        run.stop.set()
        with run.cleanup_lock:
            if run.removed:
                return True
            # Verify both labels on a container created by this daemon instance,
            # then remove its immutable ID, avoiding a name-replacement race.
            template = '{{.Id}} {{index .Config.Labels "' + OWNER_LABEL + '"}} {{index .Config.Labels "' + REQUEST_LABEL + '"}}'
            try:
                found = self.command(["/usr/bin/docker", "inspect", "--type=container", "--format", template, name], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, env=SAFE_ENV, check=False)
                parts = found.stdout.decode("ascii", "strict").strip().split()
                if found.returncode != 0 or len(parts) != 3 or not re.fullmatch(r"[0-9a-f]{64}", parts[0]) or parts[1:] != [self.owner, run.nonce]:
                    return False
                removed = self.command(["/usr/bin/docker", "rm", "--force", parts[0]], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, timeout=5, env=SAFE_ENV, check=False)
                run.removed = removed.returncode == 0
                return run.removed
            except (OSError, ValueError, subprocess.SubprocessError):
                return False

    @staticmethod
    def read_header(connection):
        deadline = time.monotonic() + 2
        data = b""
        connection.settimeout(0.25)
        while b"\n" not in data:
            if len(data) > HEADER_LIMIT or time.monotonic() >= deadline:
                raise Rejected("header_limit")
            try:
                piece = connection.recv(min(4096, HEADER_LIMIT + 1 - len(data)))
            except socket.timeout:
                continue
            if not piece:
                raise Rejected("header_missing")
            data += piece
        line, remainder = data.split(b"\n", 1)
        if len(line) > HEADER_LIMIT:
            raise Rejected("header_limit")
        try:
            value = json.loads(line.decode("utf-8", "strict"))
        except (ValueError, RecursionError):
            raise Rejected("header_invalid") from None
        if not isinstance(value, dict) or set(value) != {"argv"}:
            raise Rejected("header_invalid")
        return value["argv"], remainder

    def pipe_run(self, connection, run, initial):
        process = self.popen(self.launch_argv(run), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             bufsize=0, env=SAFE_ENV, start_new_session=True)
        run.process = process
        done = threading.Event()
        deadline = time.monotonic() + self.config.timeout
        connection.settimeout(1)

        def transfer(source, target, maximum, initial_data=b"", discard=False):
            total, line_length = 0, 0
            try:
                piece = initial_data
                while not done.is_set() and not run.stop.is_set():
                    if not piece:
                        try:
                            piece = source.recv(65536) if source is connection else source.read(65536)
                        except socket.timeout:
                            continue
                    if not piece:
                        if source is connection:
                            run.stop.set()  # Caller EOF/cancel always ends the render.
                        return
                    total += len(piece)
                    if total > maximum:
                        raise Rejected("stream_limit")
                    if not discard:
                        parts = piece.split(b"\n")
                        if len(parts) == 1:
                            line_length += len(piece)
                        else:
                            if line_length + len(parts[0]) > LINE_LIMIT or any(len(part) > LINE_LIMIT for part in parts[1:]):
                                raise Rejected("line_limit")
                            line_length = len(parts[-1])
                        if line_length > LINE_LIMIT:
                            raise Rejected("line_limit")
                        if target is connection:
                            connection.sendall(piece)
                        else:
                            view = memoryview(piece)
                            while view and not run.stop.is_set():
                                written = target.write(view)
                                if not written:
                                    raise Rejected("pipe_closed")
                                view = view[written:]
                    piece = b""
            except (OSError, ValueError, Rejected):
                run.stop.set()

        incoming = threading.Thread(target=transfer, args=(connection, process.stdin, INPUT_LIMIT, initial), daemon=True)
        outgoing = threading.Thread(target=transfer, args=(process.stdout, connection, OUTPUT_LIMIT), daemon=True)
        diagnostic = threading.Thread(target=transfer, args=(process.stderr, None, 256 * 1024, b"", True), daemon=True)
        for thread in (incoming, outgoing, diagnostic):
            thread.start()
        try:
            while process.poll() is None and not run.stop.wait(0.05):
                if time.monotonic() >= deadline:
                    run.stop.set()
            if process.poll() is not None and not run.stop.is_set():
                outgoing.join(timeout=1)  # Drain its final JSON line before EOF.
        finally:
            done.set()
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            for stream in (process.stdin, process.stdout, process.stderr):
                try:
                    stream.close()
                except OSError:
                    pass
            for thread in (incoming, outgoing, diagnostic):
                thread.join(timeout=0.25)

    def handle(self, connection):
        run = None
        try:
            argv, initial = self.read_header(connection)
            operation, name = self.validate(argv)
            if operation == "rm":
                if initial or not self.remove_owned(name):
                    raise Rejected("cleanup_unowned")
                return
            run = self.admit(name)
            self.pipe_run(connection, run, initial)
        except (Rejected, OSError, ValueError, subprocess.SubprocessError):
            try:
                connection.sendall(FAILURE)
            except OSError:
                pass
        finally:
            connection.close()
            if run:
                # Docker --rm handles the usual exit. Explicit cleanup also
                # handles cancellation or a killed attach client, only by label.
                for attempt in range(3):
                    if self.remove_owned(run.name):
                        break
                    if attempt < 2:
                        time.sleep(0.1)
                with self.lock:
                    run.active = False
                    run.finished_at = time.monotonic()

    def close(self):
        with self.lock:
            self.closed = True
            names = [name for name, run in self.runs.items() if run.active]
            for name in names:
                self.runs[name].stop.set()
        for name in names:
            self.remove_owned(name)


def checked_root_file(path):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise Rejected("root_owned_file_required")


def serve(config):
    if not hasattr(os, "geteuid") or os.geteuid() != 0 or not hasattr(socket, "AF_UNIX"):
        raise Rejected("linux_root_required")
    checked_root_file("/usr/bin/docker")
    checked_root_file(config.seccomp)
    with open(config.seccomp, "rb") as handle:
        profile = handle.read(256001)
    if len(profile) > 256000 or json.loads(profile).get("defaultAction") != "SCMP_ACT_ERRNO":
        raise Rejected("reviewed_seccomp_required")
    parent = os.path.dirname(config.socket_path)
    os.makedirs(parent, mode=0o750, exist_ok=True)
    info = os.lstat(parent)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise Rejected("root_owned_socket_directory_required")
    os.chown(parent, 0, config.gid)
    os.chmod(parent, 0o750)
    if os.path.lexists(config.socket_path):
        info = os.lstat(config.socket_path)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
            raise Rejected("socket_path_in_use")
        os.unlink(config.socket_path)
    broker = Broker(config)
    stopping = threading.Event()
    slots = threading.BoundedSemaphore(config.max_active + 4)
    threads = set()
    threads_lock = threading.Lock()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # Temporary umask closes the brief bind-to-chmod permission window.
    previous = os.umask(0o117)
    try:
        listener.bind(config.socket_path)
    finally:
        os.umask(previous)
    os.chown(config.socket_path, 0, config.gid)
    os.chmod(config.socket_path, 0o660)
    listener.listen(config.max_active + 4)
    listener.settimeout(0.5)
    def stop(_signum, _frame):
        stopping.set()
    for kind in (signal.SIGINT, signal.SIGTERM):
        signal.signal(kind, stop)
    def client(connection):
        try:
            broker.handle(connection)
        finally:
            slots.release()
            with threads_lock:
                threads.discard(threading.current_thread())
    try:
        while not stopping.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            if not slots.acquire(blocking=False):
                connection.close()
                continue
            thread = threading.Thread(target=client, args=(connection,), daemon=True)
            with threads_lock:
                threads.add(thread)
            thread.start()
    finally:
        listener.close()
        broker.close()
        with threads_lock:
            remaining = list(threads)
        for thread in remaining:
            thread.join(timeout=10)
        os.unlink(config.socket_path)


def main():
    try:
        if len(os.sys.argv) != 1:
            raise Rejected("arguments_not_supported")
        config = Config(image=os.environ.get("LEAD_BROWSER_IMAGE", ""), seccomp=os.environ.get("LEAD_BROWSER_SECCOMP_PROFILE", ""),
                        socket_path=os.environ.get("LEAD_BROWSER_BROKER_SOCKET", "/run/vertux-lead-browser/broker.sock"),
                        gid=int(os.environ.get("LEAD_BROWSER_BROKER_GID", "0")), max_active=int(os.environ.get("LEAD_BROWSER_MAX_ACTIVE", "1")))
        serve(config)
    except (Rejected, OSError, ValueError):
        # Never log caller argv, page content, Docker stderr or environment.
        os.sys.stderr.write("lead_browser_broker_unavailable\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
