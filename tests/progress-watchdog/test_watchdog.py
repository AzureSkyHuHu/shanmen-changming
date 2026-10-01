"""Self-contained stdlib tests. Run only by the repository integration owner."""

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "progress-watchdog" / "watchdog.py"
SPEC = importlib.util.spec_from_file_location("progress_watchdog", SCRIPT)
watchdog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watchdog)
ENVIRONMENT = {"boot_id": "fixture-boot", "pid_namespace": "fixture-pid-namespace", "init_start_ticks": "1"}


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name)
        self.journal = watchdog.Journal(self.state)

    def start(self, operation_id="sample", **kwargs):
        return self.journal.start("development", operation_id=operation_id, now=1000,
                                  environment=ENVIRONMENT, **kwargs)

    def report(self, now=1000, **kwargs):
        return watchdog.inspect(self.journal.read(), now=now, environment=ENVIRONMENT, **kwargs)

    def codes(self, report):
        return {alert["code"] for alert in report["alerts"]}

    def command(self, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), "--state-dir", str(self.state), *args],
                              capture_output=True, text=True, timeout=10)

    def test_start_persists_identity_deadline_and_remote_ids(self):
        operation = self.start(remote={"commit": "example-sha"})
        restored = watchdog.Journal(self.state).read()["operations"]["sample"]
        self.assertEqual(restored, operation)
        self.assertEqual(restored["deadline_at"], 8200)
        self.assertEqual(restored["remote_identifiers"], {"commit": "example-sha"})

    def test_duplicate_operation_id_does_not_overwrite(self):
        self.start()
        before = self.journal.path.read_bytes()
        with self.assertRaises(watchdog.JournalError):
            self.start()
        self.assertEqual(before, self.journal.path.read_bytes())

    def test_twenty_minute_boundary(self):
        self.start()
        self.assertNotIn("no_meaningful_progress", self.codes(self.report(2199.99)))
        self.assertIn("no_meaningful_progress", self.codes(self.report(2200)))

    def test_activity_and_remote_updates_never_count_as_progress(self):
        self.start()
        self.journal.activity("sample", note="Still producing output", remote={"run": "123"}, now=2199)
        operation = self.journal.read()["operations"]["sample"]
        self.assertEqual(operation["last_meaningful_progress_at"], 1000)
        self.assertEqual(operation["last_activity_at"], 2199)
        self.assertIn("no_meaningful_progress", self.codes(self.report(2200)))

    def test_verified_new_evidence_advances_progress(self):
        self.start()
        self.journal.checkpoint("sample", evidence_id="suite-1", kind="tests_completed",
                                reference="local:run-1:12-passed", summary="12 focused cases passed", now=2000)
        self.assertEqual(self.journal.read()["operations"]["sample"]["last_meaningful_progress_at"], 2000)
        self.assertNotIn("no_meaningful_progress", self.codes(self.report(2200)))

    def test_same_evidence_id_or_reference_cannot_reset_timer(self):
        self.start()
        self.journal.checkpoint("sample", evidence_id="evidence-1", kind="artifact_verified",
                                reference="sha256:fixture", summary="Artifact verified", now=1100)
        self.journal.checkpoint("sample", evidence_id="evidence-1", kind="milestone",
                                reference="different-ref", summary="Repeated evidence ID", now=2100)
        self.journal.checkpoint("sample", evidence_id="evidence-2", kind="artifact_verified",
                                reference="sha256:fixture", summary="Repeated reference", now=2200)
        self.assertEqual(self.journal.read()["operations"]["sample"]["last_meaningful_progress_at"], 1100)
        self.assertIn("no_meaningful_progress", self.codes(self.report(2300)))

    def test_checkpoint_does_not_extend_deadline(self):
        self.start(deadline_seconds=100)
        self.journal.checkpoint("sample", evidence_id="new", kind="milestone",
                                reference="accepted:part-1", summary="Part 1 verified", now=1099)
        self.assertIn("deadline_exceeded", self.codes(self.report(1100)))

    def test_kind_specific_deadlines(self):
        for kind, duration in (("upload", 600), ("test", 900), ("build", 900)):
            operation = self.journal.start(kind, operation_id=kind, now=1000, environment=ENVIRONMENT)
            self.assertEqual(operation["deadline_at"], 1000 + duration)

    def test_observation_does_not_mutate_journal_or_status(self):
        self.start(deadline_seconds=5)
        before = self.journal.path.read_bytes()
        report = self.report(3000)
        watchdog.write_report(self.state, report)
        self.assertEqual(before, self.journal.path.read_bytes())
        self.assertEqual(self.journal.read()["operations"]["sample"]["status"], "running")
        self.assertFalse(json.loads((self.state / "status.json").read_text())["healthy"])

    def test_restart_is_detected_without_probing_old_pids(self):
        self.start()
        probe = mock.Mock(side_effect=AssertionError("Old environment PID must not be probed"))
        report = watchdog.inspect(self.journal.read(), now=1001, environment={**ENVIRONMENT, "boot_id": "different"}, process_probe=probe)
        self.assertIn("environment_changed", self.codes(report))
        probe.assert_not_called()

    def test_namespace_change_detects_container_restart_on_same_boot(self):
        self.start()
        report = watchdog.inspect(self.journal.read(), now=1001,
                                  environment={**ENVIRONMENT, "pid_namespace": "replacement"})
        self.assertIn("environment_changed", self.codes(report))

    def test_dead_process_is_an_alert(self):
        self.start()
        self.journal.update("sample", lambda operation: operation.update(owner_process={"pid": 99, "start_ticks": "1", "state": "R"}))
        self.assertIn("owner_process_exited", self.codes(self.report(process_probe=lambda _pid: None)))

    def test_zombie_is_not_running(self):
        self.start()
        identity = {"pid": 99, "start_ticks": "1", "state": "R"}
        self.journal.update("sample", lambda operation: operation.update(owner_process=identity))
        self.assertIn("owner_process_exited", self.codes(self.report(process_probe=lambda _pid: {**identity, "state": "Z"})))

    def test_pid_reuse_is_not_progress(self):
        self.start()
        self.journal.update("sample", lambda operation: operation.update(owner_process={"pid": 99, "start_ticks": "1", "state": "R"}))
        self.assertIn("pid_reused", self.codes(self.report(process_probe=lambda _pid: {"pid": 99, "start_ticks": "2", "state": "S"})))

    def test_no_owner_is_valid_for_external_operations(self):
        self.start()
        probe = mock.Mock(side_effect=AssertionError("No owner to probe"))
        self.assertTrue(self.report(process_probe=probe)["healthy"])

    def test_blocked_and_uncertain_are_visible_without_waiting(self):
        self.start()
        self.journal.status("sample", status="blocked", note="Awaiting permission", now=1001)
        self.assertIn("blocked", self.codes(self.report(1001)))
        self.journal.status("sample", status="uncertain", note="Remote write outcome unknown", now=1002)
        self.assertIn("uncertain", self.codes(self.report(1002)))

    def test_terminal_operations_do_not_trigger_stall(self):
        self.start()
        self.journal.status("sample", status="succeeded", note="Verified", now=1001)
        self.assertTrue(self.report(10000)["healthy"])
        with self.assertRaises(watchdog.JournalError):
            self.journal.status("sample", status="running", note="Unsafe implicit retry", now=10002)

    def test_failure_remains_visible_after_completion(self):
        self.start()
        self.journal.status("sample", status="failed", note="Tests failed", now=1001)
        self.assertEqual(self.codes(self.report(10000)), {"failed"})

    def test_explicit_acknowledgement_preserves_failure_and_progress(self):
        self.start()
        self.journal.status("sample", status="failed", note="Tests failed", now=1001)
        self.journal.acknowledge("sample", note="Reviewed failure; tracked fix separately", now=1002)
        operation = self.journal.read()["operations"]["sample"]
        self.assertEqual(operation["status"], "failed")
        self.assertEqual(operation["last_meaningful_progress_at"], 1000)
        self.assertTrue(self.report(10000)["healthy"])

    def test_uncertain_operation_cannot_be_acknowledged_away(self):
        self.start()
        self.journal.status("sample", status="uncertain", note="Awaiting reconciliation", now=1001)
        with self.assertRaises(watchdog.JournalError):
            self.journal.acknowledge("sample", note="Cannot clear uncertainty", now=1002)

    def test_upload_success_requires_remote_evidence(self):
        self.journal.start("upload", operation_id="upload", now=1000, environment=ENVIRONMENT)
        with self.assertRaises(watchdog.JournalError):
            self.journal.status("upload", status="succeeded", note="Only command return observed", now=1001)
        self.journal.checkpoint("upload", evidence_id="remote-read-1", kind="remote_verified",
                                reference="remote-commit:example-sha", summary="Read remote commit and compared expected tree", now=1002)
        self.journal.status("upload", status="succeeded", note="Remote result verified", now=1003)
        self.assertTrue(self.report(1004)["healthy"])

    def test_clock_regression_is_visible_and_checkpoint_is_rejected(self):
        self.start()
        self.assertIn("clock_regressed", self.codes(self.report(999)))
        with self.assertRaises(watchdog.JournalError):
            self.journal.checkpoint("sample", evidence_id="bad-clock", kind="milestone",
                                    reference="accepted:part", summary="Would rewrite history", now=999)

    def test_corrupt_journal_is_preserved_and_reported(self):
        self.journal.path.write_text('{"operations":')
        before = self.journal.path.read_bytes()
        report = watchdog.check_once(self.journal, now=1000, environment=ENVIRONMENT)
        self.assertIn("observation_failed", self.codes(report))
        with self.assertRaises(watchdog.JournalError):
            self.start()
        self.assertEqual(self.journal.path.read_bytes(), before)

    def test_missing_journal_is_an_alert_not_healthy(self):
        report = watchdog.check_once(self.journal, now=1000, environment=ENVIRONMENT)
        self.assertFalse(report["healthy"])
        self.assertFalse(self.journal.path.exists())

    def test_malformed_status_and_out_of_range_timestamp_report_failure(self):
        self.start()
        original = self.journal.read()
        for field, value in (("status", {}), ("deadline_at", 1e308)):
            data = json.loads(json.dumps(original))
            data["operations"]["sample"][field] = value
            self.journal.path.write_text(json.dumps(data))
            self.assertIn("observation_failed", self.codes(watchdog.check_once(self.journal, now=1000, environment=ENVIRONMENT)))

    def test_atomic_failure_preserves_previous_journal(self):
        self.start()
        before = self.journal.path.read_bytes()
        with mock.patch.object(watchdog.os, "replace", side_effect=OSError("fixture interruption")):
            with self.assertRaises(OSError):
                self.journal.activity("sample", note="Should not replace valid journal", now=1001)
        self.assertEqual(self.journal.path.read_bytes(), before)
        self.assertEqual(list(self.state.glob(".journal.json.*")), [])

    def test_concurrent_journal_updates_do_not_drop_operations(self):
        def write(number):
            return self.start(f"parallel-{number}")
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(write, range(12)))
        self.assertEqual(len(self.journal.read()["operations"]), 12)

    def test_nan_deadline_is_rejected(self):
        for number in (0, -1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                self.start(deadline_seconds=number)

    def test_remote_identifier_validation_rejects_credential_fields(self):
        for value in ("access_token=example", "secret=example", "run=https://example.test/?token=example", "run=https://user@example.test/run"):
            with self.assertRaises(watchdog.JournalError):
                watchdog.remote_identifiers([value])
        self.assertEqual(watchdog.remote_identifiers(["commit=abc123", "run=456"]), {"commit": "abc123", "run": "456"})

    def test_once_cli_reports_missing_journal_nonzero(self):
        result = self.command("once")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(json.loads(result.stdout)["healthy"])
        self.assertTrue((self.state / "status.jsonl").exists())

    def test_local_wrapper_records_success_without_argv_or_output(self):
        result = self.command("run", "--id", "local-success", "--kind", "test", "--timeout", "3", "--",
                              sys.executable, "-c", "print('fixture-output-not-journaled')")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.journal.read()["operations"]["local-success"]["status"], "succeeded")
        self.assertNotIn("fixture-output-not-journaled", self.journal.path.read_text())

    def test_wrapper_nonzero_is_recorded_and_returned(self):
        result = self.command("run", "--id", "local-failure", "--kind", "test", "--timeout", "3", "--",
                              sys.executable, "-c", "raise SystemExit(7)")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(self.journal.read()["operations"]["local-failure"]["status"], "failed")

    def test_wrapper_deadline_does_not_kill_unrelated_process(self):
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(lambda: unrelated.poll() is None and unrelated.terminate())
        try:
            result = self.command("run", "--id", "local-timeout", "--kind", "test", "--timeout", "0.15", "--",
                                  sys.executable, "-c", "import time; time.sleep(30)")
            self.assertEqual(result.returncode, 124, result.stderr)
            self.assertEqual(self.journal.read()["operations"]["local-timeout"]["status"], "timed_out")
            self.assertIsNone(unrelated.poll())
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=3)

    def test_upload_success_still_requires_remote_verification(self):
        result = self.command("run", "--id", "upload-unverified", "--kind", "upload", "--timeout", "3", "--",
                              sys.executable, "-c", "pass")
        self.assertEqual(result.returncode, 0, result.stderr)
        operation = self.journal.read()["operations"]["upload-unverified"]
        self.assertEqual(operation["status"], "uncertain")
        self.assertEqual(operation["checkpoints"], [])

    def test_upload_timeout_never_retries_or_claims_remote_failure(self):
        marker = self.state / "launch-count.txt"
        result = self.command("run", "--id", "upload-timeout", "--kind", "upload", "--timeout", "0.3", "--",
                              sys.executable, "-c", f"from pathlib import Path; import time; p=Path({str(marker)!r}); p.write_text('once'); time.sleep(30)")
        self.assertEqual(result.returncode, 124, result.stderr)
        operation = self.journal.read()["operations"]["upload-timeout"]
        self.assertEqual(operation["status"], "uncertain")
        self.assertEqual(marker.read_text(), "once")

    def test_observer_schedule_is_sixty_seconds(self):
        self.assertEqual(watchdog.INTERVAL_SECONDS, 60)
        self.assertEqual(watchdog.STALL_SECONDS, 1200)


if __name__ == "__main__":
    unittest.main()
