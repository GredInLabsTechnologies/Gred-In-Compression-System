"""
Regression tests for GICS 1.3.5 — Python SDK stdio pollution.

Covers the bug where GICSDaemonSupervisor.start() inherited the parent's
stdout/stderr, corrupting the protocol stream of any MCP / LSP / JSON-RPC
stdio host that embedded the SDK.

Run with: python -m unittest clients/python/test_gics_client.py
"""

import os
import subprocess
import tempfile
import unittest
from unittest import mock

import gics_client as gc


class FakeProcess:
    def __init__(self):
        self._alive = True

    def poll(self):
        return None if self._alive else 0

    def terminate(self):
        self._alive = False

    def wait(self, timeout=None):
        self._alive = False
        return 0

    def kill(self):
        self._alive = False


class DaemonSupervisorStdioTests(unittest.TestCase):
    def _make_supervisor(self, tmpdir, log_path=None):
        return gc.GICSDaemonSupervisor(
            node_executable='node',
            cli_path=os.path.join(tmpdir, 'fake-cli.js'),
            cwd=tmpdir,
            address='ignored',
            token_path=os.path.join(tmpdir, 'gics.token'),
            data_path=os.path.join(tmpdir, 'data'),
            log_path=log_path,
        )

    def test_popen_is_called_with_redirected_stdio(self):
        """start() must pipe stdout/stderr to a log file and stdin to DEVNULL."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Touch fake CLI so cli_path check passes.
            open(os.path.join(tmpdir, 'fake-cli.js'), 'w').close()
            sup = self._make_supervisor(tmpdir)

            with mock.patch.object(gc.subprocess, 'Popen', return_value=FakeProcess()) as popen, \
                 mock.patch.object(sup, 'wait_until_ready', return_value=True):
                sup.start(wait=True, timeout=1.0)

            popen.assert_called_once()
            _, kwargs = popen.call_args
            self.assertIn('stdout', kwargs)
            self.assertIn('stderr', kwargs)
            self.assertIn('stdin', kwargs)
            # stdout must be the writable log file handle, not inherited.
            self.assertTrue(hasattr(kwargs['stdout'], 'write'))
            self.assertEqual(kwargs['stderr'], subprocess.STDOUT)
            self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)

            sup.stop()

    def test_default_log_path_lives_under_data_path(self):
        """Default log_path must live under data_path/logs to avoid cwd pollution."""
        with tempfile.TemporaryDirectory() as tmpdir:
            data_path = os.path.join(tmpdir, 'data')
            sup = gc.GICSDaemonSupervisor(
                cli_path=os.path.join(tmpdir, 'fake-cli.js'),
                cwd=tmpdir,
                address='ignored',
                token_path=os.path.join(tmpdir, 'gics.token'),
                data_path=data_path,
            )
            self.assertEqual(sup.log_path, os.path.join(data_path, 'logs', 'gics_daemon.log'))

    def test_custom_log_path_is_honoured(self):
        """Explicit log_path kwarg must override the default."""
        with tempfile.TemporaryDirectory() as tmpdir:
            custom = os.path.join(tmpdir, 'custom', 'daemon.log')
            sup = gc.GICSDaemonSupervisor(
                cli_path=os.path.join(tmpdir, 'fake-cli.js'),
                cwd=tmpdir,
                address='ignored',
                data_path=os.path.join(tmpdir, 'data'),
                log_path=custom,
            )
            self.assertEqual(sup.log_path, custom)

    def test_log_dir_is_created_and_log_file_opened(self):
        """start() must create the log dir and open the file for appending."""
        with tempfile.TemporaryDirectory() as tmpdir:
            open(os.path.join(tmpdir, 'fake-cli.js'), 'w').close()
            sup = self._make_supervisor(tmpdir)
            self.assertFalse(os.path.exists(os.path.dirname(sup.log_path)))

            with mock.patch.object(gc.subprocess, 'Popen', return_value=FakeProcess()), \
                 mock.patch.object(sup, 'wait_until_ready', return_value=True):
                sup.start(wait=True, timeout=1.0)

            try:
                self.assertTrue(os.path.isdir(os.path.dirname(sup.log_path)))
                self.assertTrue(os.path.isfile(sup.log_path))
                self.assertIsNotNone(sup._log_fh)
            finally:
                sup.stop()

    def test_stop_closes_log_file_handle(self):
        """stop() must close the log fh and reset to None, even on normal exit."""
        with tempfile.TemporaryDirectory() as tmpdir:
            open(os.path.join(tmpdir, 'fake-cli.js'), 'w').close()
            sup = self._make_supervisor(tmpdir)

            with mock.patch.object(gc.subprocess, 'Popen', return_value=FakeProcess()), \
                 mock.patch.object(sup, 'wait_until_ready', return_value=True):
                sup.start(wait=True, timeout=1.0)

            fh = sup._log_fh
            self.assertIsNotNone(fh)
            sup.stop()
            self.assertIsNone(sup._log_fh)
            self.assertTrue(fh.closed)

    def test_stop_closes_log_even_when_process_already_exited(self):
        """Even if the daemon already exited, stop() must still close the log fh."""
        with tempfile.TemporaryDirectory() as tmpdir:
            open(os.path.join(tmpdir, 'fake-cli.js'), 'w').close()
            sup = self._make_supervisor(tmpdir)

            dead_proc = FakeProcess()
            dead_proc._alive = False

            with mock.patch.object(gc.subprocess, 'Popen', return_value=dead_proc), \
                 mock.patch.object(sup, 'wait_until_ready', return_value=True):
                sup.start(wait=True, timeout=1.0)

            fh = sup._log_fh
            self.assertIsNotNone(fh)
            sup.stop()
            self.assertIsNone(sup._log_fh)
            self.assertTrue(fh.closed)


if __name__ == '__main__':
    unittest.main()
