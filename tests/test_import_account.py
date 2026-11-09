"""Account imports use disposable databases, never the real source or Neon."""
from sqlalchemy import event, select, update

from app import models
from app.database import Base
from scripts.import_account_to_neon import select_account, import_account, save_backup
from scripts.migrate_to_neon import read_snapshot
from tests import test_migrate_to_neon as fixtures


class AccountImportTest(fixtures.MigrationTest):
    def setUp(self):
        super().setUp()
        with self.source.begin() as conn:
            conn.execute(models.User.__table__.insert(), [
                dict(id=1, username="owner", password_hash="stored-hash"),
                dict(id=2, username="other", password_hash="other-hash"),
            ])
            conn.execute(update(models.Plan).values(user_id=1))
            conn.execute(update(models.DailyNote).values(user_id=1))
        Base.metadata.create_all(self.target)
        with self.target.begin() as conn:
            conn.execute(models.User.__table__.insert(), dict(
                id=1, username="existing", password_hash="untouched"))
            plan = read_snapshot(self.path)["plans"][0].copy()
            plan["user_id"] = None
            conn.execute(models.Plan.__table__.insert(), plan)

    def tearDown(self):
        self.source.dispose()
        super().tearDown()

    # The inherited checks target the older empty-DB importer.
    test_preserves_all_values_links_and_source = None
    test_refuses_target_with_existing_tables = None
    test_failed_insert_rolls_back_all_rows = None

    def test_import_preserves_existing_data_and_remaps_relationships(self):
        before = self.path.read_bytes()
        snapshot = select_account(read_snapshot(self.path), "owner")
        with self.target.begin() as conn:
            counts = import_account(conn, snapshot)
        self.assertEqual(counts["plans"], 2)
        with self.target.connect() as conn:
            users = conn.execute(select(models.User.__table__).order_by(models.User.id)).mappings().all()
            self.assertEqual([(r["username"], r["password_hash"]) for r in users],
                             [("existing", "untouched"), ("owner", "stored-hash")])
            plans = conn.execute(select(models.Plan.__table__).order_by(models.Plan.id)).mappings().all()
            self.assertEqual(plans[0]["id"], 7)
            self.assertIsNone(plans[0]["user_id"])
            self.assertTrue(all(p["user_id"] == users[1]["id"] for p in plans[1:]))
            review = conn.execute(select(models.Review.__table__)).mappings().one()
            self.assertEqual(review["plan_id"], plans[1]["id"])
            self.assertEqual(review["next_plan_id"], plans[2]["id"])
            self.assertEqual(conn.execute(select(models.AuthSession.__table__)).all(), [])
        self.assertEqual(self.path.read_bytes(), before)

    def test_repeated_import_is_rejected(self):
        snapshot = select_account(read_snapshot(self.path), "owner")
        with self.target.begin() as conn:
            import_account(conn, snapshot)
        with self.assertRaisesRegex(ValueError, "already exists"):
            with self.target.begin() as conn:
                import_account(conn, snapshot)

    def test_selects_only_requested_account(self):
        snapshot = select_account(read_snapshot(self.path), "other")
        self.assertEqual(len(snapshot["users"]), 1)
        self.assertTrue(all(not rows for name, rows in snapshot.items() if name != "users"))

    def test_backup_round_trips_every_value(self):
        snapshot = read_snapshot(self.path)
        path = save_backup(snapshot, "test")
        try:
            self.assertEqual(read_snapshot(path), snapshot)
        finally:
            path.unlink()

    def test_unknown_account_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "exactly once"):
            select_account(read_snapshot(self.path), "missing")

    def test_failed_import_rolls_back_without_changing_existing_rows(self):
        def fail(conn, cursor, statement, parameters, context, many):
            if statement.startswith("INSERT INTO executions"):
                raise RuntimeError("Injected failure")
        event.listen(self.target, "before_cursor_execute", fail)
        with self.assertRaisesRegex(RuntimeError, "Injected failure"):
            with self.target.begin() as conn:
                import_account(conn, select_account(read_snapshot(self.path), "owner"))
        with self.target.connect() as conn:
            self.assertEqual(len(conn.execute(select(models.User.__table__)).all()), 1)
            self.assertEqual(len(conn.execute(select(models.Plan.__table__)).all()), 1)

    def test_rejects_review_link_to_another_accounts_plan(self):
        with self.source.begin() as conn:
            conn.execute(update(models.Plan).where(models.Plan.id == 12).values(user_id=2))
        with self.assertRaisesRegex(ValueError, "outside"):
            select_account(read_snapshot(self.path), "owner")
