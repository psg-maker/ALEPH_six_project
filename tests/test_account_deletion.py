"""Account deletion checks use disposable databases, never personal account data."""
from datetime import date, timedelta
import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException, Request
from sqlalchemy import create_engine, event, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import models, schemas
from app.database import Base, enable_sqlite_foreign_keys, get_db
from app.security import hash_password, generate_session_token, hash_session_token

with patch.object(Base.metadata, "create_all"):
    from app import main


class AccountDeleteValidationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.account = models.User(
            id=1, username="validation_owner",
            password_hash=hash_password("test-only-delete-password"),
        )

    def validate(self, *, origin="https://testserver", password="test-only-delete-password",
                 confirmation="계정 삭제"):
        headers = [(b"host", b"testserver")]
        if origin is not None:
            headers.append((b"origin", origin.encode()))
        request = Request({
            "type": "http", "scheme": "https", "path": "/auth/account",
            "query_string": b"", "headers": headers, "server": ("testserver", 443),
        })
        return main.validate_account_delete(
            schemas.AccountDelete(current_password=password, confirmation=confirmation),
            request, self.account,
        )

    def test_correct_password_and_confirmation_pass(self):
        self.assertIsNone(self.validate())
        self.assertIsNone(self.validate(origin=None))

    def test_foreign_origin_is_rejected_before_password_check(self):
        with patch("app.main.verify_password") as verify:
            with self.assertRaises(HTTPException) as error:
                self.validate(origin="https://other.test")
            self.assertEqual(error.exception.status_code, 403)
            verify.assert_not_called()

    def test_confirmation_must_match_exactly(self):
        for value in ("", "삭제", " 계정 삭제", "계정 삭제 "):
            with self.subTest(value=value), self.assertRaises(HTTPException) as error:
                self.validate(confirmation=value)
            self.assertEqual(error.exception.status_code, 422)

    def test_wrong_current_password_is_rejected(self):
        with self.assertRaises(HTTPException) as error:
            self.validate(password="test-only-wrong-password")
        self.assertEqual(error.exception.status_code, 401)


class AccountDataDeletionTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
        )
        event.listen(self.engine, "connect", enable_sqlite_foreign_keys)
        Base.metadata.create_all(self.engine)
        day = date(2026, 11, 2)
        with Session(self.engine) as db:
            db.add_all([
                models.User(id=uid, username="delete_owner_" + str(uid),
                            password_hash="disabled-test-account")
                for uid in (1, 2)
            ])
            db.flush()
            for uid in (1, 2):
                for pid in (uid * 10, uid * 10 + 1):
                    db.add(models.Plan(id=pid, user_id=uid, title="private plan",
                        category="test", start_date=day, end_date=day, priority="NORMAL",
                        success_criteria="ok", expected_minutes=10))
            db.flush()
            for uid in (1, 2):
                tid = uid * 10
                db.add(models.Task(id=tid, plan_id=tid, title="private task",
                    scheduled_date=day, priority="NORMAL", expected_minutes=10))
                db.add(models.PlanVersion(id=tid, plan_id=tid, version_no=1,
                    title="old plan", category="test", start_date=day, end_date=day,
                    priority="NORMAL", success_criteria="ok", expected_minutes=10,
                    status="ACTIVE"))
                db.add(models.Review(id=tid, plan_id=tid, next_plan_id=tid + 1,
                    reflection="private review"))
                db.add(models.DailyNote(id=tid, user_id=uid, note_date=day,
                    content="private memo"))
                for index in (0, 1):
                    db.add(models.AuthSession(id=tid + index, user_id=uid,
                        session_hash=f"{uid}{index}".ljust(64, "0"),
                        expires_at=main.now_in_seoul()))
            db.flush()
            for uid in (1, 2):
                tid = uid * 10
                db.add(models.Execution(id=tid, task_id=tid, actual_minutes=5,
                    memo="private execution"))
                db.add(models.TaskLink(id=tid, task_id=tid, label="private link",
                    url="https://example.com/", link_type="web"))
            db.commit()

    def tearDown(self):
        self.engine.dispose()

    def snapshot(self, uid=None):
        with self.engine.connect() as conn:
            values = {}
            for table in Base.metadata.sorted_tables:
                query = select(table).order_by(table.c.id)
                if uid is not None:
                    ids = [uid] if table.name == "users" else [uid * 10, uid * 10 + 1]
                    query = query.where(table.c.id.in_(ids))
                values[table.name] = conn.execute(query).fetchall()
            return values

    def delete(self, db, uid):
        helper = getattr(main, "delete_account_data", None)
        self.assertTrue(callable(helper), "delete_account_data must be defined")
        helper(db, db.get(models.User, uid))

    def assert_owned_delete(self, uid):
        other_before = self.snapshot(3 - uid)
        with Session(self.engine) as db:
            self.delete(db, uid)
            db.commit()
        self.assertTrue(all(not rows for rows in self.snapshot(uid).values()))
        self.assertEqual(self.snapshot(3 - uid), other_before)
        with self.engine.connect() as conn:
            self.assertEqual(conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall(), [])

    def test_first_owner_delete_preserves_second_owner(self):
        self.assert_owned_delete(1)

    def test_second_owner_delete_preserves_first_owner(self):
        self.assert_owned_delete(2)

    def test_late_failure_can_roll_back_all_earlier_deletes(self):
        before = self.snapshot()
        with Session(self.engine) as db:
            with patch.object(db, "delete", side_effect=RuntimeError("forced failure")):
                with self.assertRaisesRegex(RuntimeError, "forced failure"):
                    self.delete(db, 1)
            db.rollback()
        self.assertEqual(self.snapshot(), before)

    def test_legacy_foreign_reference_fails_without_deleting_other_users_data(self):
        with Session(self.engine) as db:
            db.get(models.Review, 20).next_plan_id = 10
            db.commit()
        before = self.snapshot()
        with Session(self.engine) as db:
            with self.assertRaises(IntegrityError):
                self.delete(db, 1)
                db.commit()
            db.rollback()
        self.assertEqual(self.snapshot(), before)


class AccountDeleteAPITest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.password = "test-only-delete-api-password"
        cls.password_hash = hash_password(cls.password)

    def setUp(self):
        self.fixture = AccountDataDeletionTest()
        self.fixture.setUp()
        self.engine = self.fixture.engine
        self.tokens = {uid: generate_session_token() for uid in (1, 2)}
        with Session(self.engine) as db:
            for uid in (1, 2):
                db.get(models.User, uid).password_hash = self.password_hash
                session = db.get(models.AuthSession, uid * 10)
                session.session_hash = hash_session_token(self.tokens[uid])
                session.expires_at = main.now_in_seoul() + timedelta(hours=1)
            db.commit()
        self.previous_overrides = main.app.dependency_overrides.copy()

        def test_db():
            with Session(self.engine) as db:
                yield db

        main.app.dependency_overrides[get_db] = test_db

    def tearDown(self):
        main.app.dependency_overrides.clear()
        main.app.dependency_overrides.update(self.previous_overrides)
        self.fixture.tearDown()

    async def request(self, *, uid=1, password=None, confirmation="계정 삭제",
                      origin="https://testserver", method="DELETE", path="/auth/account"):
        raw = json.dumps({
            "current_password": self.password if password is None else password,
            "confirmation": confirmation,
            "user_id": 2,
        }).encode()
        headers = [(b"host", b"testserver"), (b"content-type", b"application/json"),
                   (b"x-user-id", b"2")]
        if uid is not None:
            headers.append((b"cookie", ("aleph_session=" + self.tokens[uid]).encode()))
        if origin is not None:
            headers.append((b"origin", origin.encode()))
        messages = []

        async def receive():
            return {"type": "http.request", "body": raw, "more_body": False}

        async def send(message):
            messages.append(message)

        await main.app({
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": method, "scheme": "https", "path": path, "raw_path": path.encode(),
            "query_string": b"user_id=2", "root_path": "", "headers": headers,
            "client": ("127.0.0.1", 1), "server": ("testserver", 443),
        }, receive, send)
        start = next(m for m in messages if m["type"] == "http.response.start")
        body = b"".join(m.get("body", b"") for m in messages
                        if m["type"] == "http.response.body")
        return start["status"], dict(start["headers"]), json.loads(body)

    async def test_delete_ignores_forged_owner_and_invalidates_all_own_sessions(self):
        other_before = self.fixture.snapshot(2)
        status, headers, _ = await self.request()
        self.assertEqual(status, 200)
        self.assertTrue(all(not rows for rows in self.fixture.snapshot(1).values()))
        self.assertEqual(self.fixture.snapshot(2), other_before)
        self.assertEqual(headers.get(b"cache-control"), b"no-store")
        for flag in (b"Max-Age=0", b"HttpOnly", b"Secure", b"SameSite=lax", b"Path=/"):
            self.assertIn(flag, headers[b"set-cookie"])
        status, _, _ = await self.request(method="GET", path="/auth/me")
        self.assertEqual(status, 401)
        status, _, _ = await self.request(uid=2, method="GET", path="/auth/me")
        self.assertEqual(status, 200)

    async def test_rejected_requests_preserve_all_data(self):
        before = self.fixture.snapshot()
        for kwargs, expected in (
            ({"uid": None}, 401), ({"password": "test-only-wrong-password"}, 401),
            ({"confirmation": "delete"}, 422), ({"origin": "https://other.test"}, 403),
        ):
            with self.subTest(expected=expected):
                status, headers, body = await self.request(**kwargs)
                self.assertEqual(status, expected)
                self.assertNotIn(b"set-cookie", headers)
                self.assertNotIn(self.password, json.dumps(body))
                self.assertEqual(self.fixture.snapshot(), before)

    async def test_commit_failure_rolls_back_account_and_all_children(self):
        before = self.fixture.snapshot()

        def failing_commit(db):
            db.flush()
            raise RuntimeError("forced commit failure")

        with patch.object(Session, "commit", failing_commit):
            with self.assertRaisesRegex(RuntimeError, "forced commit failure"):
                await self.request()
        self.assertEqual(self.fixture.snapshot(), before)

    async def test_foreign_reference_returns_conflict_and_rolls_back(self):
        with Session(self.engine) as db:
            db.get(models.Review, 20).next_plan_id = 10
            db.commit()
        before = self.fixture.snapshot()
        status, headers, _ = await self.request()
        self.assertEqual(status, 409)
        self.assertNotIn(b"set-cookie", headers)
        self.assertEqual(self.fixture.snapshot(), before)
