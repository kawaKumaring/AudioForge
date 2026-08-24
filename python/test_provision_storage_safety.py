# -*- coding: utf-8 -*-
"""Storage safety contracts (synthetic only; no network/install/GPU)."""

import json
import os
import shutil
import stat
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import runtime_paths as rp
from provision import layout, lock, reason_codes as rc, staging


class AtomicLockTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="af_lock_safe_")
        self.path = os.path.join(self.root, "provision.lock")

    def tearDown(self):
        shutil.rmtree(self.root)

    def _acquire(self, **overrides):
        args = dict(
            lock_path=self.path, pid=101, now=10.0,
            pid_alive=lambda _pid: True, job_id="job-a",
            plan_fingerprint="fp-a", nonce="nonce-a")
        args.update(overrides)
        return lock.acquire(**args)

    def test_atomic_create_uses_exclusive_flag_and_full_identity(self):
        flags_seen = []

        def recording_open(path, flags, mode):
            flags_seen.append(flags)
            return os.open(path, flags, mode)

        info = self._acquire(open_fn=recording_open)
        self.assertTrue(flags_seen[0] & os.O_CREAT)
        self.assertTrue(flags_seen[0] & os.O_EXCL)
        self.assertEqual(
            (info["jobId"], info["planFingerprint"], info["nonce"]),
            ("job-a", "fp-a", "nonce-a"))

    def test_racing_creator_is_held_and_never_overwritten(self):
        first = self._acquire()
        with open(self.path, "rb") as handle:
            before = handle.read()
        with self.assertRaises(rc.ProvisionError) as raised:
            self._acquire(pid=202, job_id="job-b",
                          plan_fingerprint="fp-b", nonce="nonce-b")
        self.assertEqual(raised.exception.code, rc.PROVISION_LOCK_HELD)
        with open(self.path, "rb") as handle:
            self.assertEqual(handle.read(), before)
        self.assertEqual(lock.decode_lock(before.decode("utf-8")), first)

    def test_stale_lock_is_reported_not_stolen(self):
        self._acquire()
        with open(self.path, "rb") as handle:
            before = handle.read()
        with self.assertRaises(rc.ProvisionError) as raised:
            self._acquire(pid=202, now=9999, pid_alive=lambda _pid: False,
                          stat_fn=lambda _path: 10.0)
        self.assertEqual(raised.exception.code, rc.PROVISION_LOCK_STALE)
        with open(self.path, "rb") as handle:
            self.assertEqual(handle.read(), before)

    def test_heartbeat_and_release_require_owner_nonce(self):
        self._acquire()
        self.assertFalse(lock.heartbeat(
            self.path, 101, "job-a", "fp-a", "wrong", 20.0))
        self.assertTrue(lock.heartbeat(
            self.path, 101, "job-a", "fp-a", "nonce-a", 20.0))
        with open(self.path, encoding="utf-8") as handle:
            refreshed = lock.decode_lock(handle.read())
        self.assertEqual(refreshed["heartbeatAt"], 20.0)
        self.assertFalse(lock.release(
            self.path, 101, "job-a", "fp-a", "wrong"))
        self.assertTrue(os.path.exists(self.path))
        self.assertTrue(lock.release(
            self.path, 101, "job-a", "fp-a", "nonce-a"))

    def test_nonfinite_lock_times_are_rejected(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                lock.encode_lock(101, value, "job-a", "fp-a", "nonce-a")
        payload = json.dumps({
            "schemaVersion": 2, "pid": 101, "jobId": "job-a",
            "planFingerprint": "fp-a", "nonce": "nonce-a",
            "createdAt": 1.0, "heartbeatAt": float("nan"),
        })
        self.assertIsNone(lock.decode_lock(payload))

    def test_release_identity_change_never_deletes_replacement(self):
        self._acquire()
        with mock.patch.object(lock, "_same_identity", return_value=False):
            self.assertFalse(lock.release(
                self.path, 101, "job-a", "fp-a", "nonce-a"))
        self.assertTrue(os.path.exists(self.path))

    def test_acquire_write_failure_never_deletes_replacement_owner(self):
        real_write = os.write
        replacement = lock.encode_lock(
            202, 11.0, "job-b", "fp-b", "nonce-b")
        moved = self.path + ".failed-owner"

        def substituted_open(_path, flags, mode):
            owned_fd = os.open(moved, flags, mode)
            replacement_fd = os.open(self.path, flags, mode)
            try:
                real_write(replacement_fd, replacement.encode("utf-8"))
                os.fsync(replacement_fd)
            finally:
                os.close(replacement_fd)
            return owned_fd

        def fail_after_partial_write(fd, data):
            real_write(fd, data)
            raise OSError("injected write failure")

        with mock.patch.object(lock.os, "write", side_effect=fail_after_partial_write):
            with self.assertRaises(OSError):
                self._acquire(open_fn=substituted_open)
        with open(self.path, encoding="utf-8") as handle:
            current = lock.decode_lock(handle.read())
        self.assertEqual(current["nonce"], "nonce-b")
        self.assertTrue(os.path.exists(moved))


class ManagedCleanupTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="af_stage_safe_")

    def tearDown(self):
        shutil.rmtree(self.root)

    def _owned(self, job="job-a", nonce="nonce-a"):
        path = os.path.join(self.root, "staging", job)
        os.makedirs(path)
        staging.create_job_marker(path, self.root, job, "fp-a", nonce)
        with open(os.path.join(path, "payload.bin"), "wb") as handle:
            handle.write(b"x")
        return path

    def test_cleanup_requires_matching_job_marker_and_nonce(self):
        path = self._owned()
        with self.assertRaises(rc.ProvisionError):
            staging.cleanup_staging(path, self.root, "job-a", "fp-a", "wrong")
        self.assertTrue(os.path.exists(path))
        self.assertTrue(staging.cleanup_staging(
            path, self.root, "job-a", "fp-a", "nonce-a",
            mutation_guard_fn=lambda _path: None))
        self.assertFalse(os.path.exists(path))

    def test_cleanup_requires_matching_plan_fingerprint(self):
        path = self._owned()
        with self.assertRaises(rc.ProvisionError):
            staging.cleanup_staging(
                path, self.root, "job-a", "other-plan", "nonce-a",
                mutation_guard_fn=lambda _path: None)
        self.assertTrue(os.path.exists(path))

    def test_cleanup_revalidates_identity_before_mutation(self):
        path = self._owned()
        with mock.patch.object(
                staging, "_same_identity", side_effect=[True, False]), \
                mock.patch.object(staging.shutil, "rmtree") as remove:
            with self.assertRaises(rc.ProvisionError):
                staging.cleanup_staging(
                    path, self.root, "job-a", "fp-a", "nonce-a",
                    mutation_guard_fn=lambda _path: None)
        remove.assert_not_called()
        self.assertTrue(os.path.exists(path))

    def test_partial_marker_write_is_cleaned_by_identity(self):
        path = os.path.join(self.root, "partial")
        os.makedirs(path)
        with mock.patch.object(
                staging, "_write_all", side_effect=OSError("short")):
            with self.assertRaises(OSError):
                staging.create_job_marker(
                    path, self.root, "job-a", "fp-a", "nonce-a")
        self.assertFalse(os.path.lexists(
            os.path.join(path, staging.JOB_MARKER_FILE)))

    def test_cleanup_refuses_arbitrary_and_outside_paths(self):
        arbitrary = os.path.join(self.root, "not-owned")
        os.makedirs(arbitrary)
        with self.assertRaises(rc.ProvisionError):
            staging.cleanup_staging(
                arbitrary, self.root, "job-a", "fp-a", "nonce-a")
        outside = tempfile.mkdtemp(prefix="af_outside_")
        try:
            with self.assertRaises(rc.ProvisionError) as raised:
                staging.cleanup_staging(
                    outside, self.root, "job-a", "fp-a", "nonce-a")
            self.assertEqual(raised.exception.code, rc.PATH_OUTSIDE_ROOT)
        finally:
            shutil.rmtree(outside)

    def test_cleanup_error_is_not_silent_success(self):
        path = self._owned()
        with mock.patch.object(
                staging.shutil, "rmtree", side_effect=OSError("busy")):
            with self.assertRaises(OSError):
                staging.cleanup_staging(
                    path, self.root, "job-a", "fp-a", "nonce-a",
                    mutation_guard_fn=lambda _path: None)
        self.assertTrue(os.path.exists(path))

    def test_reparse_or_symlink_chain_is_refused(self):
        path = self._owned()
        with mock.patch.object(
                staging, "_has_reparse_or_link", return_value=True):
            with self.assertRaises(rc.ProvisionError):
                staging.cleanup_staging(
                    path, self.root, "job-a", "fp-a", "nonce-a")
        self.assertTrue(os.path.exists(path))

    @unittest.skipUnless(os.name == "nt", "Windows fail-closed contract")
    def test_windows_tree_mutation_requires_reviewed_adapter(self):
        path = self._owned()
        with self.assertRaises(rc.ProvisionError) as raised:
            staging.cleanup_staging(
                path, self.root, "job-a", "fp-a", "nonce-a")
        self.assertEqual(raised.exception.code, rc.APPLY_DISABLED)
        self.assertTrue(os.path.exists(path))


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="af_promote_safe_")

    def tearDown(self):
        shutil.rmtree(self.root)

    def _paths(self):
        versioned = os.path.join(self.root, "versions", "component@1")
        staged = staging.target_local_staging_dir(
            versioned, "job-a", "component")
        os.makedirs(staged)
        staging.create_job_marker(
            staged, self.root, "job-a", "fp-a", "nonce-a")
        with open(os.path.join(staged, "payload.bin"), "wb") as handle:
            handle.write(b"payload")
        return staged, versioned, os.path.join(self.root, "active.json")

    def test_target_local_derivation_rejects_identifier_traversal(self):
        versioned = os.path.join(self.root, "versions", "component@1")
        with self.assertRaises(rc.ProvisionError):
            staging.target_local_staging_dir(
                versioned, "../escape", "component")
        path = staging.target_local_staging_dir(
            versioned, "job-a", "component")
        self.assertEqual(
            os.path.dirname(os.path.dirname(os.path.dirname(path))),
            os.path.dirname(versioned))

    def test_cross_volume_promote_is_blocked_before_replace(self):
        staged, versioned, pointer = self._paths()
        called = []
        with self.assertRaises(rc.ProvisionError) as raised:
            staging.promote(
                staged, versioned, pointer,
                {"componentId": "component", "version": "1"},
                self.root, "job-a", "fp-a", "nonce-a",
                replace_dir_fn=lambda *_args: called.append(True),
                volume_fn=lambda path: "SRC" if path == staged else "DST")
        self.assertEqual(raised.exception.code, rc.APPLY_DISABLED)
        self.assertEqual(called, [])
        self.assertTrue(os.path.isdir(staged))

    def test_promote_revalidates_staging_identity_before_replace(self):
        staged, versioned, pointer = self._paths()
        with mock.patch.object(
                staging, "_same_identity",
                side_effect=[True, True, False]), \
                mock.patch.object(staging.os, "replace") as replace:
            with self.assertRaises(rc.ProvisionError):
                staging.promote(
                    staged, versioned, pointer,
                    {"componentId": "component", "version": "1"},
                    self.root, "job-a", "fp-a", "nonce-a",
                    volume_fn=lambda _path: "VOL",
                    dir_fsync_fn=lambda _path: None)
        replace.assert_not_called()
        self.assertTrue(os.path.isdir(staged))

    def test_same_volume_promote_retains_owner_marker_in_final(self):
        staged, versioned, pointer = self._paths()
        active = {"componentId": "component", "version": "1"}
        staging.promote(
            staged, versioned, pointer, active,
            self.root, "job-a", "fp-a", "nonce-a",
            volume_fn=lambda _path: "VOL",
            dir_fsync_fn=lambda _path: None,
            mutation_guard_fn=lambda _path: None)
        self.assertTrue(os.path.isfile(
            os.path.join(versioned, "payload.bin")))
        self.assertTrue(os.path.exists(
            os.path.join(versioned, staging.JOB_MARKER_FILE)))
        self.assertEqual(staging.read_pointer(pointer), active)

    def test_pointer_failure_retains_owned_orphan_and_can_rollback(self):
        staged, versioned, pointer = self._paths()
        active = {"componentId": "component", "version": "1"}
        with self.assertRaises(OSError):
            staging.promote(
                staged, versioned, pointer, active, self.root,
                "job-a", "fp-a", "nonce-a",
                replace_pointer_fn=lambda *_args: (_ for _ in ()).throw(
                    OSError("disk full")),
                volume_fn=lambda _path: "VOL",
                dir_fsync_fn=lambda _path: None,
                mutation_guard_fn=lambda _path: None)
        self.assertTrue(os.path.isfile(
            os.path.join(versioned, staging.JOB_MARKER_FILE)))
        self.assertTrue(staging.rollback_orphan_final(
            versioned, pointer, active, self.root,
            "job-a", "fp-a", "nonce-a",
            mutation_guard_fn=lambda _path: None))
        self.assertFalse(os.path.lexists(versioned))

    def test_pointer_temp_is_exclusive_and_hardlink_pointer_rejected(self):
        parent = os.path.join(self.root, "pointer")
        os.makedirs(parent)
        pointer = os.path.join(parent, "active.json")
        temp = os.path.join(parent, ".active.json.tmp-fixed")
        with open(temp, "wb") as handle:
            handle.write(b"attacker")
        with self.assertRaises(FileExistsError):
            staging.write_pointer_atomic(
                pointer, {"version": "1"}, self.root,
                dir_fsync_fn=lambda _path: None,
                nonce_fn=lambda: "fixed")
        self.assertFalse(os.path.lexists(pointer))
        with open(temp, "rb") as handle:
            self.assertEqual(handle.read(), b"attacker")

        with open(pointer, "w", encoding="utf-8") as handle:
            handle.write("{}")
        alias = os.path.join(parent, "alias.json")
        os.link(pointer, alias)
        with self.assertRaises(rc.ProvisionError):
            staging.write_pointer_atomic(
                pointer, {"version": "2"}, self.root,
                dir_fsync_fn=lambda _path: None)

    def test_existing_pointer_symlink_is_rejected_when_supported(self):
        parent = os.path.join(self.root, "symlink-pointer")
        os.makedirs(parent)
        target = os.path.join(parent, "target.json")
        pointer = os.path.join(parent, "active.json")
        with open(target, "w", encoding="utf-8") as handle:
            handle.write("{}")
        try:
            os.symlink(target, pointer)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"symlink unavailable: {exc}")
        with self.assertRaises(rc.ProvisionError):
            staging.write_pointer_atomic(
                pointer, {"version": "2"}, self.root,
                dir_fsync_fn=lambda _path: None)

    def test_pointer_temp_nonce_cannot_escape_parent(self):
        parent = os.path.join(self.root, "nonce-pointer")
        os.makedirs(parent)
        pointer = os.path.join(parent, "active.json")
        with self.assertRaises(rc.ProvisionError) as raised:
            staging.write_pointer_atomic(
                pointer, {"version": "1"}, self.root,
                dir_fsync_fn=lambda _path: None,
                nonce_fn=lambda: "../escape")
        self.assertEqual(raised.exception.code, rc.PATH_OUTSIDE_ROOT)
        self.assertFalse(os.path.lexists(pointer))


class ArchiveAndCapacityTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="af_archive_safe_")

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_zip_slip_absolute_ads_and_symlink_rejected(self):
        bad = ("../x", "a/../../x", "/absolute", "C:/absolute", "a:ads")
        for name in bad:
            with self.subTest(name=name), self.assertRaises(rc.ProvisionError):
                staging.safe_archive_member_path(self.root, name)
        link = types.SimpleNamespace(
            filename="link", external_attr=(stat.S_IFLNK | 0o777) << 16)
        with self.assertRaises(rc.ProvisionError):
            staging.validate_zip_infos(self.root, [link])

    def test_zip_members_are_contained_and_collision_rejected(self):
        infos = [
            types.SimpleNamespace(filename="dir/a.bin", external_attr=0),
            types.SimpleNamespace(filename="dir/b.bin", external_attr=0),
        ]
        paths = staging.validate_zip_infos(self.root, infos)
        self.assertEqual(len(paths), 2)
        self.assertTrue(all(path.startswith(self.root) for path in paths))
        duplicate = [
            types.SimpleNamespace(filename="same.bin", external_attr=0),
            types.SimpleNamespace(filename="same.bin", external_attr=0),
        ]
        with self.assertRaises(rc.ProvisionError):
            staging.validate_zip_infos(self.root, duplicate)

    def test_zip_windows_aliases_and_all_special_types_rejected(self):
        for name in ("CON", "con.txt", "name.", "name ", "bad?.bin"):
            with self.subTest(name=name), self.assertRaises(rc.ProvisionError):
                staging.safe_archive_member_path(self.root, name)
        aliases = [
            types.SimpleNamespace(filename="A.txt", external_attr=0),
            types.SimpleNamespace(filename="a.TXT", external_attr=0),
        ]
        with self.assertRaises(rc.ProvisionError):
            staging.validate_zip_infos(self.root, aliases)
        for special in (stat.S_IFIFO, stat.S_IFCHR, stat.S_IFBLK,
                        stat.S_IFSOCK, stat.S_IFLNK):
            info = types.SimpleNamespace(
                filename="special", external_attr=(special | 0o600) << 16)
            with self.subTest(special=special), self.assertRaises(rc.ProvisionError):
                staging.validate_zip_infos(self.root, [info])

    def test_required_file_path_cannot_escape_base(self):
        with self.assertRaises(rc.ProvisionError) as raised:
            staging.check_required_files(
                self.root, [{"path": "../secret", "sha256": "x"}])
        self.assertEqual(raised.exception.code, rc.PATH_OUTSIDE_ROOT)

    def test_required_free_aggregates_per_volume(self):
        entries = [
            {"downloadVolumeId": "C:", "cacheVolumeId": "C:",
             "targetVolumeId": "D:", "downloadBytes": 10,
             "cacheBytes": 20, "stagingBytes": 30,
             "installBytes": 40, "rollbackBytes": 50},
            {"downloadVolumeId": "C:", "cacheVolumeId": "E:",
             "targetVolumeId": "D:", "downloadBytes": 1,
             "cacheBytes": 2, "stagingBytes": 3,
             "installBytes": 4, "rollbackBytes": 5},
        ]
        self.assertEqual(
            staging.required_free_by_volume(entries, reserve_bytes=100),
            {"C:": 131, "D:": 232, "E:": 102})

    def test_unknown_size_stops_capacity_plan(self):
        entry = {"downloadVolumeId": "C:", "cacheVolumeId": "C:",
                 "targetVolumeId": "D:", "downloadBytes": None,
                 "cacheBytes": 1, "stagingBytes": 2, "installBytes": 3,
                 "rollbackBytes": 4}
        with self.assertRaises(rc.ProvisionError) as raised:
            staging.required_free_by_volume([entry])
        self.assertEqual(raised.exception.code, rc.UNRESOLVED_COMPONENT)


class LayoutIdentifierTests(unittest.TestCase):
    def tearDown(self):
        rp.reset()

    def test_job_id_is_one_segment(self):
        rp.configure({
            "schemaVersion": 2,
            "runtimeRoot": {"path": "C:/af/rt", "ownership": "audioforge-managed"},
            "modelRoot": {"path": "C:/af/md", "ownership": "audioforge-managed"},
            "cacheRoot": {"path": "C:/af/ch", "ownership": "audioforge-managed"},
        })
        for bad in ("../escape", "a/b", "a\\b", ".", "", "CON", "bad."):
            with self.subTest(bad=bad), self.assertRaises(rc.ProvisionError) as raised:
                layout.staging_dir(bad)
            self.assertEqual(raised.exception.code, rc.PATH_OUTSIDE_ROOT)


if __name__ == "__main__":
    unittest.main(verbosity=2)
