"""Login HTTP checks use temporary data and never print cookie values."""
from datetime import datetime
from http.cookies import SimpleCookie
import json
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import models
from app.database import Base, get_db, enable_sqlite_foreign_keys
from app.security import hash_password, hash_session_token

with patch.object(Base.metadata, "create_all"):
    from app.main import app, SESSION_TTL_SECONDS


class LoginTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                                    poolclass=StaticPool)
        event.listen(self.engine, "connect", enable_sqlite_foreign_keys)
        Base.metadata.create_all(self.engine, tables=[models.User.__table__, models.AuthSession.__table__])
        self.sessions = sessionmaker(bind=self.engine)
        self.password = "test-only-login-password"
        with Session(self.engine) as db:
            user = models.User(username="login_user", password_hash=hash_password(self.password))
            db.add(user)
            db.commit()
            self.uid = user.id
        self.previous_overrides = app.dependency_overrides.copy()

        def test_db():
            with self.sessions() as db:
                yield db

        app.dependency_overrides[get_db] = test_db

    def tearDown(self):
        app.dependency_overrides.clear()
        app.dependency_overrides.update(self.previous_overrides)
        self.engine.dispose()

    async def login(self, payload, *, scheme="https", origin=None):
        body = json.dumps(payload).encode()
        headers = [(b"content-type", b"application/json"), (b"host", b"testserver")]
        if origin is not None:
            headers.append((b"origin", origin.encode()))
        messages = []

        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(message):
            messages.append(message)

        await app({
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "POST", "scheme": scheme, "path": "/auth/login",
            "raw_path": b"/auth/login", "query_string": b"", "root_path": "",
            "headers": headers, "client": ("127.0.0.1", 1), "server": ("testserver", 443),
        }, receive, send)
        start = next(m for m in messages if m["type"] == "http.response.start")
        output = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
        return start["status"], dict(start["headers"]), json.loads(output)

    async def test_login_sets_cookie_stores_hash_and_returns_public_data(self):
        for scheme in ("https", "http"):
            status, headers, output = await self.login(
                {"username": "  login_user  ", "password": self.password},
                scheme=scheme, origin=scheme + "://testserver")
            self.assertEqual(status, 200)
            self.assertEqual(set(output), {"user", "expires_at"})
            self.assertEqual(set(output["user"]), {"id", "username", "created_at"})
            self.assertEqual(output["user"]["id"], self.uid)
            self.assertEqual(headers[b"cache-control"], b"no-store")
            cookie = SimpleCookie()
            cookie.load(headers[b"set-cookie"].decode())
            entry = cookie["aleph_session"]
            self.assertTrue(bool(entry["httponly"]))
            self.assertEqual(bool(entry["secure"]), scheme == "https")
            self.assertEqual(entry["samesite"], "lax")
            self.assertEqual(entry["path"], "/")
            self.assertEqual(int(entry["max-age"]), SESSION_TTL_SECONDS)
            self.assertFalse(entry.value in json.dumps(output))
            self.assertFalse(self.password in json.dumps(output))
            with Session(self.engine) as db:
                row = db.query(models.AuthSession).filter_by(session_hash=hash_session_token(entry.value)).one()
                self.assertEqual(row.user_id, self.uid)
                self.assertEqual(row.expires_at, datetime.fromisoformat(output["expires_at"]))

    async def test_wrong_password_and_missing_user_create_no_sessions_or_cookies(self):
        results = []
        for name in ("login_user", "missing_user"):
            status, headers, output = await self.login({"username": name, "password": "test-only-wrong-password"})
            self.assertEqual(status, 401)
            self.assertNotIn(b"set-cookie", headers)
            results.append(output)
        self.assertEqual(results[0], results[1])
        with Session(self.engine) as db:
            self.assertEqual(db.query(models.AuthSession).count(), 0)

    async def test_cross_origin_login_rejected_before_creating_session(self):
        status, headers, _ = await self.login(
            {"username": "login_user", "password": self.password}, origin="https://other.example")
        self.assertEqual(status, 403)
        self.assertNotIn(b"set-cookie", headers)
        with Session(self.engine) as db:
            self.assertEqual(db.query(models.AuthSession).count(), 0)

    async def test_invalid_password_is_not_echoed(self):
        status, headers, output = await self.login({"username": "login_user", "password": "short-test"})
        self.assertEqual(status, 422)
        self.assertNotIn(b"set-cookie", headers)
        self.assertFalse("short-test" in json.dumps(output))
        with Session(self.engine) as db:
            self.assertEqual(db.query(models.AuthSession).count(), 0)
