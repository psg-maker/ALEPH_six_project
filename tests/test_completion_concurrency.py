"""Repeated completion must keep one Task completion, even across DB sessions."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
import threading
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app.database import Base

with patch.object(Base.metadata, "create_all"):
    from app.main import complete_task, reopen_task, get_plan_summary


class CompletionConcurrencyTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.engine = create_engine(
            "sqlite:///" + (Path(self.temp.name) / "completion.db").as_posix(),
            connect_args={"check_same_thread": False, "timeout": 10},
        )
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine)
        with self.sessions() as db:
            plan = models.Plan(title="plan", category="study", start_date=date(2026, 1, 1),
                               end_date=date(2026, 1, 2), priority="HIGH",
                               success_criteria="done", expected_minutes=30)
            db.add(plan)
            db.flush()
            task = models.Task(plan_id=plan.id, title="task", scheduled_date=date(2026, 1, 1),
                               priority="HIGH", expected_minutes=30)
            db.add(task)
            db.flush()
            db.add(models.Execution(task_id=task.id, actual_minutes=7, memo="original"))
            db.commit()
            self.tid, self.pid = task.id, plan.id

    def tearDown(self):
        self.engine.dispose()
        self.temp.cleanup()

    def test_simultaneous_completions_preserve_one_timestamp_and_count(self):
        barrier = Barrier(2)

        def worker(index):
            with self.sessions() as db:
                return complete_task(self.tid, db)

        clocks = threading.local()

        def timed_worker(index):
            clocks.index = index
            return worker(index)

        def concurrent_clock():
            # Both requests read TODO before either can update the real DB.
            barrier.wait(timeout=10)
            return datetime(2026, 1, 1, 12) + timedelta(seconds=clocks.index)

        with patch("app.main.now_in_seoul", side_effect=concurrent_clock):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(timed_worker, (0, 1)))

        self.assertEqual(results[0]["completed_at"], results[1]["completed_at"])
        with self.sessions() as db:
            task = db.get(models.Task, self.tid)
            self.assertEqual(task.completed_at, results[0]["completed_at"])
            self.assertEqual(db.query(models.Task).filter_by(status="DONE").count(), 1)
            summary = get_plan_summary(self.pid, [], db)
            self.assertEqual(summary["completed_task_count"], 1)
            self.assertEqual(summary["actual_minutes"], 7)
            self.assertEqual(db.query(models.Execution).count(), 1)
            self.assertEqual(task.expected_minutes, 30)
            # A later retry leaves the same completion; reopen allows a new one.
            self.assertEqual(complete_task(self.tid, db)["completed_at"], task.completed_at)
            reopen_task(self.tid, db)
            self.assertIsNone(db.get(models.Task, self.tid).completed_at)
            again = complete_task(self.tid, db)
            self.assertEqual(again["status"], "DONE")
            self.assertEqual(db.query(models.Execution).count(), 1)
