#!/usr/bin/env python3
"""Single-owner PM2 controller for Baota's production local_life_api.

Always uses the www account and a private PM2_HOME, never root's existing PM2.
Deployment intentionally stops, replaces, then saves the app only after health.
"""
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys

NAME = "local_life_api"
BASE = Path("/www/local-life")
API = BASE / "current/api"
SCRIPT = API / "dist/index.js"
NODE_BIN = "/www/server/nodejs/v24.22.1/bin"
PM2 = NODE_BIN + "/pm2"
HOME = "/home/www"
PM2_HOME = HOME + "/.pm2"


def fail(message):
    raise RuntimeError(message)


def call(*args):
    env = [
        "HOME=" + HOME,
        "PM2_HOME=" + PM2_HOME,
        "PATH=" + NODE_BIN + ":/usr/local/bin:/usr/bin:/bin",
    ]
    cmd = ["runuser", "-u", "www", "--", "env", *env, PM2, *args]
    result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=65, check=False)
    if result.returncode:
        # Never print raw PM2 env/data or secrets from process metadata.
        fail("PM2 " + args[0] + " failed (exit " + str(result.returncode) + ")")
    return result.stdout


def managed():
    apps = json.loads(call("jlist"))
    target = [app for app in apps if app.get("name") == NAME]
    if len(target) > 1:
        fail("More than one local_life_api managed by www PM2")
    others = [app.get("name") for app in apps if app.get("name") != NAME]
    if others:
        fail("www PM2 is not dedicated to local-life: " + repr(others))
    return target[0] if target else None


def verify_current(app, *, online):
    if not app:
        fail("PM2 app is missing")
    info = app["pm2_env"]
    if online and info.get("status") != "online":
        fail("PM2 app not online: " + str(info.get("status")))
    if info.get("exec_mode") not in ("fork_mode", None):
        fail("PM2 must use single-process fork mode")
    if os.path.realpath(info.get("pm_exec_path", "")) != os.path.realpath(SCRIPT):
        fail("PM2 script does not match active release")
    if os.path.realpath(info.get("pm_cwd", "")) != os.path.realpath(API):
        fail("PM2 working directory does not match active release")
    if online and int(app.get("pid") or 0) <= 0:
        fail("Missing live PM2 PID")
    return info


def start():
    if not SCRIPT.is_file() or not (API / ".env").is_file():
        fail("Current production API or persistent config is missing")
    if not (BASE / "ops/baota-node-before-pm2.json").is_file():
        fail("Baota Node handoff has not been verified")
    existing = managed()
    if existing:
        call("delete", NAME)  # removes stale resolved path before new release start
    call("start", str(SCRIPT),
         "--name", NAME,
         "--cwd", str(API),
         "--interpreter", NODE_BIN + "/node",
         "--instances", "1",
         "--exec-mode", "fork",
         "--restart-delay", "3000",
         "--min-uptime", "10000",
         "--max-restarts", "10",
         "--max-memory-restart", "350M",
         "--kill-timeout", "8000",
         "--no-vizion")
    verify_current(managed(), online=True)
    print("BT_PM2_STARTED_CURRENT_RELEASE=yes")


def stop():
    app = managed()
    if not app:
        fail("PM2 app absent; refusing to assume service was stopped")
    if app["pm2_env"].get("status") != "stopped":
        call("stop", NAME)
    app = managed()
    if not app or app["pm2_env"].get("status") != "stopped":
        fail("PM2 stop did not complete")
    print("BT_PM2_STOPPED_FOR_DEPLOY=yes")


def save():
    verify_current(managed(), online=True)
    call("save")
    stored = json.loads(Path(PM2_HOME, "dump.pm2").read_text())
    if len(stored) != 1 or stored[0].get("name") != NAME:
        fail("Saved PM2 process list differs from current single-owner API")
    if os.path.realpath(stored[0].get("pm_exec_path", "")) != os.path.realpath(SCRIPT):
        fail("Saved PM2 process points to wrong release")
    print("BT_PM2_SAVED_FOR_BOOT=yes")


def check():
    app = managed()
    verify_current(app, online=True)
    print("BT_PM2_HEALTHY=yes")
    print("BT_PM2_PID=" + str(app["pid"]))


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("start", "stop", "save", "check"):
        raise SystemExit("Usage: pm2-control.py start|stop|save|check")
    if os.geteuid() != 0:
        fail("PM2 management must be invoked by authorized root deployment")
    www = pwd.getpwnam("www")
    if www.pw_dir != HOME or www.pw_uid <= 0:
        fail("Unexpected Baota www identity")
    if not (Path(NODE_BIN, "node").is_file() and Path(PM2).is_file()):
        fail("Missing pinned Baota Node/PM2 binaries")
    if Path(PM2_HOME).is_symlink():
        fail("PM2_HOME may not be a symlink")
    action = {"start": start, "stop": stop, "save": save, "check": check}
    action[sys.argv[1]]()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("BT_PM2_CONTROL_FAILED=" + str(exc), file=sys.stderr, flush=True)
        sys.exit(1)
