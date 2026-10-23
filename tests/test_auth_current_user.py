"""Current-user lookup and logout checks use only isolated DB sessions."""
from datetime import datetime, timedelta
from http.cookies import SimpleCookie
import json
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import models
from app.database import Base, get_db, enable_sqlite_foreign_keys
from app.security import generate_session_token, hash_session_token, hash_password, verify_password

with patch.object(Base.metadata, "create_all"):
    from app.main import app


class CurrentUserTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 23, 12)
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                                    poolclass=StaticPool)
        event.listen(self.engine, "connect", enable_sqlite_foreign_keys)
        Base.metadata.create_all(self.engine, tables=[models.User.__table__, models.AuthSession.__table__])
        self.sessions = sessionmaker(bind=self.engine, autoflush=False)
        self.token = generate_session_token()
        self.password = "test-only-current-password"
        with Session(self.engine) as db:
            user = models.User(username="session_owner", password_hash=hash_password(self.password))
            db.add(user)
            db.flush()
            session = models.AuthSession(user_id=user.id, session_hash=hash_session_token(self.token),
                                         created_at=self.now, expires_at=self.now + timedelta(hours=12))
            db.add(session)
            db.commit()
            self.uid, self.sid = user.id, session.id
        self.previous_overrides = app.dependency_overrides.copy()

        def test_db():
            with self.sessions() as db:
                yield db

        app.dependency_overrides[get_db] = test_db

    def tearDown(self):
        app.dependency_overrides.clear()
        app.dependency_overrides.update(self.previous_overrides)
        self.engine.dispose()

    def snapshot(self):
        with self.engine.connect() as connection:
            return [connection.execute(select(model.__table__).order_by(model.id)).fetchall()
                    for model in (models.User, models.AuthSession)]

    async def request(self, method, path, token=None, *, origin="https://testserver", payload=None):
        body = json.dumps(payload).encode() if payload is not None else b""
        headers = [(b"host", b"testserver"), (b"x-user-id", b"999999")]
        if payload is not None:
            headers.append((b"content-type", b"application/json"))
        if token is not None:
            headers.append((b"cookie", ("aleph_session=" + token).encode()))
        if origin is not None:
            headers.append((b"origin", origin.encode()))
        messages = []

        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(message):
            messages.append(message)

        with patch("app.main.now_in_seoul", return_value=self.now):
            await app({
                "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                "method": method, "scheme": "https", "path": path,
                "raw_path": path.encode(), "query_string": b"user_id=999999", "root_path": "",
                "headers": headers, "client": ("127.0.0.1", 1), "server": ("testserver", 443),
            }, receive, send)
        start = next(m for m in messages if m["type"] == "http.response.start")
        output = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
        return start["status"], dict(start["headers"]), json.loads(output)

    async def me(self, token=None):
        return await self.request("GET", "/auth/me", token)

    async def test_valid_session_returns_its_owner_without_writing_or_exposing_secrets(self):
        before = self.snapshot()
        status, headers, output = await self.me(self.token)
        self.assertEqual(status, 200)
        self.assertEqual(set(output), {"id", "username", "created_at"})
        self.assertEqual(output["id"], self.uid)
        self.assertEqual(output["username"], "session_owner")
        self.assertEqual(headers[b"cache-control"], b"no-store")
        self.assertFalse(self.token in json.dumps(output))
        self.assertNotIn(b"set-cookie", headers)
        self.assertTrue(before == self.snapshot(), "current-user lookup must not change DB records")

    async def test_missing_or_unknown_cookie_rejected_without_db_writes(self):
        before = self.snapshot()
        for token in (None, generate_session_token()):
            status, _, output = await self.me(token)
            self.assertEqual(status, 401)
            self.assertIsInstance(output["detail"], str)
        self.assertTrue(before == self.snapshot())

    async def test_expired_boundary_and_revoked_sessions_rejected(self):
        for expiry, revoked in [(self.now - timedelta(seconds=1), None),
                                (self.now, None),
                                (self.now + timedelta(hours=1), self.now)]:
            with Session(self.engine) as db:
                session = db.get(models.AuthSession, self.sid)
                session.expires_at, session.revoked_at = expiry, revoked
                db.commit()
            before = self.snapshot()
            status, _, _ = await self.me(self.token)
            self.assertEqual(status, 401)
            self.assertTrue(before == self.snapshot())

    async def test_logout_revokes_current_cookie_and_preserves_other_session(self):
        other_token = generate_session_token()
        with Session(self.engine) as db:
            db.add(models.AuthSession(user_id=self.uid, session_hash=hash_session_token(other_token),
                                      created_at=self.now, expires_at=self.now + timedelta(hours=12)))
            db.commit()
        self.assertEqual((await self.me(self.token))[0], 200)
        status, headers, output = await self.request("POST", "/auth/logout", self.token)
        self.assertEqual(status, 200)
        self.assertFalse(self.token in json.dumps(output))
        self.assertEqual(headers[b"cache-control"], b"no-store")
        cookie = SimpleCookie()
        cookie.load(headers[b"set-cookie"].decode())
        self.assertTrue(cookie["aleph_session"].value == "")
        self.assertEqual(cookie["aleph_session"]["max-age"], "0")
        self.assertEqual(cookie["aleph_session"]["path"], "/")
        with Session(self.engine) as db:
            current = db.get(models.AuthSession, self.sid)
            other = db.query(models.AuthSession).filter_by(session_hash=hash_session_token(other_token)).one()
            self.assertEqual(current.revoked_at, self.now)
            self.assertIsNone(other.revoked_at)
            self.assertEqual(db.query(models.AuthSession).count(), 2)
        self.assertEqual((await self.me(self.token))[0], 401)
        self.assertEqual((await self.me(other_token))[0], 200)
        before = self.snapshot()
        self.now += timedelta(seconds=1)
        self.assertEqual((await self.request("POST", "/auth/logout", self.token))[0], 200)
        self.assertTrue(before == self.snapshot(), "repeat logout preserves revocation timestamp")

    async def test_cross_origin_logout_is_rejected_without_changes(self):
        before = self.snapshot()
        status, headers, _ = await self.request("POST", "/auth/logout", self.token,
                                                origin="https://other.example")
        self.assertEqual(status, 403)
        self.assertNotIn(b"set-cookie", headers)
        self.assertTrue(before == self.snapshot())
        self.assertEqual((await self.me(self.token))[0], 200)

    async def test_logout_missing_or_unknown_cookie_is_safe_to_repeat(self):
        before = self.snapshot()
        for token in (None, generate_session_token()):
            status, headers, _ = await self.request("POST", "/auth/logout", token)
            self.assertEqual(status, 200)
            self.assertIn(b"set-cookie", headers)
        self.assertTrue(before == self.snapshot())

    async def test_password_change_revokes_all_own_sessions_and_allows_new_login(self):
        second_token, other_token = generate_session_token(), generate_session_token()
        other_hash = hash_password("other-test-password-only")
        with Session(self.engine) as db:
            other_user = models.User(username="other_user", password_hash=other_hash)
            db.add(other_user)
            db.flush()
            other_uid = other_user.id
            for uid, token in [(self.uid, second_token), (other_uid, other_token)]:
                db.add(models.AuthSession(user_id=uid, session_hash=hash_session_token(token),
                                          created_at=self.now, expires_at=self.now + timedelta(hours=12)))
            db.commit()
        new_password = "test-only-new-password"
        status, headers, output = await self.request(
            "POST", "/auth/change-password", self.token,
            payload={"current_password": self.password, "new_password": new_password, "user_id": other_uid})
        self.assertEqual(status, 200)
        self.assertFalse(self.password in json.dumps(output) or new_password in json.dumps(output))
        self.assertEqual(headers[b"cache-control"], b"no-store")
        cookie = SimpleCookie()
        cookie.load(headers[b"set-cookie"].decode())
        self.assertEqual(cookie["aleph_session"]["max-age"], "0")
        with Session(self.engine) as db:
            user = db.get(models.User, self.uid)
            self.assertTrue(verify_password(new_password, user.password_hash))
            self.assertFalse(verify_password(self.password, user.password_hash))
            self.assertEqual(db.get(models.User, other_uid).password_hash, other_hash)
            own_sessions = db.query(models.AuthSession).filter_by(user_id=self.uid).all()
            self.assertEqual(len(own_sessions), 2)
            self.assertTrue(all(s.revoked_at == self.now for s in own_sessions))
        for token in (self.token, second_token):
            self.assertEqual((await self.me(token))[0], 401)
        self.assertEqual((await self.me(other_token))[0], 200)
        self.assertEqual((await self.request("POST", "/auth/login", payload={
            "username": "session_owner", "password": self.password}))[0], 401)
        status, headers, _ = await self.request("POST", "/auth/login", payload={
            "username": "session_owner", "password": new_password})
        self.assertEqual(status, 200)
        cookie = SimpleCookie()
        cookie.load(headers[b"set-cookie"].decode())
        self.assertEqual((await self.me(cookie["aleph_session"].value))[0], 200)

    async def test_wrong_current_password_leaves_hash_and_sessions_unchanged(self):
        before = self.snapshot()
        status, headers, _ = await self.request("POST", "/auth/change-password", self.token,
            payload={"current_password": "wrong-test-password", "new_password": "test-only-new-password"})
        self.assertEqual(status, 401)
        self.assertNotIn(b"set-cookie", headers)
        self.assertTrue(before == self.snapshot())
        self.assertEqual((await self.me(self.token))[0], 200)

    async def test_password_change_rejects_missing_session_origin_and_invalid_input(self):
        before = self.snapshot()
        payload = {"current_password": self.password, "new_password": "test-only-new-password"}
        status, headers, _ = await self.request("POST", "/auth/change-password", payload=payload)
        self.assertEqual(status, 401)
        self.assertNotIn(b"set-cookie", headers)
        status, headers, _ = await self.request("POST", "/auth/change-password", self.token,
            payload=payload, origin="https://other.example")
        self.assertEqual(status, 403)
        self.assertNotIn(b"set-cookie", headers)
        status, headers, output = await self.request("POST", "/auth/change-password", self.token,
            payload={"current_password": self.password, "new_password": "short-test"})
        self.assertEqual(status, 422)
        self.assertNotIn(b"set-cookie", headers)
        self.assertFalse(self.password in json.dumps(output) or "short-test" in json.dumps(output))
        self.assertTrue(before == self.snapshot())

    async def test_failed_password_commit_rolls_back_hash_and_session_revocations(self):
        before = self.snapshot()

        def fail_after_flush(db):
            db.flush()
            raise RuntimeError("simulated commit failure")

        with patch.object(Session, "commit", autospec=True, side_effect=fail_after_flush):
            with self.assertRaises(RuntimeError):
                await self.request("POST", "/auth/change-password", self.token,
                    payload={"current_password": self.password, "new_password": "test-only-new-password"})
        self.assertTrue(before == self.snapshot())
        self.assertEqual((await self.me(self.token))[0], 200)
