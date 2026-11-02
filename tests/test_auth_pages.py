"""HTML authentication entry points; importing the app must not change the local DB."""
import unittest
from datetime import timedelta
from unittest.mock import patch

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import models
from app.database import Base, get_db, enable_sqlite_foreign_keys
from app.security import generate_session_token, hash_session_token
from app.time_utils import now_in_seoul

with patch.object(Base.metadata, "create_all"):
    from app.main import app


class AuthPageTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        event.listen(self.engine, "connect", enable_sqlite_foreign_keys)
        Base.metadata.create_all(self.engine)
        self.token = generate_session_token()
        now = now_in_seoul()
        with Session(self.engine) as db:
            user = models.User(username="page_owner", password_hash="disabled-test-account")
            db.add(user)
            db.flush()
            db.add(models.AuthSession(
                user_id=user.id, session_hash=hash_session_token(self.token),
                created_at=now, expires_at=now + timedelta(hours=1),
            ))
            db.commit()

        self.previous_overrides = app.dependency_overrides.copy()

        def test_db():
            with Session(self.engine) as db:
                yield db

        app.dependency_overrides[get_db] = test_db

    def tearDown(self):
        app.dependency_overrides.clear()
        app.dependency_overrides.update(self.previous_overrides)
        self.engine.dispose()

    async def request(self, path, token=None):
        messages = []
        request_headers = [(b"host", b"testserver")]
        if token is not None:
            request_headers.append((b"cookie", ("aleph_session=" + token).encode()))

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            messages.append(message)

        await app({
            "type": "http", "asgi": {"version": "3.0"},
            "http_version": "1.1", "method": "GET", "scheme": "http",
            "path": path, "raw_path": path.encode(), "query_string": b"",
            "root_path": "", "headers": request_headers,
            "client": ("127.0.0.1", 1), "server": ("testserver", 80),
        }, receive, send)

        start = next(m for m in messages if m["type"] == "http.response.start")
        headers = dict(start["headers"])
        body = b"".join(m.get("body", b"") for m in messages
                        if m["type"] == "http.response.body").decode()
        return start["status"], headers, body

    async def test_login_page_renders_form_without_loading_planner(self):
        status, headers, body = await self.request("/login")
        self.assertEqual(status, 200)
        self.assertIn(b"text/html", headers[b"content-type"])
        self.assertEqual(headers.get(b"cache-control"), b"no-store")
        self.assertIn('id="auth-form"', body)
        self.assertIn('type="password"', body)
        self.assertNotIn("planner.js", body)

    async def test_home_redirects_visitor_to_login_without_rendering_planner(self):
        status, headers, body = await self.request("/")
        self.assertEqual(status, 303)
        self.assertEqual(headers.get(b"location"), b"/login")
        self.assertEqual(headers.get(b"cache-control"), b"no-store")
        self.assertNotIn('id="task-form"', body)

    async def test_login_redirects_authenticated_user_to_home(self):
        status, headers, body = await self.request("/login", self.token)
        self.assertEqual(status, 303)
        self.assertEqual(headers.get(b"location"), b"/")
        self.assertEqual(headers.get(b"cache-control"), b"no-store")
        self.assertNotIn('id="auth-form"', body)
