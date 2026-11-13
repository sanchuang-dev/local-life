#!/usr/bin/env python3
"""Register the prepared API as a REAL BT Node project, without npm install.

BT's stock create_project() unconditionally re-installs dependencies. The API
runtime was compiled and native-SQLite-tested in GitHub Actions; replacing it on
this shared 3.5 GiB server would invalidate the inspected artifact. We use BT's
own sites registry and then its own start_project() controller.
"""
import json
import os
import sys

PANEL = "/www/server/panel"
sys.path.insert(0, PANEL)
sys.path.insert(0, PANEL + "/class")
import public
from projectModel.nodejsModel import main

NAME = "local_life_api"
ROOT = "/www/local-life/current/api"
NODE = "/www/server/nodejs/v24.22.1/bin/node"
PORT = 18081


def main_cli() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in ("check", "register", "restart"):
        raise SystemExit("Usage: register-bt-node.py check|register|restart")
    mode = sys.argv[1]
    model = main()
    existing = model.get_project_find(NAME)

    if mode == "check":
        print("BT_NODE_PROJECT_REGISTERED=" + ("yes" if existing else "no"))
        if existing:
            print("BT_NODE_PROJECT_ROOT=" + existing["path"])
        return

    if os.geteuid() != 0:
        raise SystemExit("Requires root (BT panel controller)")
    if not os.path.isfile(ROOT + "/dist/index.js"):
        raise SystemExit("Versioned API runtime not prepared")
    if not os.path.isdir(ROOT + "/node_modules/better-sqlite3"):
        raise SystemExit("Native SQLite module not packaged")
    if not os.path.isfile(ROOT + "/.env"):
        raise SystemExit("Persistent API environment is missing")
    if not os.path.isfile(NODE):
        raise SystemExit("Server-managed Node runtime not installed")

    if not existing:
        if mode != "register":
            raise SystemExit("First register through register mode")
        if public.M("sites").where("name=?", NAME).count():
            raise SystemExit("Conflicting BT site/project name")
        record = {
            "name": NAME,
            "path": ROOT,
            "ps": "本地生活 API · 单实例 · SQLite 持久化",
            "status": 1,
            "type_id": 0,
            "edate": "0000-00-00",
            "project_type": "Node",
            "project_config": json.dumps({
                "project_name": NAME,
                "project_cwd": ROOT,
                "project_script": "node dist/index.js",
                "bind_extranet": 0,
                "domains": [],
                "is_power_on": 1,
                "run_user": "www",
                "max_memory_limit": 384,
                "nodejs_version": "v24.22.1",
                "port": PORT,
                "log_path": "/www/wwwlogs/nodejs",
                "pkg_manager": "npm",
            }, ensure_ascii=False),
            "addtime": public.getDate(),
        }
        inserted = public.M("sites").insert(record)
        if not inserted:
            raise SystemExit("BT Node project registration failed")
        existing = model.get_project_find(NAME)

    settings = existing["project_config"]
    if existing["path"] != ROOT or settings.get("port") != PORT or settings.get("run_user") != "www":
        raise SystemExit("Existing BT Node project does not match approved layout")

    req = public.dict_obj()
    req.project_name = NAME
    if mode == "restart":
        result = model.restart_project(req)
    else:
        result = model.start_project(req)
    if not isinstance(result, dict) or not result.get("status", False):
        raise SystemExit("BT Node project failed to start: " + str(result)[:300])
    print("BT_NODE_PROJECT_START_SUCCESS=yes")
    print("BT_NODE_PROJECT_NAME=" + NAME)


if __name__ == "__main__":
    main_cli()
