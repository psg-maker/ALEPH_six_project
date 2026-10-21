"""Migration checks use disposable databases, never planner.db or Neon."""
import unittest
from uuid import uuid4
from datetime import date, datetime
from pathlib import Path

from sqlalchemy import create_engine, event, select

from app.database import Base, enable_sqlite_foreign_keys
from app import models
from scripts.migrate_to_neon import copy_snapshot, read_snapshot


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp_root = Path(__file__).resolve().parents[1] / "backups"
        self.temp_root.mkdir(exist_ok=True)
        self.temp_dir = self.temp_root / ("migration-test-" + uuid4().hex)
        self.temp_dir.mkdir()
        self.path = self.temp_dir / "source.db"
        self.source = create_engine("sqlite:///" + self.path.as_posix())
        Base.metadata.create_all(self.source)
        stamp = datetime(2026, 10, 21, 10, 20, 30)
        with self.source.begin() as conn:
            conn.execute(models.Plan.__table__.insert(), [dict(
                id=i, title=f"Plan {i}", category="study", start_date=date(2026, 10, 21),
                end_date=date(2026, 10, 22), priority="HIGH", success_criteria="done",
                expected_minutes=90, created_at=stamp, updated_at=stamp,
            ) for i in (7, 12)])
            conn.execute(models.Task.__table__.insert(), dict(
                id=23, plan_id=7, title="Task", scheduled_date=date(2026, 10, 21),
                priority="HIGH", expected_minutes=30, created_at=stamp, updated_at=stamp,
            ))
            conn.execute(models.Execution.__table__.insert(), dict(
                id=31, task_id=23, actual_minutes=0, blocked_reason="reason", created_at=stamp,
            ))
            conn.execute(models.TaskLink.__table__.insert(), dict(
                id=41, task_id=23, label="Link", url="https://example.com", created_at=stamp,
            ))
            conn.execute(models.Review.__table__.insert(), dict(
                id=51, plan_id=7, improvement="improve", next_plan_id=12,
                created_at=stamp, updated_at=stamp,
            ))
            conn.execute(models.PlanVersion.__table__.insert(), dict(
                id=61, plan_id=7, version_no=1, title="Before", category="study",
                start_date=date(2026, 10, 21), end_date=date(2026, 10, 22), priority="HIGH",
                success_criteria="done", expected_minutes=60, status="ACTIVE", changed_at=stamp,
            ))
            conn.execute(models.DailyNote.__table__.insert(), dict(
                id=71, note_date=date(2026, 10, 21), content="Note",
                created_at=stamp, updated_at=stamp,
            ))
        self.source.dispose()
        self.target = create_engine("sqlite://")
        event.listen(self.target, "connect", enable_sqlite_foreign_keys)

    def tearDown(self):
        self.target.dispose()
        assert self.temp_dir.resolve().is_relative_to(self.temp_root.resolve())
        self.path.unlink()
        self.temp_dir.rmdir()

    def test_preserves_all_values_links_and_source(self):
        before = self.path.read_bytes()
        snapshot = read_snapshot(self.path)
        with self.target.begin() as conn:
            counts = copy_snapshot(conn, snapshot)
        self.assertEqual(sum(counts.values()), 8)
        with self.target.connect() as conn:
            for table in Base.metadata.sorted_tables:
                actual = [dict(r) for r in conn.execute(select(table).order_by(table.c.id)).mappings()]
                self.assertEqual(actual, snapshot[table.name])
        self.assertEqual(self.path.read_bytes(), before)

    def test_refuses_target_with_existing_tables(self):
        Base.metadata.create_all(self.target)
        with self.target.begin() as conn:
            with self.assertRaisesRegex(ValueError, "not empty"):
                copy_snapshot(conn, read_snapshot(self.path))

    def test_failed_insert_rolls_back_all_rows(self):
        def fail_execution(conn, cursor, statement, parameters, context, many):
            if statement.startswith("INSERT INTO executions"):
                raise RuntimeError("Injected failure")

        event.listen(self.target, "before_cursor_execute", fail_execution)
        with self.assertRaisesRegex(RuntimeError, "Injected failure"):
            with self.target.begin() as conn:
                copy_snapshot(conn, read_snapshot(self.path))
        event.remove(self.target, "before_cursor_execute", fail_execution)
        with self.target.connect() as conn:
            for table in Base.metadata.sorted_tables:
                self.assertEqual(conn.execute(select(table)).all(), [])
