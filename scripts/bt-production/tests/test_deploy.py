"""Focused regression tests for release safety, no production connections."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy.py'
spec = importlib.util.spec_from_file_location('local_life_bt_deploy', SCRIPT)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class BaotaDeploymentContracts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def create_journal(self, name, tags):
        path = self.root / name / 'db/migrations'
        (path / 'meta').mkdir(parents=True, exist_ok=True)
        (path / 'meta/_journal.json').write_text(
            json.dumps({'entries': [{'tag': tag} for tag in tags]})
        )
        for tag in tags:
            (path / (tag + '.sql')).write_text('create table ' + tag + ' (id integer);')
        return self.root / name

    def test_migration_history_equal_is_no_schema_change(self):
        old = self.create_journal('old', ['0000_first', '0001_second'])
        new = self.create_journal('new', ['0000_first', '0001_second'])
        self.assertFalse(deploy.compare_migrations(old, new))

    def test_migration_addition_is_detected(self):
        old = self.create_journal('old', ['0000_first'])
        new = self.create_journal('new', ['0000_first', '0001_second'])
        self.assertTrue(deploy.compare_migrations(old, new))

    def test_migration_downgrade_is_blocked(self):
        old = self.create_journal('old', ['0000_first', '0001_second'])
        new = self.create_journal('new', ['0000_first'])
        with self.assertRaisesRegex(deploy.ReleaseError, 'downgrade'):
            deploy.compare_migrations(old, new)

    def test_editing_old_migration_is_blocked(self):
        old = self.create_journal('old', ['0000_first'])
        new = self.create_journal('new', ['0000_first'])
        (new / 'db/migrations/0000_first.sql').write_text('DROP TABLE important;')
        with self.assertRaisesRegex(deploy.ReleaseError, 'SQL changed'):
            deploy.compare_migrations(old, new)

    def test_reordered_migration_is_blocked(self):
        old = self.create_journal('old', ['0000_first', '0001_second'])
        new = self.create_journal('new', ['0001_second', '0000_first'])
        with self.assertRaisesRegex(deploy.ReleaseError, 'rewritten'):
            deploy.compare_migrations(old, new)

    def test_static_publish_retains_old_assets_and_updates_index_last(self):
        old = self.root / 'live'
        new = self.root / 'new'
        for path in (old / 'assets', new / 'assets'):
            path.mkdir(parents=True)
        (old / 'index.html').write_text('old index')
        (old / 'assets/old.js').write_text('old hashed asset')
        (new / 'index.html').write_text('new index')
        (new / 'assets/new.js').write_text('new hashed asset')
        order = []
        original = deploy.atomic_copy

        def observed(src, dest, sha):
            order.append(dest.relative_to(old).as_posix())
            original(src, dest, sha)

        with patch.object(deploy, 'atomic_copy', observed):
            deploy.write_static(new, old, 'a'*40)
        self.assertEqual(order, ['assets/new.js', 'index.html'])
        self.assertEqual((old / 'index.html').read_text(), 'new index')
        self.assertTrue((old / 'assets/old.js').exists())

    def test_static_rollback_restores_panel_hidden_files(self):
        www = self.root / 'www'
        snapshot = self.root / 'backups'
        for domain in deploy.DOMAINS.values():
            live = www / domain
            live.mkdir(parents=True)
            (live / 'index.html').write_text('v2')
        for area in deploy.DOMAINS:
            old = snapshot / ('site-' + area)
            old.mkdir(parents=True)
            (old / 'index.html').write_text('v1')
            (old / '.user.ini').write_text('BT panel setting')
        with patch.object(deploy, 'WEBROOT', www):
            deploy.restore_static(snapshot, 'a'*40)
        for domain in deploy.DOMAINS.values():
            self.assertEqual((www / domain / 'index.html').read_text(), 'v1')
            self.assertEqual((www / domain / '.user.ini').read_text(), 'BT panel setting')

    def test_reject_hidden_or_symlink_new_assets(self):
        target = self.root / 'target'
        new = self.root / 'new'
        target.mkdir()
        new.mkdir()
        (new / 'index.html').write_text('index')
        (new / '.env').write_text('secret')
        with self.assertRaisesRegex(deploy.ReleaseError, 'Unexpected public asset'):
            deploy.write_static(new, target, 'a'*40)
        (new / '.env').unlink()
        (new / 'assets').mkdir()
        (new / 'assets/out.js').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(deploy.ReleaseError, 'Unexpected public asset'):
            deploy.write_static(new, target, 'a'*40)

    def test_static_copy_never_overwrites_index_partially(self):
        new = self.root / 'new.txt'
        dest = self.root / 'index.html'
        new.write_text('new')
        dest.write_text('old')
        deploy.atomic_copy(new, dest, 'a'*40)
        self.assertEqual(dest.read_text(), 'new')
        self.assertFalse(list(self.root.glob('*.tmp')))


if __name__ == '__main__':
    unittest.main()


class CutoverFailureRegression(unittest.TestCase):
    """Exercise the full error handler with production-shaped throwaway paths."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.base = self.root / 'local-life'
        (self.base / 'releases').mkdir(parents=True)
        (self.base / 'backups').mkdir()
        (self.base / 'ops').mkdir()
        (self.base / 'shared/data').mkdir(parents=True)
        self.oldsha = 'a' * 40
        self.newsha = 'b' * 40
        self.old = self.base / 'releases' / self.oldsha
        self.new = self.base / 'releases' / self.newsha
        for rel in (self.old, self.new):
            (rel / 'api').mkdir(parents=True)
            for area in deploy.DOMAINS:
                (rel / area).mkdir()
                (rel / area / 'index.html').write_text(rel.name[:1])
        (self.base / 'current').symlink_to(self.old)
        self.public = self.root / 'public'
        for domain in deploy.DOMAINS.values():
            path = self.public / domain
            path.mkdir(parents=True)
            (path / 'index.html').write_text('a')
        self.incoming = self.base / 'incoming' / self.newsha
        self.incoming.mkdir(parents=True)

    def run_cutover(self, schema_changed):
        from contextlib import ExitStack

        calls = []

        def snapshot(_, target):
            target.write_text('snapshot fixture')

        def panel(_, action):
            calls.append(action)

        def fake_node(*args, **kwargs):
            if len(args) >= 5 and args[1:3] == ('verify-db.mjs', 'backup'):
                Path(args[4]).write_text('verified recovery backup fixture')

        def break_public(*args):
            raise deploy.ReleaseError('Injected post-switch public failure')

        with ExitStack() as stack:
            for key, value in (
                ('BASE', self.base),
                ('WEBROOT', self.public),
                ('DB', self.base / 'shared/data/local-life.sqlite'),
                ('CURRENT', self.base / 'current'),
            ):
                stack.enter_context(patch.object(deploy, key, value))
            stack.enter_context(patch.object(deploy.os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(deploy.os, 'chown'))
            stack.enter_context(patch.object(deploy.pwd, 'getpwnam'))
            stack.enter_context(patch.object(deploy, 'check_sha_and_archives', return_value=self.incoming))
            stack.enter_context(patch.object(deploy, 'prepare_release', return_value=self.new))
            stack.enter_context(patch.object(deploy, 'check_native'))
            stack.enter_context(patch.object(deploy, 'compare_migrations', return_value=schema_changed))
            stack.enter_context(patch.object(deploy, 'snapshot', side_effect=snapshot))
            stack.enter_context(patch.object(deploy, 'migrate'))
            stack.enter_context(patch.object(deploy, 'trial_api'))
            stack.enter_context(patch.object(deploy, 'harden_backup'))
            stack.enter_context(patch.object(deploy, 'node_at', side_effect=fake_node))
            stack.enter_context(patch.object(deploy, 'pm2_action', side_effect=panel))
            stack.enter_context(patch.object(deploy, 'health'))
            stack.enter_context(patch.object(deploy, 'validate_public', side_effect=break_public))
            with self.assertRaisesRegex(deploy.ReleaseError, 'Injected post-switch'):
                deploy.deploy(self.newsha)
        return calls

    def test_schema_unchanged_rolls_back_program_and_site(self):
        calls = self.run_cutover(False)
        self.assertEqual((self.base / 'current').resolve(), self.old)
        self.assertEqual(calls[-2:], ['start', 'save'])
        for d in deploy.DOMAINS.values():
            self.assertEqual((self.public / d / 'index.html').read_text(), 'a')
        self.assertFalse((self.base / 'ops/manual-recovery-required').exists())
        self.assertTrue((self.base / 'backups' / ('release-' + self.newsha) / 'database.sqlite').exists())

    def test_schema_upgrade_failure_halts_and_requires_review(self):
        calls = self.run_cutover(True)
        self.assertTrue((self.base / 'ops/manual-recovery-required').exists())
        self.assertEqual(calls[-1], 'stop')
        self.assertEqual((self.base / 'current').resolve(), self.new)
        self.assertTrue((self.base / 'backups' / ('release-' + self.newsha) / 'database.sqlite').exists())
