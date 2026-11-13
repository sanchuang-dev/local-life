#!/usr/bin/env python3
"""Versioned Baota production cutover: prepare, rehearse, quiesce, activate, verify.

Runs as root from an authenticated GitHub Actions SSH session, but operates only
inside the approved local-life directories. Other Baota websites and services
are not touched. A schema-changing failed cutover is stopped for manual recovery
rather than rolling back a live SQLite database over potentially newer writes.
"""
import fcntl
import hashlib
import json
import os
import pwd
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE = Path("/www/local-life")
WEBROOT = Path("/www/wwwroot")
NODE = "/www/server/nodejs/v24.22.1/bin/node"
BTPY = "/www/server/panel/pyenv/bin/python3"
DB = BASE / "shared/data/local-life.sqlite"
CURRENT = BASE / "current"
DOMAINS = {"web": "local-life.3cgroup.cn", "admin": "local-admin.3cgroup.cn"}
SHA_PATTERN = re.compile(r"^[a-f0-9]{40}$")


class ReleaseError(RuntimeError):
    pass


def log(message):
    print(message, flush=True)


def invoke(argv, *, cwd=None, as_www=False, env=None, quiet=False):
    command = ["runuser", "-u", "www", "--", *argv] if as_www else argv
    result = subprocess.run(
        command, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, check=False,
    )
    if result.returncode:
        raise ReleaseError(f"Command failed: {argv[0]} (exit {result.returncode}): "
                           + result.stdout[-900:])
    if not quiet and result.stdout.strip():
        log(result.stdout.strip())
    return result.stdout


def node_at(api, *args, as_www=True, env=None, quiet=False):
    return invoke([NODE, *args], cwd=api, as_www=as_www, env=env, quiet=quiet)


def sqlite_sidecars(path):
    return [path, Path(str(path) + "-wal"), Path(str(path) + "-shm")]


def cleanup_snapshot(path):
    for item in sqlite_sidecars(path):
        if item.exists():
            item.unlink()


def read_journal(api):
    f = api / "db/migrations/meta/_journal.json"
    data = json.loads(f.read_text())
    entries = data["entries"]
    if not entries or len(set(x["tag"] for x in entries)) != len(entries):
        raise ReleaseError("Malformed migration journal")
    return entries


def compare_migrations(old_api, new_api):
    old = read_journal(old_api)
    new = read_journal(new_api)
    if len(new) < len(old):
        raise ReleaseError("Migration downgrade is not supported")
    for i, item in enumerate(old):
        if new[i]["tag"] != item["tag"]:
            raise ReleaseError("Migration history was rewritten")
        name = item["tag"] + ".sql"
        a = old_api / "db/migrations" / name
        b = new_api / "db/migrations" / name
        if not a.is_file() or not b.is_file() or hashlib.sha256(a.read_bytes()).digest() != hashlib.sha256(b.read_bytes()).digest():
            raise ReleaseError("Existing migration SQL changed: " + name)
    return len(new) > len(old)


def check_sha_and_archives(sha):
    incoming = BASE / "incoming" / sha
    if not incoming.is_dir() or incoming.is_symlink():
        raise ReleaseError("Missing immutable incoming release")
    if (incoming / "SOURCE_SHA").read_text().strip() != sha:
        raise ReleaseError("Incoming SHA mismatch")
    invoke(["sha256sum", "-c", "SHA256SUMS"], cwd=incoming, quiet=True)
    for name in ("web.tar.gz", "admin.tar.gz", "api.tar.gz", "deploy.py",
                 "migrate-db.mjs", "register-bt-node.py", "pm2-control.py"):
        if not (incoming / name).is_file():
            raise ReleaseError("Incomplete release: " + name)
    return incoming


def prepare_release(sha, incoming):
    release = BASE / "releases" / sha
    if release.exists():
        if (release / ".bt-release-sha").read_text().strip() != sha:
            raise ReleaseError("Existing release marker mismatch")
        return release
    staging = BASE / "releases" / (".unpack-" + sha)
    if staging.exists():
        raise ReleaseError("Leftover extraction directory requires inspection")
    staging.mkdir(mode=0o755)
    try:
        for name in ("web", "admin", "api"):
            target = staging / name
            target.mkdir()
            invoke(["tar", "-xzf", str(incoming / (name + ".tar.gz")),
                    "--no-same-owner", "--no-same-permissions", "-C", str(target)],
                   quiet=True)
        if not all((staging / x).is_file() for x in (
            "web/index.html", "admin/index.html", "api/dist/index.js",
            "api/verify-db.mjs",
        )):
            raise ReleaseError("Missing built application files")
        if not (staging / "api/db/migrations/meta/_journal.json").is_file():
            raise ReleaseError("Missing Drizzle migration metadata")
        shutil.copyfile(incoming / "migrate-db.mjs", staging / "api/migrate-db.mjs")
        os.symlink(str(BASE / "shared/config/api.env"), staging / "api/.env")
        (staging / ".bt-release-sha").write_text(sha + "\n")
        invoke(["chown", "-R", "www:www", str(staging)], quiet=True)
        invoke(["chmod", "-R", "u=rwX,g=rX,o=", str(staging)], quiet=True)
        staging.rename(release)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    return release


def check_native(api):
    node_at(api, "-e", 'const D=require("./node_modules/better-sqlite3"); const d=new D(":memory:"); d.close();',
            quiet=True)


def snapshot(api, out):
    if out.exists():
        raise ReleaseError("Refusing to overwrite an existing SQLite snapshot")
    node_at(api, "verify-db.mjs", "backup", str(DB), str(out), quiet=True)
    if not out.is_file() or not out.stat().st_size:
        raise ReleaseError("Missing SQLite online backup")


def migrate(api, path):
    env = os.environ.copy()
    env["DATABASE_PATH"] = str(path)
    node_at(api, "migrate-db.mjs", str(path), env=env, quiet=True)
    node_at(api, "verify-db.mjs", "verify", str(path), quiet=True)


def trial_api(api, db_copy, sha):
    # The dry-run API uses the production configuration and a private localhost
    # test port, never exposing test sessions to the public network.
    port = 18082
    env = os.environ.copy()
    env.update(DATABASE_PATH=str(db_copy), PORT=str(port), HOST="127.0.0.1")
    command = ["runuser", "-u", "www", "--", "env",
               f"DATABASE_PATH={db_copy}", f"PORT={port}", "HOST=127.0.0.1",
               NODE, "dist/index.js"]
    with open(os.devnull, "wb") as null:
        proc = subprocess.Popen(command, cwd=api, start_new_session=True,
                                stdout=null, stderr=null, env=env)
        try:
            for _ in range(45):
                if proc.poll() is not None:
                    raise ReleaseError("New API failed to start against migrated snapshot")
                try:
                    health("http://127.0.0.1:18082/healthz", attempts=1)
                    log("BT_MIGRATION_API_TRIAL=PASS")
                    return
                except Exception:
                    time.sleep(0.2)
            raise ReleaseError("New API trial timed out")
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=5)


def health(url, attempts=25):
    for i in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=4) as response:
                value = json.load(response)
                if response.status == 200 and value.get("status") == "ok" and value.get("service") == "local-life-api":
                    return
        except Exception:
            pass
        if i + 1 < attempts:
            time.sleep(.4)
    raise ReleaseError("Unhealthy API: " + url)


def pm2_action(incoming, action):
    if action not in ("check", "stop", "start", "save"):
        raise ReleaseError("Unsupported dedicated PM2 action")
    invoke([sys.executable, str(incoming / "pm2-control.py"), action], quiet=True)


def site_paths():
    for area, domain in DOMAINS.items():
        target = WEBROOT / domain
        if not target.is_dir() or target.is_symlink():
            raise ReleaseError("Baota website root is missing or replaced: " + domain)
        yield area, domain, target


def save_static(backup):
    for area, _, target in site_paths():
        shutil.copytree(target, backup / ("site-" + area), symlinks=True)
        if not (backup / ("site-" + area) / "index.html").is_file():
            raise ReleaseError("Missing existing site index.html")


def atomic_copy(source, dest, sha):
    if source.is_symlink() or not source.is_file():
        raise ReleaseError("Invalid public asset")
    # Never follow a panel/site symlink into a directory outside the vhost.
    for ancestor in dest.parents:
        if ancestor.is_symlink():
            raise ReleaseError("Symlinked static target parent is forbidden")
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_name("." + dest.name + ".bt-" + sha[:12] + ".tmp")
    if temp.exists():
        raise ReleaseError("Stale atomic static file: " + str(temp))
    try:
        shutil.copy2(source, temp)
        # Release assets are 0640 www:www. A root-owned 0640 file would 403
        # under the Nginx www worker, even when its contents are correct.
        if os.geteuid() == 0:
            account = pwd.getpwnam("www")
            os.chown(temp, account.pw_uid, account.pw_gid)
        os.replace(temp, dest)
    finally:
        if temp.exists():
            temp.unlink()


def write_static(source, target, sha):
    # Non-index assets go first, then an atomic index.html swap. Old hashed
    # assets are preserved for in-flight browsers (never delete on deploy).
    files = sorted(x for x in source.rglob("*") if x.is_file())
    if (source / "index.html") not in files:
        raise ReleaseError("Missing index.html")
    for f in files:
        if f == source / "index.html":
            continue
        relative = f.relative_to(source)
        if f.is_symlink() or any(x.startswith(".") for x in relative.parts):
            raise ReleaseError("Unexpected public asset path")
        atomic_copy(f, target / relative, sha)
    atomic_copy(source / "index.html", target / "index.html", sha)


def restore_static(backup, sha):
    for area, _, target in site_paths():
        old = backup / ("site-" + area)
        if not old.is_dir():
            raise ReleaseError("Static rollback snapshot is absent")
        items = sorted(x for x in old.rglob('*') if x.is_file())
        for item in items:
            if item != old / 'index.html':
                atomic_copy(item, target / item.relative_to(old), sha)
        atomic_copy(old / 'index.html', target / 'index.html', sha)


def switch_release(release, sha):
    temp = BASE / (".next-" + sha)
    if temp.exists() or temp.is_symlink():
        raise ReleaseError("Stale release link")
    os.symlink(str(release), temp)
    try:
        os.replace(temp, CURRENT)
    finally:
        if temp.is_symlink():
            temp.unlink()


def validate_public(release, sha):
    for area, domain, _ in site_paths():
        index = (release / area / "index.html").read_bytes()
        url = "https://" + domain + "/"
        result = None
        for _ in range(5):
            with urllib.request.urlopen(url, timeout=8) as response:
                result = response.read()
            if result == index:
                break
            time.sleep(.4)
        if result != index:
            raise ReleaseError("Public frontend version mismatch: " + domain)
        health("https://" + domain + "/api/healthz")
        log("BT_PUBLIC_SITE_VERIFIED=" + domain)
    log("BT_PUBLIC_BOTH_SITES_VERIFIED=yes")


def harden_backup(file_path):
    os.chmod(file_path, 0o600)
    if file_path.stat().st_uid != 0:
        raise ReleaseError("Root ownership required for recovery backup")


def deploy(sha, preflight_only=False):
    if os.geteuid() != 0 or not SHA_PATTERN.fullmatch(sha):
        raise ReleaseError("Root and a full immutable source SHA are required")
    if not CURRENT.is_symlink():
        raise ReleaseError("Existing production is not initialized")
    old_release = CURRENT.resolve(strict=True)
    if old_release.parent != BASE / "releases" or not SHA_PATTERN.fullmatch(old_release.name):
        raise ReleaseError("Unexpected current release target")
    if old_release.name == sha and not preflight_only:
        pm2_action(BASE / "incoming" / sha, "check")
        health("http://127.0.0.1:18081/healthz")
        validate_public(old_release, sha)
        log("BT_PRODUCTION_ALREADY_ACTIVE_SHA=" + sha)
        return

    incoming = check_sha_and_archives(sha)
    release = prepare_release(sha, incoming)
    new_api = release / "api"
    old_api = old_release / "api"
    check_native(new_api)
    schema_upgrade = compare_migrations(old_api, new_api)
    log("BT_SCHEMA_UPGRADE_PLANNED=" + ("yes" if schema_upgrade else "no"))

    # Preflight happens with the old application still online. No writes to DB.
    scratch = BASE / "shared/data" / (".preflight-" + sha + ".sqlite")
    if any(x.exists() for x in sqlite_sidecars(scratch)):
        raise ReleaseError("Leftover preflight SQLite snapshot")
    try:
        snapshot(old_api, scratch)
        migrate(new_api, scratch)
        trial_api(new_api, scratch, sha)
    finally:
        cleanup_snapshot(scratch)
    log("BT_PRODUCTION_PREFLIGHT=PASS")
    if preflight_only:
        return
    # A one-time handoff must have disabled Baota Node auto-start first.
    pm2_action(incoming, "check")

    # No other writes are performed by this program before the old API is stopped.
    marker = BASE / "ops" / "manual-recovery-required"
    if marker.exists():
        raise ReleaseError("Unresolved prior production deployment requires manual review")
    backup = BASE / "backups" / ("release-" + sha)
    if backup.exists():
        raise ReleaseError("Existing release backup; inspect before retry")
    backup.mkdir(mode=0o700)
    os.chmod(backup, 0o700)
    try:
        save_static(backup)
    except Exception:
        # A failed static snapshot has not stopped the API or touched the DB.
        shutil.rmtree(backup)
        raise

    stopped = False
    migration_touched = False
    switched = False
    stopped_snapshot = BASE / "shared/data" / (".stopped-" + sha + ".sqlite")
    test_snapshot = BASE / "shared/data" / (".rehearsal-" + sha + ".sqlite")
    if any(x.exists() for x in sqlite_sidecars(stopped_snapshot) + sqlite_sidecars(test_snapshot)):
        raise ReleaseError("Residual stopped SQLite snapshots")
    try:
        stopped = True
        pm2_action(incoming, "stop")
        # With API stopped, no application writes can occur between snapshot
        # and rehearsal. Keep this immutable recovery point root-only.
        snapshot(old_api, stopped_snapshot)
        recovery = backup / "database.sqlite"
        node_at(old_api, "verify-db.mjs", "backup", str(stopped_snapshot), str(recovery),
                as_www=False, quiet=True)
        harden_backup(recovery)
        snapshot(old_api, test_snapshot)
        migrate(new_api, test_snapshot)
        log("BT_STOPPED_DB_MIGRATION_REHEARSAL=PASS")
        if schema_upgrade:
            marker.write_text("Schema-changing cutover interrupted: " + sha + "\n")
            os.chmod(marker, 0o600)
        migration_touched = True
        migrate(new_api, DB)
        switch_release(release, sha)
        switched = True
        pm2_action(incoming, "start")
        health("http://127.0.0.1:18081/healthz")
        for area, _, target in site_paths():
            write_static(release / area, target, sha)
        validate_public(release, sha)
        node_at(new_api, "verify-db.mjs", "verify", str(DB), quiet=True)
        pm2_action(incoming, "save")
        log("BT_PRODUCTION_ACTIVE_SHA=" + sha)
        log("BT_PRODUCTION_MIGRATION_BACKUP=" + str(recovery))
        if marker.exists():
            marker.unlink()
    except Exception:
        if schema_upgrade and migration_touched:
            log("BT_RECOVERY_REQUIRED_SCHEMA_MIGRATION=yes")
            if not marker.exists():
                marker.write_text("Interrupted schema-changing cutover: " + sha + "\n")
                os.chmod(marker, 0o600)
            try:
                pm2_action(incoming, "stop")
            except Exception:
                log("BT_RECOVERY_STOP_FAILED=manual_action_required")
            # The pre-cutover snapshot is retained. Never auto-replace the
            # database after a schema-changing API might have accepted writes.
        elif stopped:
            log("BT_AUTOMATIC_APPLICATION_ROLLBACK=starting")
            try:
                if switched:
                    pm2_action(incoming, "stop")
                switch_release(old_release, sha)
                restore_static(backup, sha)
                pm2_action(incoming, "start")
                health("http://127.0.0.1:18081/healthz")
                pm2_action(incoming, "save")
                log("BT_AUTOMATIC_APPLICATION_ROLLBACK=success")
            except Exception:
                marker.write_text("Automatic rollback failed: " + sha + "\n")
                os.chmod(marker, 0o600)
                log("BT_AUTOMATIC_APPLICATION_ROLLBACK=failed_manual_recovery_required")
        raise
    finally:
        cleanup_snapshot(stopped_snapshot)
        cleanup_snapshot(test_snapshot)


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ("--apply", "--preflight"):
        raise SystemExit("Usage: deploy.py <40-hex-sha> --apply|--preflight")
    BASE.joinpath("ops").mkdir(mode=0o750, exist_ok=True)
    lock_path = BASE / "ops/deploy.lock"
    with open(lock_path, "a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ReleaseError("Another Baota deployment is already running") from exc
        deploy(sys.argv[1], preflight_only=(sys.argv[2] == "--preflight"))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("BT_PRODUCTION_DEPLOY_FAILED=" + str(error), file=sys.stderr, flush=True)
        sys.exit(1)
