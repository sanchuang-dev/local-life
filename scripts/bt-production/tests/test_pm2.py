"""No-server regression for Baota PM2 fork and boot ownership contracts."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bt_pm2', HERE / 'pm2-control.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Pm2Ownership(unittest.TestCase):
    def test_first_start_uses_tested_pm2_v7_fork_args(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            api = base / 'current/api'
            (api / 'dist').mkdir(parents=True)
            (api / 'dist/index.js').write_text('// fixture')
            (api / '.env').write_text('NODE_ENV=production')
            (base / 'ops').mkdir()
            (base / 'ops/baota-node-before-pm2.json').write_text('{}')
            calls = []
            with patch.object(module, 'BASE', base), patch.object(module, 'API', api), \
                    patch.object(module, 'SCRIPT', api / 'dist/index.js'), \
                    patch.object(module, 'managed', side_effect=[None, {'name': 'local_life_api'}]), \
                    patch.object(module, 'verify_current'), \
                    patch.object(module, 'call', side_effect=lambda *args: calls.append(args)):
                module.start()
            self.assertEqual(len(calls), 1)
            args = calls[0]
            self.assertEqual(args[:2], ('start', str(api / 'dist/index.js')))
            self.assertIn('--restart-delay', args)
            self.assertIn('--max-memory-restart', args)
            for invalid in ('--exec-mode', '--min-uptime', '--instances'):
                self.assertNotIn(invalid, args)

    def test_rejects_other_www_pm2_apps(self):
        with patch.object(module, 'call', return_value='[{"name":"unrelated"}]'):
            with self.assertRaisesRegex(RuntimeError, 'not dedicated'):
                module.managed()

    def test_systemd_guards_single_owner(self):
        service = (HERE / 'pm2-www.service').read_text()
        for requirement in ('User=www', 'Group=www', 'PM2_HOME=/home/www/.pm2',
                            'ExecStartPre=+', 'pm2 resurrect', 'pm2 kill'):
            self.assertIn(requirement, service)
        self.assertNotIn('/root/.pm2', service)


if __name__ == '__main__':
    unittest.main()
