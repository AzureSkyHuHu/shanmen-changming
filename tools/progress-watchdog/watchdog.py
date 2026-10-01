#!/usr/bin/env python3
"""Local, stdlib-only progress journal and observer. See docs/progress-watchdog.md."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import uuid

SCHEMA_VERSION = 1
DEFAULT_STATE = Path(__file__).resolve().parent / "state"
INTERVAL_SECONDS = 60
STALL_SECONDS = 20 * 60
DEFAULT_DEADLINES = {"upload": 600, "test": 900, "build": 900, "development": 7200, "other": 1200}
TERMINAL = {"succeeded", "failed", "cancelled", "timed_out"}
STATUSES = {"running", "blocked", "uncertain"} | TERMINAL
EVIDENCE_KINDS = {"artifact_verified", "tests_completed", "remote_verified", "milestone"}
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class JournalError(ValueError):
    pass


def timestamp(value: float) -> str:
    try:
        return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError) as error:
        raise JournalError("Timestamp is outside the supported date range") from error


def positive(value: str | float) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError("Duration must be a finite, positive number")
    return number


def identifier(value: str) -> str:
    if not ID_PATTERN.fullmatch(value):
        raise JournalError("IDs must use 1–128 letters, digits, dots, colons, underscores or hyphens")
    return value


def text_field(value: str, name: str) -> str:
    if not value.strip() or len(value) > 2000 or "\x00" in value:
        raise JournalError(f"{name} must contain 1–2000 non-NUL characters")
    return value


def remote_identifiers(values: list[str]) -> dict[str, str]:
    result = {}
    for item in values:
        key, separator, value = item.partition("=")
        if not separator or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", key):
            raise JournalError("Remote identifiers must be name=value")
        if any(word in key for word in ("token", "password", "secret", "credential")):
            raise JournalError("Never store credentials in remote identifiers")
        if not value or len(value) > 512 or any(char.isspace() for char in value):
            raise JournalError("Remote identifier values must be short, nonempty and contain no whitespace")
        if "://" in value and ("@" in value or "?" in value or "#" in value):
            raise JournalError("Remote URLs cannot contain user information, query strings or fragments")
        result[key] = value
    return result


def process_fingerprint(pid: int) -> dict | None:
    """Linux start ticks prevent a reused PID from being mistaken for the owner."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        fields = raw[raw.rfind(")") + 2:].split()
        return {"pid": pid, "start_ticks": fields[19], "state": fields[0]}
    except FileNotFoundError:
        return None
    except (OSError, IndexError) as error:
        raise JournalError(f"Cannot inspect PID {pid}: {type(error).__name__}") from error


def environment_identity() -> dict:
    """A boot, PID namespace or PID-1 replacement invalidates old process IDs."""
    try:
        init = process_fingerprint(1)
        return {
            "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "pid_namespace": os.readlink("/proc/self/ns/pid"),
            "init_start_ticks": init["start_ticks"] if init else None,
        }
    except OSError as error:
        raise JournalError("Linux /proc is required for reliable restart/PID detection") from error


def atomic_json(path: Path, value: dict) -> None:
    """Readers see an old complete snapshot or a new complete snapshot, never half JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


@contextlib.contextmanager
def exclusive_lock(path: Path, *, nonblocking: bool = False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        except BlockingIOError as error:
            raise JournalError("Another watcher is already running for this state directory") from error
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def validate_journal(data: dict) -> dict:
    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA_VERSION:
        raise JournalError("Unsupported or malformed journal schema; refusing to overwrite")
    if not isinstance(data.get("operations"), dict):
        raise JournalError("Malformed operations journal; refusing to overwrite")
    for operation_id, operation in data["operations"].items():
        if not isinstance(operation, dict) or operation.get("id") != operation_id:
            raise JournalError("Malformed operation record")
        identifier(operation_id)
        if not isinstance(operation.get("kind"), str) or not isinstance(operation.get("status"), str):
            raise JournalError("Malformed operation kind or status")
        if operation["kind"] not in DEFAULT_DEADLINES or operation["status"] not in STATUSES:
            raise JournalError("Unknown operation kind or status")
        for field in ("started_at", "last_meaningful_progress_at", "last_activity_at", "deadline_at"):
            value = operation.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise JournalError(f"Malformed {field}")
            timestamp(value)
        if not isinstance(operation.get("environment"), dict) or not isinstance(operation.get("remote_identifiers"), dict):
            raise JournalError("Malformed operation environment or remote identifiers")
        if not isinstance(operation.get("checkpoints"), list):
            raise JournalError("Malformed operation checkpoints")
        for checkpoint in operation["checkpoints"]:
            if not isinstance(checkpoint, dict) or any(field not in checkpoint for field in ("id", "kind", "reference")):
                raise JournalError("Malformed progress evidence")
        for field in ("owner_process", "child_process"):
            process = operation.get(field)
            if process is not None and (not isinstance(process, dict) or not isinstance(process.get("pid"), int) or process["pid"] <= 0 or not isinstance(process.get("start_ticks"), str)):
                raise JournalError("Malformed process identity")
    return data


class Journal:
    def __init__(self, state_dir: Path):
        self.state_dir = state_dir
        self.path = state_dir / "journal.json"

    def read(self) -> dict:
        try:
            return validate_journal(json.loads(self.path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, UnicodeError) as error:
            raise JournalError("Journal is corrupt; preserve it and investigate, do not reset it") from error

    def change(self, update, *, create: bool = False) -> dict:
        with exclusive_lock(self.state_dir / "journal.lock"):
            if self.path.exists():
                data = self.read()
            elif create:
                data = {"schema_version": SCHEMA_VERSION, "operations": {}}
            else:
                raise JournalError("No journal exists; start an operation first")
            result = update(data)
            validate_journal(data)
            atomic_json(self.path, data)
            return result

    def start(self, kind: str, *, operation_id: str | None = None, deadline_seconds: float | None = None,
              pid: int | None = None, remote: dict | None = None, now: float | None = None,
              environment: dict | None = None) -> dict:
        if kind not in DEFAULT_DEADLINES:
            raise JournalError("Unknown operation kind")
        operation_id = identifier(operation_id or str(uuid.uuid4()))
        seconds = positive(DEFAULT_DEADLINES[kind] if deadline_seconds is None else deadline_seconds)
        now = time.time() if now is None else now
        owner = process_fingerprint(pid) if pid is not None else None
        if pid is not None and (owner is None or owner["state"] in {"Z", "X"}):
            raise JournalError("The requested owner PID is not running")
        operation = {
            "id": operation_id, "kind": kind, "status": "running",
            "started_at": now, "last_meaningful_progress_at": now, "last_activity_at": now,
            "deadline_at": now + seconds, "deadline_seconds": seconds,
            "environment": environment if environment is not None else environment_identity(),
            "owner_process": owner, "child_process": None,
            "remote_identifiers": dict(remote or {}), "checkpoints": [], "note": "Started; no completed checkpoint yet",
        }

        def update(data):
            if operation_id in data["operations"]:
                raise JournalError("Operation ID already exists; never silently retry or overwrite an operation")
            data["operations"][operation_id] = operation
            return operation

        return self.change(update, create=True)

    def update(self, operation_id: str, update) -> dict:
        def change(data):
            if operation_id not in data["operations"]:
                raise JournalError("Unknown operation ID")
            operation = data["operations"][operation_id]
            if operation["status"] in TERMINAL:
                raise JournalError("Operation is terminal; do not reopen or retry it implicitly")
            update(operation)
            return operation
        return self.change(change)

    def activity(self, operation_id: str, *, note: str, remote: dict | None = None,
                 now: float | None = None) -> dict:
        text_field(note, "Note")
        now = time.time() if now is None else now

        def update(operation):
            operation["last_activity_at"] = now
            operation["note"] = note
            operation["remote_identifiers"].update(remote or {})
        return self.update(operation_id, update)

    def checkpoint(self, operation_id: str, *, evidence_id: str, kind: str, reference: str,
                   summary: str, now: float | None = None) -> dict:
        identifier(evidence_id)
        text_field(reference, "Evidence reference")
        text_field(summary, "Evidence summary")
        if kind not in EVIDENCE_KINDS:
            raise JournalError("Unsupported evidence kind")
        now = time.time() if now is None else now

        def update(operation):
            previous = operation["checkpoints"]
            if any(item["id"] == evidence_id or (item["kind"] == kind and item["reference"] == reference) for item in previous):
                return  # Repeated evidence cannot keep a stalled operation apparently alive.
            if now < operation["last_meaningful_progress_at"]:
                raise JournalError("Clock moved backwards; do not rewrite progress history")
            previous.append({"id": evidence_id, "kind": kind, "reference": reference, "summary": summary, "at": now})
            operation["last_meaningful_progress_at"] = now
            operation["last_activity_at"] = now
            operation["note"] = summary
        return self.update(operation_id, update)

    def status(self, operation_id: str, *, status: str, note: str, now: float | None = None,
               exit_code: int | None = None) -> dict:
        if status not in STATUSES:
            raise JournalError("Unknown status")
        text_field(note, "Note")
        now = time.time() if now is None else now

        def update(operation):
            if status == "succeeded" and operation["kind"] == "upload" and not any(item["kind"] == "remote_verified" for item in operation["checkpoints"]):
                raise JournalError("Record a remote_verified checkpoint before declaring an upload successful")
            operation["status"] = status
            operation["last_activity_at"] = now
            operation["note"] = note
            if exit_code is not None:
                operation["exit_code"] = exit_code
            if status in TERMINAL:
                operation["finished_at"] = now
        return self.update(operation_id, update)

    def acknowledge(self, operation_id: str, *, note: str, now: float | None = None) -> dict:
        """Keep failed history, but let an explicit review clear its recurring alert."""
        text_field(note, "Acknowledgement note")
        now = time.time() if now is None else now

        def update(data):
            operation = data["operations"].get(operation_id)
            if operation is None or operation["status"] not in TERMINAL:
                raise JournalError("Only terminal operations can be acknowledged; reconcile uncertainty first")
            operation["acknowledgement"] = {"at": now, "note": note}
            return operation
        return self.change(update)


def inspect(data: dict, *, now: float | None = None, environment: dict | None = None,
            process_probe=process_fingerprint) -> dict:
    """Pure observation: no operation status, deadline or progress mutation."""
    validate_journal(data)
    now = time.time() if now is None else now
    environment = environment_identity() if environment is None else environment
    alerts, operations = [], []
    active = 0

    def alert(operation_id, code, message, severity="warning"):
        alerts.append({"operation_id": operation_id, "code": code, "severity": severity, "message": message})

    for operation in data["operations"].values():
        operation_id = operation["id"]
        status = operation["status"]
        operations.append({
            "id": operation_id, "kind": operation["kind"], "status": status,
            "started_at": timestamp(operation["started_at"]),
            "last_meaningful_progress_at": timestamp(operation["last_meaningful_progress_at"]),
            "seconds_without_progress": max(0, now - operation["last_meaningful_progress_at"]),
            "deadline_at": timestamp(operation["deadline_at"]),
            "remote_identifiers": operation["remote_identifiers"], "note": operation.get("note", ""),
        })
        if status in {"failed", "timed_out"} and "acknowledgement" not in operation:
            alert(operation_id, status, operation.get("note", status), "error")
        if status in TERMINAL:
            continue
        active += 1
        if status in {"blocked", "uncertain"}:
            alert(operation_id, status, operation.get("note", status), "error" if status == "uncertain" else "warning")
        if now < max(operation["started_at"], operation["last_meaningful_progress_at"]):
            alert(operation_id, "clock_regressed", "Clock is earlier than recorded progress; elapsed time is unreliable", "error")
        if now - operation["last_meaningful_progress_at"] >= STALL_SECONDS:
            alert(operation_id, "no_meaningful_progress", "No new verified checkpoint for at least 20 minutes")
        if now >= operation["deadline_at"]:
            alert(operation_id, "deadline_exceeded", "Operation deadline passed; inspect before any retry", "error")
        if operation["environment"] != environment:
            alert(operation_id, "environment_changed", "Boot/container identity changed; old PID ownership is unverified. Reconcile remote state before retry", "error")
            continue
        for name in ("owner_process", "child_process"):
            expected = operation.get(name)
            if expected is None:
                continue
            try:
                current = process_probe(expected["pid"])
            except JournalError as error:
                alert(operation_id, "process_unobservable", str(error), "error")
                continue
            if current is None or current["state"] in {"Z", "X"}:
                alert(operation_id, f"{name}_exited", "Recorded process exited without a terminal journal result; outcome must be reconciled", "error")
            elif current["start_ticks"] != expected["start_ticks"]:
                alert(operation_id, "pid_reused", "PID belongs to a different process; outcome must be reconciled", "error")
    if active == 0 and not any(item["status"] in TERMINAL for item in data["operations"].values()):
        alert(None, "no_operations", "No operations are registered; project progress is not being observed")
    return {"schema_version": SCHEMA_VERSION, "checked_at": timestamp(now), "checked_at_epoch": now,
            "next_check_due_at": timestamp(now + INTERVAL_SECONDS), "observer_pid": os.getpid(),
            "observer_environment": environment, "active_operations": active,
            "healthy": not alerts, "alerts": alerts, "operations": operations}


def check_once(journal: Journal, *, now: float | None = None, environment: dict | None = None) -> dict:
    now = time.time() if now is None else now
    try:
        return inspect(journal.read(), now=now, environment=environment)
    except (OSError, JournalError) as error:
        return {"schema_version": SCHEMA_VERSION, "checked_at": timestamp(now), "checked_at_epoch": now,
                "next_check_due_at": timestamp(now + INTERVAL_SECONDS), "observer_pid": os.getpid(),
                "healthy": False, "active_operations": None, "operations": [],
                "alerts": [{"operation_id": None, "code": "observation_failed", "severity": "error", "message": str(error)}]}


def write_report(state_dir: Path, report: dict) -> None:
    """Only observer outputs change. Keep one previous 1 MiB JSONL log, not unlimited growth."""
    with exclusive_lock(state_dir / "report.lock"):
        atomic_json(state_dir / "status.json", report)
        log = state_dir / "status.jsonl"
        if log.exists() and log.stat().st_size >= 1024 * 1024:
            os.replace(log, state_dir / "status.previous.jsonl")
        line = {key: report[key] for key in ("checked_at", "healthy", "active_operations", "alerts")}
        with log.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, ensure_ascii=False, allow_nan=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())


def observe(journal: Journal, *, once: bool = False, interval: float = INTERVAL_SECONDS) -> int:
    if once:
        report = check_once(journal)
        write_report(journal.state_dir, report)
        print(json.dumps(report, ensure_ascii=False), flush=True)
        return 0 if report["healthy"] else 1
    with exclusive_lock(journal.state_dir / "watcher.lock", nonblocking=True):
        while True:
            started = time.monotonic()
            report = check_once(journal)
            write_report(journal.state_dir, report)
            print(json.dumps(report, ensure_ascii=False), flush=True)
            time.sleep(max(0, interval - (time.monotonic() - started)))


def stop_owned_process(child: subprocess.Popen) -> None:
    """Only a group created by this wrapper; never PID-search or kill an existing job."""
    if child.poll() is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)


def run_command(journal: Journal, *, kind: str, operation_id: str | None, timeout: float,
                command: list[str], remote: dict | None = None) -> int:
    """Launch once, without a shell. Deadline limits are independent of output/activity."""
    timeout = positive(timeout)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise JournalError("Provide a previously authorized local command after --")
    operation = journal.start(kind, operation_id=operation_id, deadline_seconds=timeout, pid=os.getpid(), remote=remote)
    operation_id = operation["id"]
    print(json.dumps({"operation_id": operation_id, "journal": str(journal.path)}), flush=True)
    child = None
    began = time.monotonic()
    previous_term = signal.getsignal(signal.SIGTERM)

    def terminate(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, terminate)
    try:
        # No command line, environment, stdout, or stderr is persisted to the journal.
        child = subprocess.Popen(command, shell=False, start_new_session=True)
        identity = process_fingerprint(child.pid)
        if identity:
            journal.update(operation_id, lambda record: record.update(child_process=identity))
        returncode = child.wait(timeout=max(0, timeout - (time.monotonic() - began)))
        if kind == "upload":
            journal.status(operation_id, status="uncertain",
                           note=f"Upload command exited with code {returncode}; remote outcome is unverified. Read remote state before resolving or retrying", exit_code=returncode)
        elif returncode == 0:
            journal.checkpoint(operation_id, evidence_id="command-exit-zero", kind="tests_completed" if kind == "test" else "milestone",
                               reference=f"local-command:{operation_id}:exit:0", summary="Local command exited successfully; remote outcomes still require verification")
            journal.status(operation_id, status="succeeded", note="Local command exited with code 0", exit_code=0)
        else:
            journal.status(operation_id, status="failed", note=f"Local command exited with code {returncode}; no retry was attempted", exit_code=returncode)
        return returncode if returncode >= 0 else 128 - returncode
    except subprocess.TimeoutExpired:
        if child is not None:
            stop_owned_process(child)
        journal.status(operation_id, status="uncertain" if kind == "upload" else "timed_out",
                       note="Deadline reached; only the wrapper-owned process group was stopped. Verify any remote side effect before retry", exit_code=124)
        return 124
    except KeyboardInterrupt:
        if child is not None:
            stop_owned_process(child)
        journal.status(operation_id, status="uncertain" if kind == "upload" else "cancelled",
                       note="Wrapper interrupted; only its own child was stopped. No retry was attempted", exit_code=130)
        return 130
    except (OSError, JournalError, ValueError) as error:
        if child is not None:
            stop_owned_process(child)
        journal.status(operation_id, status="uncertain" if kind == "upload" else "failed",
                       note=f"Local execution error: {type(error).__name__}; no retry was attempted", exit_code=127)
        return 127
    finally:
        signal.signal(signal.SIGTERM, previous_term)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--state-dir", type=Path, default=DEFAULT_STATE)
    commands = result.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start", help="Record a single operation before it starts")
    start.add_argument("--id")
    start.add_argument("--kind", choices=sorted(DEFAULT_DEADLINES), required=True)
    start.add_argument("--deadline-seconds", type=positive)
    start.add_argument("--pid", type=int)
    start.add_argument("--remote", action="append", default=[])
    activity = commands.add_parser("activity", help="Record activity/remote IDs WITHOUT advancing progress")
    activity.add_argument("id")
    activity.add_argument("--note", required=True)
    activity.add_argument("--remote", action="append", default=[])
    checkpoint = commands.add_parser("checkpoint", help="Record new verified evidence, never a heartbeat")
    checkpoint.add_argument("id")
    checkpoint.add_argument("--evidence-id", required=True)
    checkpoint.add_argument("--kind", choices=sorted(EVIDENCE_KINDS), required=True)
    checkpoint.add_argument("--reference", required=True)
    checkpoint.add_argument("--summary", required=True)
    status = commands.add_parser("status", help="Explicitly reconcile/finish an operation")
    status.add_argument("id")
    status.add_argument("--set", dest="status", choices=sorted(STATUSES), required=True)
    status.add_argument("--note", required=True)
    acknowledge = commands.add_parser("acknowledge", help="Acknowledge a reviewed terminal result without erasing history")
    acknowledge.add_argument("id")
    acknowledge.add_argument("--note", required=True)
    once = commands.add_parser("once", help="Observe once, write status, exit 0=healthy / 1=alerts")
    once.set_defaults(once=True)
    watch = commands.add_parser("watch", help="Read-only observer; checks every 60 seconds")
    watch.set_defaults(once=False)
    run = commands.add_parser("run", help="Run an already-authorized local command once with a deadline")
    run.add_argument("--id")
    run.add_argument("--kind", choices=sorted(DEFAULT_DEADLINES), required=True)
    run.add_argument("--timeout", type=positive, required=True)
    run.add_argument("--remote", action="append", default=[])
    run.add_argument("argv", nargs=argparse.REMAINDER)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    journal = Journal(args.state_dir.resolve())
    try:
        if args.command == "start":
            result = journal.start(args.kind, operation_id=args.id, deadline_seconds=args.deadline_seconds,
                                   pid=args.pid, remote=remote_identifiers(args.remote))
        elif args.command == "activity":
            result = journal.activity(args.id, note=args.note, remote=remote_identifiers(args.remote))
        elif args.command == "checkpoint":
            result = journal.checkpoint(args.id, evidence_id=args.evidence_id, kind=args.kind,
                                        reference=args.reference, summary=args.summary)
        elif args.command == "status":
            result = journal.status(args.id, status=args.status, note=args.note)
        elif args.command == "acknowledge":
            result = journal.acknowledge(args.id, note=args.note)
        elif args.command in {"watch", "once"}:
            return observe(journal, once=args.once)
        else:
            return run_command(journal, kind=args.kind, operation_id=args.id, timeout=args.timeout,
                               command=args.argv, remote=remote_identifiers(args.remote))
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except KeyboardInterrupt:
        return 130
    except (OSError, JournalError, ValueError) as error:
        print(f"watchdog: {error}", file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
