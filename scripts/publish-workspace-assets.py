"""Prepare an assets-only GitHub Pages commit without changing the checkout.

Default/--prepare: read deploy/lead-workspace-assets.txt, create an isolated Git
index/tree/commit, and save a SHA-256 receipt under ignored evidence. Dirty assets
can be reviewed, but cannot be published. Clean packages use committed HEAD bytes.

--publish --receipt PATH: require the unchanged committed package and source HEAD
already on origin/main; push gh-pages normally, update only Pages' source, and
request a build unless this exact commit is already queued, building, or built.
--verify --receipt PATH: read-only Pages build polling and HTTPS hashes of every
allowlisted asset. .nojekyll is verified in the Git tree, not assumed HTTP-public.
--self-test: temporary local repository with fake remotes, Pages API and HTTPS.

No source-branch push, force push, checkout, real-index write, CNAME change,
provider call, credentials, server source, documentation, or fixtures are shipped.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "weks666/vertux-workspace"
SITE_URL = "https://weks666.github.io/vertux-workspace/"
MANIFEST = "deploy/lead-workspace-assets.txt"
EVIDENCE = "evidence/lead-intelligence"
PAGES_REF = "refs/heads/gh-pages"
SOURCE_REF = "refs/heads/main"
SHA = re.compile(r"[0-9a-f]{40}")
FORBIDDEN_ROOTS = {".git", "backend", "lead-server", "trainer-server", "docs", "tests", "fixtures", "fixture", "scripts", "deploy", "node_modules", "evidence"}
SUFFIXES = {".html", ".css", ".js", ".json", ".webmanifest", ".svg", ".png", ".webp", ".ico", ".woff", ".woff2"}


class ReleaseError(RuntimeError):
    """A bounded public diagnostic; command output is never included."""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def require(condition: bool, code: str) -> None:
    if not condition:
        raise ReleaseError(code)


def manifest_names(raw: bytes) -> list[str]:
    try:
        names = [line.strip() for line in raw.decode("utf-8-sig").splitlines() if line.strip() and not line.lstrip().startswith("#")]
    except UnicodeError as exc:
        raise ReleaseError("allowlist_must_be_utf8") from exc
    require(bool(names) and len(names) <= 100, "invalid_allowlist_size")
    require(len(names) == len({name.lower() for name in names}), "duplicate_allowlist_entry")
    for name in names:
        path = PurePosixPath(name)
        require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", name)), "invalid_asset_path")
        require(not path.is_absolute() and ".." not in path.parts and "." not in path.parts and str(path) == name, "invalid_asset_path")
        require(path.parts[0].lower() not in FORBIDDEN_ROOTS, "non_public_asset_forbidden")
        require(not any(part.startswith(".") for part in path.parts), "hidden_asset_forbidden")
        require(path.suffix.lower() in SUFFIXES and path.name.lower() != "cname", "non_public_asset_forbidden")
    return sorted(names)


class SameSiteRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        require(target.scheme == "https" and target.netloc == "weks666.github.io" and target.path.startswith("/vertux-workspace/") and not target.username, "unexpected_https_redirect")
        return super().redirect_request(request, fp, code, message, headers, newurl)


class AssetRelease:
    def __init__(self, root: Path):
        self.root = root.resolve()
        require(self.git("rev-parse", "--show-toplevel").decode().strip().replace("\\", "/").lower() == self.root.as_posix().lower(), "wrong_git_root")
        remote = self.git("remote", "get-url", "origin").decode().strip()
        allowed = {f"https://github.com/{REPOSITORY}.git", f"https://github.com/{REPOSITORY}", f"git@github.com:{REPOSITORY}.git"}
        require(remote in allowed, "unexpected_repository_origin")

    def command(self, argv: list[str], data: bytes | None = None, env: dict | None = None, check: bool = True) -> subprocess.CompletedProcess:
        environment = os.environ.copy()
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"):
            environment.pop(key, None)
        environment["GIT_OPTIONAL_LOCKS"] = "0"
        if env:
            environment.update(env)
        try:
            result = subprocess.run(argv, cwd=self.root, input=data, capture_output=True, env=environment, timeout=120, shell=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ReleaseError("command_unavailable_or_timed_out:" + argv[0]) from exc
        if check and result.returncode:
            raise ReleaseError("command_failed:" + argv[0] + ":" + (argv[1] if len(argv) > 1 else ""))
        return result

    def git(self, *args: str, data: bytes | None = None, env: dict | None = None) -> bytes:
        return self.command(["git", *args], data, env).stdout

    def head(self) -> str:
        return self.git("rev-parse", "HEAD").decode().strip()

    def remote_head(self, ref: str) -> str | None:
        raw = self.git("ls-remote", "--refs", "origin", ref).decode().strip()
        if not raw:
            return None
        fields = raw.split()
        require(len(fields) == 2 and fields[1] == ref and bool(SHA.fullmatch(fields[0])), "unexpected_remote_ref")
        return fields[0]

    def ensure_object(self, commit: str) -> None:
        if self.command(["git", "cat-file", "-e", commit + "^{commit}"], check=False).returncode:
            self.git("fetch", "--no-write-fetch-head", "--no-tags", "origin", commit)
        self.git("cat-file", "-e", commit + "^{commit}")

    def working_file(self, name: str) -> bytes:
        path = self.root / name
        require(path.resolve().is_relative_to(self.root), "asset_outside_repository")
        require(path.is_file() and not any(p.is_symlink() for p in [path, *path.parents] if p != self.root.parent), "asset_must_be_regular_file")
        return path.read_bytes()

    def source_files(self, source: str, names: list[str]) -> dict[str, bytes]:
        require(bool(SHA.fullmatch(source)), "invalid_source_commit")
        entries = self.git("ls-tree", "-rz", source, "--", *names).split(b"\0")
        modes = {entry.split(b"\t", 1)[1].decode(): entry.split(b" ", 1)[0] for entry in entries if entry}
        require(set(modes) == set(names) and all(mode in (b"100644", b"100755") for mode in modes.values()), "committed_assets_must_be_regular_files")
        return {name: self.git("show", source + ":" + name) for name in names}

    def dirty_files(self, source: str, names: list[str]) -> list[str]:
        selected = [MANIFEST, *names]
        dirty = set()
        # Even read-only-looking `git diff` can refresh stat entries. Reconstruct
        # selected staged entries in a disposable index before either comparison.
        staged = self.git("ls-files", "--stage", "-z", "--", *selected)
        with tempfile.TemporaryDirectory(prefix="workspace-assets-check-") as directory:
            env = {"GIT_INDEX_FILE": str(Path(directory) / "index")}
            self.git("read-tree", "--empty", env=env)
            self.git("update-index", "-z", "--index-info", data=staged, env=env)
            for options in (("--cached", source), ()):
                raw = self.git("diff", "--no-ext-diff", "--name-only", "-z", *options, "--", *selected, env=env)
                dirty.update(name.decode() for name in raw.split(b"\0") if name)
        for name in selected:
            if self.command(["git", "cat-file", "-e", source + ":" + name], check=False).returncode:
                dirty.add(name)
        return sorted(dirty)

    def receipt_path(self, path: str | Path) -> Path:
        value = Path(path)
        if not value.is_absolute():
            value = self.root / value
        value = value.resolve()
        require(value.is_relative_to((self.root / EVIDENCE).resolve()) and value.suffix == ".json", "receipt_must_be_under_ignored_evidence")
        relative = value.relative_to(self.root).as_posix()
        require(self.command(["git", "check-ignore", "--no-index", "--quiet", "--", relative], check=False).returncode == 0, "receipt_directory_must_be_ignored")
        return value

    def save_receipt(self, path: Path, receipt: dict) -> None:
        path = self.receipt_path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            temporary.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def prepare(self, output: str | Path | None = None) -> tuple[Path, dict]:
        source = self.head()
        manifest_working = self.working_file(MANIFEST)
        names = manifest_names(manifest_working)
        working = {name: self.working_file(name) for name in names}
        dirty = self.dirty_files(source, names)
        manifest = manifest_working if dirty else self.git("show", source + ":" + MANIFEST)
        require(manifest_names(manifest) == names, "allowlist_changed")
        files = working if dirty else self.source_files(source, names)
        files[".nojekyll"] = b""
        parent = self.remote_head(PAGES_REF)
        if parent:
            self.ensure_object(parent)
        with tempfile.TemporaryDirectory(prefix="workspace-assets-index-") as directory:
            env = {"GIT_INDEX_FILE": str(Path(directory) / "index")}
            self.git("read-tree", "--empty", env=env)
            hashes = {}
            for name, body in sorted(files.items()):
                blob = self.git("hash-object", "-w", "--stdin", data=body).decode().strip()
                self.git("update-index", "--add", "--cacheinfo", "100644," + blob + "," + name, env=env)
                hashes[name] = {"sha256": digest(body), "bytes": len(body), "gitBlob": blob}
            tree = self.git("write-tree", env=env).decode().strip()
            message = ("Workspace assets from " + source + (" (working preview, not publishable)" if dirty else "") + "\n").encode()
            commit = self.git("commit-tree", tree, *( ["-p", parent] if parent else []), data=message).decode().strip()
        require(self.head() == source and self.working_file(MANIFEST) == manifest_working, "source_changed_during_prepare")
        require(all(self.working_file(name) == working[name] for name in names), "asset_changed_during_prepare")
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = self.receipt_path(output or f"{EVIDENCE}/assets-prepared-{stamp}-{commit[:12]}-{uuid.uuid4().hex[:6]}.json")
        require(not path.exists(), "receipt_already_exists")
        receipt = {"schema": 1, "status": "ASSETS_PREPARED", "preparedAt": utc_now(), "repository": REPOSITORY,
                   "sourceHead": source, "manifestSha256": digest(manifest), "allowlist": names,
                   "sourceMode": "working_tree" if dirty else "committed_head", "publishable": not dirty, "dirtyAssets": dirty,
                   "parent": parent, "tree": tree, "commit": commit, "files": hashes, "assetCount": len(names)}
        self.save_receipt(path, receipt)
        return path, receipt

    def load_receipt(self, path: str | Path, current: bool = False) -> tuple[Path, dict]:
        path = self.receipt_path(path)
        require(path.is_file() and path.stat().st_size <= 1024 * 1024, "invalid_receipt")
        try:
            receipt = json.loads(path.read_text(encoding="utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise ReleaseError("invalid_receipt_json") from exc
        require(isinstance(receipt, dict), "invalid_receipt_schema")
        require(receipt.get("schema") == 1 and receipt.get("repository") == REPOSITORY, "wrong_receipt_scope")
        require(receipt.get("publishable") is True and receipt.get("sourceMode") == "committed_head" and not receipt.get("dirtyAssets"), "dirty_preview_cannot_be_published")
        for key in ("sourceHead", "tree", "commit"):
            require(isinstance(receipt.get(key), str) and bool(SHA.fullmatch(receipt[key])), "invalid_receipt_commit")
        require(receipt.get("parent") is None or isinstance(receipt["parent"], str) and bool(SHA.fullmatch(receipt["parent"])), "invalid_receipt_parent")
        source, commit = receipt["sourceHead"], receipt["commit"]
        manifest = self.git("show", source + ":" + MANIFEST)
        names = manifest_names(manifest)
        require(receipt.get("manifestSha256") == digest(manifest) and receipt.get("allowlist") == names and receipt.get("assetCount") == len(names), "receipt_allowlist_mismatch")
        files = self.source_files(source, names)
        files[".nojekyll"] = b""
        require(isinstance(receipt.get("files"), dict) and set(receipt["files"]) == set(files), "receipt_has_unexpected_assets")
        tree_entries = [entry for entry in self.git("ls-tree", "-rz", commit).split(b"\0") if entry]
        tree_modes = {entry.split(b"\t", 1)[1].decode(): entry.split(b" ", 1)[0] for entry in tree_entries}
        require(set(tree_modes) == set(files) and all(mode == b"100644" for mode in tree_modes.values()), "publish_tree_has_unexpected_assets")
        require(self.git("rev-parse", commit + "^{tree}").decode().strip() == receipt["tree"], "receipt_tree_mismatch")
        parents = self.git("rev-list", "--parents", "-n", "1", commit).decode().split()[1:]
        require(parents == ([receipt["parent"]] if receipt["parent"] else []), "receipt_parent_mismatch")
        for name, body in files.items():
            expected = receipt["files"][name]
            require(isinstance(expected, dict), "invalid_receipt_asset")
            require(expected.get("sha256") == digest(body) and expected.get("bytes") == len(body), "receipt_asset_hash_mismatch")
            require(self.git("show", commit + ":" + name) == body, "publish_blob_mismatch")
            blob = self.git("rev-parse", commit + ":" + name).decode().strip()
            require(expected.get("gitBlob") == blob, "receipt_blob_mismatch")
        if current:
            require(self.head() == source, "source_head_changed_prepare_again")
            require(not self.dirty_files(source, names), "assets_not_fully_committed_prepare_again")
            require(manifest_names(self.working_file(MANIFEST)) == names, "allowlist_changed_prepare_again")
            for name in names:
                self.working_file(name)
        return path, receipt

    def gh_api(self, endpoint: str, method: str = "GET", body: dict | None = None) -> dict:
        argv = ["gh", "api", "--hostname", "github.com", "--method", method, "-H", "Accept: application/vnd.github+json", endpoint]
        payload = None
        if body is not None:
            argv += ["--input", "-"]
            payload = json.dumps(body).encode()
        result = self.command(argv, payload)
        try:
            return json.loads(result.stdout) if result.stdout.strip() else {}
        except json.JSONDecodeError as exc:
            raise ReleaseError("invalid_github_response") from exc

    def pages(self) -> dict:
        pages = self.gh_api(f"repos/{REPOSITORY}/pages")
        require(pages.get("build_type", "legacy") == "legacy", "unexpected_pages_build_type")
        require(not pages.get("cname"), "existing_custom_domain_requires_separate_review")
        require(pages.get("html_url") == SITE_URL, "unexpected_pages_destination")
        source = pages.get("source", {})
        require(source.get("branch") in ("main", "gh-pages") and source.get("path") == "/", "unexpected_pages_source")
        return pages

    def push_commit(self, commit: str) -> None:
        self.git("push", "origin", commit + ":" + PAGES_REF)

    def publish(self, receipt_path: str | Path) -> dict:
        path, receipt = self.load_receipt(receipt_path, current=True)
        require(self.remote_head(SOURCE_REF) == receipt["sourceHead"], "push_source_head_to_origin_main_first")
        current = self.remote_head(PAGES_REF)
        require(current in (receipt["parent"], receipt["commit"]), "pages_branch_changed_prepare_again")
        before = self.pages()
        if current != receipt["commit"]:
            self.push_commit(receipt["commit"])
        require(self.remote_head(PAGES_REF) == receipt["commit"], "pages_push_not_confirmed")
        desired = {"branch": "gh-pages", "path": "/"}
        if before.get("source") != desired:
            self.gh_api(f"repos/{REPOSITORY}/pages", "PUT", {"source": desired})
        after = self.pages()
        require(after.get("source") == desired and after.get("cname") == before.get("cname") and after.get("html_url") == before.get("html_url"), "pages_source_update_not_confirmed")
        receipt["publication"] = {"status": "PAGES_SOURCE_UPDATED", "at": utc_now(), "commit": receipt["commit"], "source": desired, "url": SITE_URL}
        self.save_receipt(path, receipt)
        # A source switch can leave the latest build on the old branch. A push
        # and successful source PUT therefore do not establish a queued build.
        try:
            latest = self.gh_api(f"repos/{REPOSITORY}/pages/builds/latest")
        except ReleaseError:
            latest = {}
        active = latest.get("commit") == receipt["commit"] and latest.get("status") in ("queued", "building", "built")
        if active:
            build = {"requested": False, "status": latest["status"], "commit": receipt["commit"]}
        else:
            requested = self.gh_api(f"repos/{REPOSITORY}/pages/builds", "POST")
            require(requested.get("status") in ("queued", "building", "built"), "pages_build_request_not_confirmed")
            build = {"requested": True, "status": requested["status"], "at": utc_now(), "targetCommit": receipt["commit"]}
        receipt["publication"]["build"] = build
        self.save_receipt(path, receipt)
        return receipt

    def fetch_asset(self, name: str, expected: dict) -> bytes:
        url = SITE_URL + urllib.parse.quote(name, safe="/")
        request = urllib.request.Request(url, headers={"Accept-Encoding": "identity", "Cache-Control": "no-cache", "User-Agent": "VertuxWorkspaceAssetVerifier/1"})
        try:
            opener = urllib.request.build_opener(SameSiteRedirect())
            with opener.open(request, timeout=15) as response:
                require(response.status == 200 and response.url.startswith(SITE_URL), "https_asset_response_invalid")
                return response.read(expected["bytes"] + 1)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ReleaseError("https_asset_unavailable") from exc

    def verify(self, receipt_path: str | Path, timeout: float = 600, poll_interval: float = 5) -> dict:
        path, receipt = self.load_receipt(receipt_path)
        require(self.remote_head(PAGES_REF) == receipt["commit"], "published_branch_does_not_match_receipt")
        require(self.pages().get("source") == {"branch": "gh-pages", "path": "/"}, "pages_source_not_published")
        deadline, previous, checked = time.monotonic() + timeout, None, {}

        def check(name):
            expected = receipt["files"][name]
            try:
                actual = self.fetch_asset(name, expected)
                return name, {"sha256": digest(actual), "bytes": len(actual), "matches": digest(actual) == expected["sha256"] and len(actual) == expected["bytes"]}
            except ReleaseError:
                return name, {"matches": False, "error": "https_asset_unavailable"}

        while True:
            try:
                build = self.gh_api(f"repos/{REPOSITORY}/pages/builds/latest")
            except ReleaseError:
                build = {}
            exact = build.get("commit") == receipt["commit"]
            phase = "build_" + str(build.get("status", "pending")) if exact else "waiting_for_exact_build"
            if exact and build.get("status") in ("errored", "error", "failed"):
                receipt["verification"] = {"status": "PAGES_BUILD_FAILED", "at": utc_now(), "commit": receipt["commit"]}
                self.save_receipt(path, receipt)
                raise ReleaseError("pages_build_failed")
            if exact and build.get("status") == "built":
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    checked = dict(pool.map(check, receipt["allowlist"]))
                matches = sum(item["matches"] for item in checked.values())
                phase = f"https_assets:{matches}/{receipt['assetCount']}"
                if matches == receipt["assetCount"]:
                    require(self.remote_head(PAGES_REF) == receipt["commit"], "pages_branch_changed_during_verification")
                    require(self.pages().get("source") == {"branch": "gh-pages", "path": "/"}, "pages_source_changed_during_verification")
                    confirmed = self.gh_api(f"repos/{REPOSITORY}/pages/builds/latest")
                    require(confirmed.get("commit") == receipt["commit"] and confirmed.get("status") == "built", "pages_build_changed_during_verification")
                    receipt["verification"] = {"status": "PUBLISHED_ASSETS_VERIFIED", "at": utc_now(), "commit": receipt["commit"], "url": SITE_URL, "assets": checked, "nojekyllGitVerified": True}
                    self.save_receipt(path, receipt)
                    return receipt
            if phase != previous:
                print(json.dumps({"verification": phase}), flush=True)
                previous = phase
            if time.monotonic() >= deadline:
                receipt["verification"] = {"status": "VERIFICATION_INCOMPLETE", "at": utc_now(), "phase": phase, "assets": checked}
                self.save_receipt(path, receipt)
                raise ReleaseError("pages_or_https_verification_timeout")
            time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))


def self_test() -> None:
    """No network: real local Git objects, mocked push/Pages/HTTPS boundaries."""
    with tempfile.TemporaryDirectory(prefix="workspace-assets-selftest-") as directory:
        root = Path(directory)
        def git(*args, data=None):
            result = subprocess.run(["git", *args], cwd=root, input=data, capture_output=True, check=True)
            return result.stdout
        git("init", "--initial-branch=main")
        git("config", "user.name", "Isolated Asset Test")
        git("config", "user.email", "isolated@example.invalid")
        git("config", "core.autocrlf", "false")
        git("remote", "add", "origin", f"https://github.com/{REPOSITORY}.git")
        (root / "deploy").mkdir()
        (root / MANIFEST).write_text("index.html\napp.js\n", encoding="utf-8")
        (root / ".gitignore").write_text(EVIDENCE + "/\n", encoding="utf-8")
        (root / ".gitattributes").write_text("*.js text eol=crlf\n", encoding="utf-8")
        (root / "index.html").write_bytes(b"<!doctype html><title>Isolated fixture</title>\n")
        (root / "app.js").write_bytes(b"window.fixture = true;\n")
        (root / "README.md").write_text("Never ship source documentation.", encoding="utf-8")
        git("add", ".")
        git("commit", "-m", "Isolated fixture")

        class FakeRelease(AssetRelease):
            def __init__(self, path):
                super().__init__(path)
                self.refs = {SOURCE_REF: self.head(), PAGES_REF: None}
                self.page = {"build_type": "legacy", "source": {"branch": "main", "path": "/"}, "cname": None, "html_url": SITE_URL}
                self.pushes, self.puts, self.posts, self.fetches = [], [], [], []
                self.corrupt = False
                self.build_commit = self.head()
                self.build_status = "built"
                self.build_read_fails = False
            def remote_head(self, ref):
                return self.refs[ref]
            def push_commit(self, commit):
                self.pushes.append(commit)
                self.refs[PAGES_REF] = commit
            def gh_api(self, endpoint, method="GET", body=None):
                if endpoint.endswith("/builds/latest"):
                    assert method == "GET" and body is None
                    if self.build_read_fails:
                        self.build_read_fails = False
                        raise ReleaseError("command_failed:gh:api")
                    return {"commit": self.build_commit or self.refs[PAGES_REF], "status": self.build_status}
                if method == "POST":
                    assert endpoint == f"repos/{REPOSITORY}/pages/builds" and body is None
                    assert self.page["source"] == {"branch": "gh-pages", "path": "/"}
                    self.posts.append({"endpoint": endpoint, "method": method, "body": body})
                    self.build_commit, self.build_status = self.refs[PAGES_REF], "queued"
                    return {"url": f"https://api.github.com/repos/{REPOSITORY}/pages/builds/latest", "status": "queued"}
                if method == "PUT":
                    self.puts.append(body)
                    self.page["source"] = body["source"]
                return json.loads(json.dumps(self.page))
            def fetch_asset(self, name, expected):
                self.fetches.append(name)
                return b"wrong" if self.corrupt else self.git("show", self.refs[PAGES_REF] + ":" + name)

        release = FakeRelease(root)
        original_head, original_index = release.head(), (root / ".git/index").read_bytes()
        path, record = release.prepare()
        assert record["publishable"] and record["parent"] is None
        assert set(record["files"]) == {"index.html", "app.js", ".nojekyll"}
        assert release.head() == original_head and (root / ".git/index").read_bytes() == original_index
        original_app = (root / "app.js").read_bytes()
        (root / "app.js").write_bytes(original_app.replace(b"\n", b"\r\n"))
        _, canonical = release.prepare()
        assert canonical["publishable"] and canonical["files"]["app.js"]["sha256"] == digest(original_app)
        (root / "app.js").write_bytes(b"window.dirty = true;\n")
        dirty_path, dirty = release.prepare()
        assert not dirty["publishable"] and dirty["dirtyAssets"] == ["app.js"]
        assert (root / ".git/index").read_bytes() == original_index, "index changed during dirty prepare"
        def fails(call, code):
            try:
                call()
            except ReleaseError as exc:
                assert str(exc) == code, (str(exc), code)
            else:
                raise AssertionError("Expected refusal: " + code)
        fails(lambda: release.publish(dirty_path), "dirty_preview_cannot_be_published")
        fails(lambda: release.publish(path), "assets_not_fully_committed_prepare_again")
        assert not release.pushes and not release.puts and not release.posts
        assert (root / ".git/index").read_bytes() == original_index, "index changed during dirty validation"
        (root / "app.js").write_bytes(original_app)
        staged_blob = git("hash-object", "-w", "--stdin", data=b"window.staged = true;\n").decode().strip()
        git("update-index", "--cacheinfo", "100644," + staged_blob + ",app.js")
        staged_index = (root / ".git/index").read_bytes()
        _, staged_record = release.prepare()
        assert not staged_record["publishable"] and staged_record["dirtyAssets"] == ["app.js"]
        assert (root / ".git/index").read_bytes() == staged_index
        (root / ".git/index").write_bytes(original_index)
        tampered = json.loads(path.read_text())
        tampered["files"]["README.md"] = {"sha256": "0" * 64, "bytes": 1}
        release.save_receipt(path, tampered)
        fails(lambda: release.publish(path), "receipt_has_unexpected_assets")
        release.save_receipt(path, record)
        assert (root / ".git/index").read_bytes() == original_index, "index changed during receipt validation"
        release.refs[SOURCE_REF] = "0" * 40
        fails(lambda: release.publish(path), "push_source_head_to_origin_main_first")
        release.refs[SOURCE_REF] = original_head
        release.page["cname"] = "example.invalid"
        fails(lambda: release.publish(path), "existing_custom_domain_requires_separate_review")
        release.page["cname"] = None
        published = release.publish(path)
        assert published["publication"]["build"]["requested"] is True
        assert published["publication"]["build"]["targetCommit"] == record["commit"]
        assert release.posts == [{"endpoint": f"repos/{REPOSITORY}/pages/builds", "method": "POST", "body": None}]
        for status in ("queued", "building", "built"):
            release.build_status = status
            repeated = release.publish(path)
            assert repeated["publication"]["build"] == {"requested": False, "status": status, "commit": record["commit"]}
        assert len(release.posts) == 1
        assert (root / ".git/index").read_bytes() == original_index, "index changed during publish validation"
        assert len(release.pushes) == 1 and release.puts == [{"source": {"branch": "gh-pages", "path": "/"}}]
        release.build_commit = "f" * 40
        fails(lambda: release.verify(path, timeout=0), "pages_or_https_verification_timeout")
        assert not release.fetches
        release.build_commit = None
        release.build_status = "errored"
        fails(lambda: release.verify(path, timeout=0), "pages_build_failed")
        assert not release.fetches
        retried = release.publish(path)
        assert retried["publication"]["build"]["requested"] is True and len(release.posts) == 2
        release.build_read_fails = True
        missing = release.publish(path)
        assert missing["publication"]["build"]["requested"] is True and len(release.posts) == 3
        release.build_status = "built"
        verified = release.verify(path, timeout=0)
        assert verified["verification"]["status"] == "PUBLISHED_ASSETS_VERIFIED" and sorted(release.fetches) == ["app.js", "index.html"]
        release.corrupt = True
        fails(lambda: release.verify(path, timeout=0), "pages_or_https_verification_timeout")
        later_path, later = release.prepare()
        assert later["parent"] == record["commit"]
        release.refs[PAGES_REF] = original_head
        fails(lambda: release.publish(later_path), "pages_branch_changed_prepare_again")
        for unsafe in (b"../index.html", b"tests/fixture.js", b"lead-server/main.js", b"README.md", b"CNAME", b".env", b"index.html\nindex.html"):
            try:
                manifest_names(unsafe)
            except ReleaseError:
                pass
            else:
                raise AssertionError("Unsafe allowlist accepted")
        assert release.head() == original_head and (root / ".git/index").read_bytes() == original_index
        print(json.dumps({"status": "ISOLATED_SELF_TEST_PASSED", "networkRequests": 0, "realPushes": 0, "realPagesWrites": 0, "headAndIndexUnchanged": True}))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare", action="store_true", help="Prepare only (default).")
    mode.add_argument("--publish", action="store_true", help="Explicitly push the reviewed gh-pages commit, set Pages source, and request a build if needed.")
    mode.add_argument("--verify", action="store_true", help="Read-only Pages/HTTPS verification after publication.")
    mode.add_argument("--self-test", action="store_true", help="Run isolated tests; no network or real publication.")
    parser.add_argument("--receipt", help="Prepared receipt for publish/verify; optional new output path for prepare.")
    parser.add_argument("--timeout", type=int, default=600, help="Verification deadline in seconds (0-1800).")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    require(0 <= args.timeout <= 1800, "invalid_verification_timeout")
    release = AssetRelease(ROOT)
    if args.publish or args.verify:
        require(bool(args.receipt), "explicit_receipt_required")
        record = release.publish(args.receipt) if args.publish else release.verify(args.receipt, args.timeout)
        status = record["publication"]["status"] if args.publish else record["verification"]["status"]
        print(json.dumps({"status": status, "receipt": str(release.receipt_path(args.receipt)), "commit": record["commit"], "assetCount": record["assetCount"]}))
    else:
        path, record = release.prepare(args.receipt)
        print(json.dumps({"status": record["status"], "receipt": str(path), "sourceHead": record["sourceHead"], "commit": record["commit"], "assetCount": record["assetCount"], "publishable": record["publishable"], "dirtyAssets": record["dirtyAssets"]}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ReleaseError, OSError) as error:
        print(json.dumps({"status": "FAILED", "error": str(error) if isinstance(error, ReleaseError) else "local_file_operation_failed"}), file=sys.stderr)
        sys.exit(1)
