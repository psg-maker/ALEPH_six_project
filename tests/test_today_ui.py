"""실제 개인 DB 대신 메모리 DB로 화면과 연결 API를 검증한다."""
import json
import unittest
from datetime import date
from unittest.mock import patch

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
        messages = []
        raw = json.dumps(payload).encode() if payload is not None else b""

        async def receive():
            return {"type": "http.request", "body": raw, "more_body": False}

        async def send(message):
            messages.append(message)

        await app({
            "type": "http", "asgi": {"version": "3.0"},
            "http_version": "1.1", "method": method, "scheme": "http",
            "path": path, "raw_path": path.encode(), "query_string": b"",
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
        for path in ("/static/planner.css", "/static/planner.js"):
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


if __name__ == "__main__":
    unittest.main()
