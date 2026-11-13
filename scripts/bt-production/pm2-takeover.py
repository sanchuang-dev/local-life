#!/usr/bin/env python3
"""One-time reversible handoff of Baota Node startup authority to www PM2."""
import json
import os
from pathlib import Path
import socket
import sys

PANEL = "/www/server/panel"
sys.path[:0] = [PANEL, PANEL + "/class"]
import public
from projectModel.nodejsModel import main

NAME = "local_life_api"
RECORD = Path("/www/local-life/ops/baota-node-before-pm2.json")
INERT_COMMAND = "/usr/bin/false"
PM2_LABEL = "本地生活 API（由 www PM2 / pm2-www.service 守护；宝塔 Node 启停已禁用）"


def port_free():
    with socket.socket() as sock:
        return sock.connect_ex(("127.0.0.1", 18081)) != 0


def run(mode):
    if os.geteuid() != 0:
        raise RuntimeError("Root required")
    model = main()
    item = model.get_project_find(NAME)
    if not item or item["path"] != "/www/local-life/current/api":
        raise RuntimeError("Unexpected Baota Node registration")
    original = item["project_config"]
    if original.get("run_user") != "www" or original.get("port") != 18081:
        raise RuntimeError("Unexpected Baota API identity or port")
    if mode == "check":
        print("BT_NODE_PANEL_AUTO_START=" + str(original.get("is_power_on")))
        print("BT_NODE_PANEL_DISABLED=" + str(
            original.get("project_script") == INERT_COMMAND))
        return
    if mode == "handoff":
        if RECORD.exists():
            if (original.get("project_script") == INERT_COMMAND and
                    original.get("is_power_on") == 0):
                print("BT_NODE_ALREADY_HANDED_OFF=yes")
                return
            raise RuntimeError("Previous handoff record exists but panel state differs")
        if not port_free():
            req = public.dict_obj()
            req.project_name = NAME
            result = model.stop_project(req)
            if not isinstance(result, dict) or not result.get("status"):
                raise RuntimeError("Failed to stop original Baota API")
        if not port_free():
            raise RuntimeError("API port still occupied; refusing duplicate owner")
        RECORD.parent.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(RECORD, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump({"script": original["project_script"],
                       "is_power_on": original["is_power_on"],
                       "ps": item["ps"]}, handle, ensure_ascii=False)
        script, power, label = INERT_COMMAND, 0, PM2_LABEL
    elif mode == "restore":
        if not RECORD.exists() or not port_free():
            raise RuntimeError("Cannot restore Baota while PM2 owns API port")
        saved = json.loads(RECORD.read_text())
        script, power, label = saved["script"], saved["is_power_on"], saved["ps"]
    else:
        raise RuntimeError("Usage: pm2-takeover.py check|handoff|restore")

    req = public.dict_obj()
    req.project_name = NAME
    req.project_cwd = item["path"]
    req.project_script = script
    req.project_ps = label
    req.is_power_on = power
    result = model.modify_project(req)
    if not isinstance(result, dict) or not result.get("status"):
        raise RuntimeError("Baota project update failed")
    updated = model.get_project_find(NAME)["project_config"]
    if updated["project_script"] != script or updated["is_power_on"] != power:
        raise RuntimeError("Baota configuration verification failed")
    if mode == "restore":
        RECORD.unlink()
    print("BT_NODE_PM2_" + mode.upper() + "=success")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise RuntimeError("Missing mode")
        run(sys.argv[1])
    except Exception as exc:
        print("BT_PM2_HANDOFF_FAILED=" + str(exc), file=sys.stderr)
        sys.exit(1)
