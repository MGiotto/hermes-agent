"""Dispatcher planning lane: scoped Kanban fan-out without URL egress."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path


def _names(selection):
    from model_tools import get_tool_definitions
    return {row["function"]["name"] for row in get_tool_definitions(
        selection, quiet_mode=True, skip_tool_search_assembly=True)}


def _call(name, args):
    from tools.registry import registry
    result = registry.dispatch(name, args)
    return result if isinstance(result, dict) else json.loads(result)


def _status(kb, conn, task_id):
    task = kb.get_task(conn, task_id)
    assert task is not None
    return task.status


def test_dispatcher_pins_planning_lane_and_schema_denies_url(monkeypatch, tmp_path):
    from hermes_cli import kanban_db as kb, kanban_db_dispatch as dispatch

    root = tmp_path / ".hermes"
    profile = root / "profiles" / "argos"
    profile.mkdir(parents=True)
    (root / "config.yaml").write_text("kanban:\n  orchestrator_profile: argos\n")
    (profile / "config.yaml").write_text(
        "platform_toolsets:\n  cli: [kanban, web, terminal, file, code_execution, browser, connections]\n"
        "agent:\n  disabled_toolsets: []\n")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setattr(dispatch, "_resolve_hermes_argv", lambda: ["hermes"])
    monkeypatch.setattr(dispatch, "_restart_safe_worker_argv", lambda task, cmd: cmd)
    monkeypatch.setattr(dispatch, "_open_worker_log", lambda task, board: open(tmp_path / "worker.log", "ab"))
    captured = []

    class Proc:
        pid = 4321

    def fake_popen(cmd, **kwargs):
        captured.append((cmd, kwargs["env"]))
        return Proc()

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    workspace = tmp_path / "work"
    workspace.mkdir()
    for assignee in ("argos", "hefesto"):
        task = kb.Task(id=f"t_{assignee}", title="plan", body=None, assignee=assignee,
                       status="running", priority=0, created_by="test", created_at=1,
                       started_at=None, completed_at=None, workspace_kind="scratch",
                       workspace_path=None, claim_lock="lock", claim_expires=None,
                       tenant=None, current_run_id=7)
        dispatch._default_spawn(task, str(workspace))

    cmd, argos_env = captured[0]
    assert cmd[cmd.index("--toolsets") + 1] == "kanban"
    assert argos_env["HERMES_KANBAN_PLANNING_WORKER"] == "1"
    assert "HERMES_KANBAN_PLANNING_WORKER" not in captured[1][1]
    # A broken root policy cannot silently restore outbound HTTP on a new spawn.
    (root / "config.yaml").write_text("kanban: [broken\n")
    dispatch._default_spawn(task, str(workspace))
    assert captured[-1][1]["HERMES_KANBAN_PLANNING_WORKER"] == "1"
    monkeypatch.setenv("HERMES_HOME", str(profile))
    monkeypatch.setenv("HERMES_PROFILE", "argos")
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_argos")
    monkeypatch.setenv("HERMES_KANBAN_PLANNING_WORKER", "1")
    names = _names(["kanban"])
    assert {"kanban_show", "kanban_create", "kanban_link", "kanban_comment"} <= names
    assert "kanban_attach_url" not in names
    assert "kanban_unblock" not in names
    assert not (names & {"terminal", "read_file", "browser_navigate", "web_search",
                         "web_extract", "execute_code", "manage_connections", "mcp_tool_call"})
    assert all(name.startswith("kanban_") for name in names)
    # A stale registration or a direct dispatch must fail before any network call.
    from tools import kanban_tools as kt
    monkeypatch.setattr(kt, "_download_url_with_cap", lambda *a: (_ for _ in ()).throw(
        AssertionError("network attempted")))
    denied = _call("kanban_attach_url", {
        "url": "https://example.invalid/test", "task_id": "t_argos"})
    assert "cannot fetch external URLs" in denied["error"]
    denied = _call("kanban_unblock", {"task_id": "t_argos"})
    assert "orchestrator-only" in denied["error"]
    monkeypatch.delenv("HERMES_KANBAN_PLANNING_WORKER")
    assert "kanban_attach_url" in _names(["kanban"]), "schema cache leaked planning mode"
    other_profile = root / "profiles" / "hefesto"
    other_profile.mkdir()
    (other_profile / "config.yaml").write_text("platform_toolsets:\n  cli: [kanban]\n")
    monkeypatch.setenv("HERMES_HOME", str(other_profile))
    monkeypatch.setenv("HERMES_PROFILE", "hefesto")
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_hefesto")
    assert "kanban_attach_url" in _names(["kanban"])
    monkeypatch.setenv("HERMES_HOME", str(profile))
    monkeypatch.setenv("HERMES_PROFILE", "argos")
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_argos")
    monkeypatch.setenv("HERMES_KANBAN_PLANNING_WORKER", "1")
    assert "kanban_attach_url" not in _names(["kanban"])


def test_planning_worker_decomposes_on_isolated_dispatcher_board(monkeypatch, tmp_path):
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
    from hermes_cli import kanban_db_dispatch as dispatch

    root = tmp_path / ".hermes"
    root.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(root))
    kb.init_db()
    monkeypatch.setattr(dispatch, "_profile_exists_fn", lambda: lambda assignee: True)
    db_path = kb.kanban_db_path()
    seen = []

    def fake_spawn(task, workspace, board=None):
        seen.append((task.id, task.assignee))
        return 4321

    with kbc.connect() as conn:
        sentinel = kb.create_task(conn, title="unrelated human gate", assignee="human")
        kb.block_task(conn, sentinel, reason="human decision")
        parent = kb.create_task(conn, title="decompose", assignee="argos")
        result = dispatch.dispatch_once(conn, spawn_fn=fake_spawn, max_spawn=1)
        assert [row[0] for row in result.spawned] == [parent]
        claimed = kb.get_task(conn, parent)
        assert claimed is not None
        run_id = claimed.current_run_id

    with monkeypatch.context() as worker:
        worker.setenv("HERMES_KANBAN_DB", str(db_path))
        worker.setenv("HERMES_KANBAN_TASK", parent)
        worker.setenv("HERMES_KANBAN_RUN_ID", str(run_id))
        worker.setenv("HERMES_PROFILE", "argos")
        worker.setenv("HERMES_KANBAN_PLANNING_WORKER", "1")

        def call(name, **args):
            value = _call(name, args)
            assert value.get("ok"), value
            return value

        context = _call("kanban_show", {})
        assert context["task"]["id"] == parent
        implementation = call("kanban_create", title="implement", assignee="hefesto",
                              parents=[parent], idempotency_key=f"{parent}:implement")["task_id"]
        assert implementation == call("kanban_create", title="implement", assignee="hefesto",
                                      parents=[parent], idempotency_key=f"{parent}:implement")["task_id"]
        review = call("kanban_create", title="review", assignee="atena",
                      idempotency_key=f"{parent}:review")["task_id"]
        call("kanban_link", parent_id=implementation, child_id=review)
        call("kanban_comment", task_id=implementation, body="Implementation handoff")
        call("kanban_complete", summary="Decomposition completed", created_cards=[implementation, review])

    with kbc.connect() as conn:
        assert _status(kb, conn, implementation) == "ready"
        assert _status(kb, conn, review) == "todo"
        assert _status(kb, conn, sentinel) == "blocked"
        assert [row[0] for row in dispatch.dispatch_once(
            conn, spawn_fn=fake_spawn, max_spawn=1).spawned] == [implementation]
        kb.complete_task(conn, implementation, summary="done")
        assert _status(kb, conn, review) == "ready"
        assert [row[0] for row in dispatch.dispatch_once(
            conn, spawn_fn=fake_spawn, max_spawn=1).spawned] == [review]
        assert seen == [(parent, "argos"), (implementation, "hefesto"), (review, "atena")]
        assert _status(kb, conn, sentinel) == "blocked"
        assert {row[0] for row in conn.execute("SELECT id FROM tasks")} == {
            sentinel, parent, implementation, review}
