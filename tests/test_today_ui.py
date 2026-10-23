"""실제 개인 DB 대신 메모리 DB로 화면과 연결 API를 검증한다."""
import json
import unittest
from datetime import date, datetime
from unittest.mock import patch
from urllib.parse import urlsplit

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models
from app.database import Base, enable_sqlite_foreign_keys, get_db

# main의 기존 create_all이 개인 DB를 건드리지 않도록 import 시에만 막는다.
with patch.object(Base.metadata, "create_all"):
    from app.main import app


class TodayUITest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        event.listen(self.engine, "connect", enable_sqlite_foreign_keys)
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine)

        def test_db():
            with self.sessions() as db:
                yield db

        app.dependency_overrides[get_db] = test_db

    def tearDown(self):
        app.dependency_overrides.clear()
        self.engine.dispose()

    async def request(self, method, path, payload=None):
        parsed = urlsplit(path)
        messages = []
        raw = json.dumps(payload).encode() if payload is not None else b""

        async def receive():
            return {"type": "http.request", "body": raw, "more_body": False}

        async def send(message):
            messages.append(message)

        await app({
            "type": "http", "asgi": {"version": "3.0"},
            "http_version": "1.1", "method": method, "scheme": "http",
            "path": parsed.path, "raw_path": parsed.path.encode(),
            "query_string": parsed.query.encode(),
            "root_path": "", "headers": [(b"content-type", b"application/json")],
            "client": ("127.0.0.1", 1), "server": ("test", 80),
        }, receive, send)
        start = next(m for m in messages if m["type"] == "http.response.start")
        body = b"".join(m.get("body", b"") for m in messages
                        if m["type"] == "http.response.body")
        return start["status"], dict(start["headers"]), body

    async def test_home_and_static_assets(self):
        status, headers, body = await self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"text/html", headers[b"content-type"])
        self.assertIn('id="task-form"', body.decode())
        for path in ("/static/planner.css", "/static/planner.js", "/static/insights.js", "/static/review.js", "/static/notes.js"):
            status, _, body = await self.request("GET", path)
            self.assertEqual(status, 200)
            self.assertTrue(body)

    async def test_today_create_complete_reopen_and_reload(self):
        today = date.today().isoformat()
        status, _, body = await self.request("POST", "/plans", {
            "title": "Test plan", "category": "study", "start_date": today,
            "end_date": today, "priority": "HIGH", "success_criteria": "done",
            "expected_minutes": 30,
        })
        self.assertEqual(status, 200)
        pid = json.loads(body)["id"]
        status, _, body = await self.request("POST", "/tasks", {
            "plan_id": pid, "title": "<script>alert(1)</script>",
            "scheduled_date": today, "priority": "HIGH", "expected_minutes": 25,
        })
        self.assertEqual(status, 200)
        tid = json.loads(body)["id"]
        for action, expected in (("complete", "DONE"), ("complete", "DONE"),
                                 ("reopen", "TODO")):
            status, _, body = await self.request("PATCH", f"/tasks/{tid}/{action}")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["status"], expected)
        status, _, body = await self.request("GET", "/tasks/today")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)[0]["title"], "<script>alert(1)</script>")
        with self.sessions() as db:
            self.assertEqual(db.get(models.Task, tid).status, "TODO")
            self.assertEqual(db.query(models.Execution).count(), 0)

    def seed_period_records(self):
        """Boundary days, outside days and another Plan catch scope leaks."""
        with self.sessions() as db:
            plans = [models.Plan(title=title, category="study", start_date=date(2026, 1, 1),
                                 end_date=date(2026, 1, 31), priority="HIGH",
                                 success_criteria="done", expected_minutes=999)
                     for title in ("period", "other", "empty")]
            db.add_all(plans)
            db.flush()
            tasks = []
            for pid, day, minutes, status in [
                (plans[0].id, 9, 100, "TODO"), (plans[0].id, 10, 10, "DONE"),
                (plans[0].id, 20, 20, "TODO"), (plans[0].id, 21, 200, "TODO"),
                (plans[1].id, 10, 900, "DONE"),
            ]:
                task = models.Task(plan_id=pid, title=f"day {day}", scheduled_date=date(2026, 1, day),
                                   due_date=date(2020, 1, 1), priority="HIGH",
                                   expected_minutes=minutes, status=status)
                db.add(task)
                db.flush()
                tasks.append(task)
            # Records outside the selected days still count for selected Tasks.
            for index, minutes, reason in [(0, 100, "outside"), (1, 7, "A"),
                                           (1, 8, "B"), (2, None, "  "),
                                           (2, 0, None), (3, 200, "outside"), (4, 900, "other")]:
                db.add(models.Execution(task_id=tasks[index].id, actual_minutes=minutes,
                                        blocked_reason=reason, created_at=datetime(2025, 12, 1)))
            db.commit()
            return [p.id for p in plans], [t.id for t in tasks]

    async def period_get(self, path):
        status, _, body = await self.request("GET", path)
        self.assertEqual(status, 200, body)
        return json.loads(body)

    async def test_period_summary_and_evidence_share_inclusive_task_dates(self):
        plans, tasks = self.seed_period_records()
        period = "start_date=2026-01-10&end_date=2026-01-20"
        data = await self.period_get(f"/plans/{plans[0]}/summary?{period}")
        for key, value in {"task_count": 2, "completed_task_count": 1, "completion_rate": 50,
                           "overdue_task_count": 1, "blocked_task_count": 1,
                           "expected_minutes": 30, "actual_minutes": 15,
                           "difference_minutes": -15}.items():
            self.assertEqual(data[key], value, key)
        for extra, expected_ids in [("", tasks[1:3]), ("&status=DONE", [tasks[1]]),
                                    ("&overdue_only=true", [tasks[2]]),
                                    ("&blocked_only=true", [tasks[1]]),
                                    ("&keyword=day&priority=HIGH&sort_by=expected_minutes&order=desc", [tasks[2], tasks[1]])]:
            rows = await self.period_get(f"/tasks?plan_id={plans[0]}&{period}{extra}")
            self.assertEqual([r['id'] for r in rows], expected_ids)
        records = await self.period_get(f"/plans/{plans[0]}/executions?{period}")
        self.assertEqual(len(records), 4)
        self.assertEqual({r['task_id'] for r in records}, set(tasks[1:3]))
        self.assertEqual(sum(r['actual_minutes'] or 0 for r in records), 15)

    async def test_period_open_bounds_same_day_empty_and_unfiltered(self):
        plans, _ = self.seed_period_records()
        for period, count, expected, actual in [
            ("", 4, 330, 315), ("start_date=2026-01-20", 2, 220, 200),
            ("end_date=2026-01-10", 2, 110, 115),
            ("start_date=2026-01-10&end_date=2026-01-10", 1, 10, 15),
            ("start_date=2027-01-01&end_date=2027-01-02", 0, 0, 0),
        ]:
            data = await self.period_get(f"/plans/{plans[0]}/summary?{period}")
            self.assertEqual((data['task_count'], data['expected_minutes'], data['actual_minutes']),
                             (count, expected, actual))
        empty = await self.period_get(f"/plans/{plans[2]}/summary?start_date=2026-01-10")
        self.assertEqual(empty['task_count'], 0)
        self.assertEqual(empty['completion_rate'], 0)

    async def test_period_invalid_dates_rejected_without_data_changes(self):
        plans, _ = self.seed_period_records()
        before = await self.period_get('/export')
        for path in ['/tasks', f'/plans/{plans[0]}/summary', f'/plans/{plans[0]}/executions']:
            for query in ['start_date=2026-01-20&end_date=2026-01-10',
                          'start_date=2026-02-30', 'end_date=bad']:
                status, _, _ = await self.request('GET', path + '?' + query)
                self.assertEqual(status, 422, (path, query))
        self.assertEqual(await self.period_get('/export'), before)

    async def test_period_queries_preserve_export_and_missing_plan_behavior(self):
        plans, _ = self.seed_period_records()
        before = await self.period_get('/export')
        for path in ['/tasks', f'/plans/{plans[0]}/summary', f'/plans/{plans[0]}/executions']:
            await self.period_get(path + '?start_date=2026-01-10&end_date=2026-01-20')
        for suffix in ['summary', 'executions']:
            status, _, _ = await self.request('GET', f'/plans/99999/{suffix}?start_date=2026-01-10')
            self.assertEqual(status, 404)
        self.assertEqual(await self.period_get('/tasks?plan_id=99999&start_date=2026-01-10'), [])
        self.assertEqual(await self.period_get('/export'), before)


if __name__ == "__main__":
    unittest.main()
