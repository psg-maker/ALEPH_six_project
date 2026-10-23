"""Registration checks use only a temporary DB, never personal/deployed data."""
from datetime import datetime
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import models
from app.database import Base, get_db
from app.security import verify_password

with patch.object(Base.metadata, "create_all"):
    from app.main import app


class RegistrationTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.engine = create_engine(
            "sqlite:///" + (Path(self.temp.name) / "registration.db").as_posix(),
            connect_args={"check_same_thread": False},
        )
        models.User.__table__.create(self.engine)
        self.sessions = sessionmaker(bind=self.engine)

        def test_db():
            with self.sessions() as db:
                yield db

        self.previous_overrides = app.dependency_overrides.copy()
        app.dependency_overrides[get_db] = test_db

    def tearDown(self):
        app.dependency_overrides.clear()
        app.dependency_overrides.update(self.previous_overrides)
        self.engine.dispose()
        self.temp.cleanup()

    async def register(self, payload, *, raw=False):
        body = payload if raw else json.dumps(payload).encode()
        messages = []

        async def receive():
            return {"type": "http.request", "body": body, "more_body": False}

        async def send(message):
            messages.append(message)

        await app({
            "type": "http", "asgi": {"version": "3.0"},
            "http_version": "1.1", "method": "POST", "scheme": "http",
            "path": "/auth/register", "raw_path": b"/auth/register",
            "query_string": b"", "root_path": "",
            "headers": [(b"content-type", b"application/json")],
            "client": ("127.0.0.1", 1), "server": ("test", 80),
        }, receive, send)
        status = next(m["status"] for m in messages if m["type"] == "http.response.start")
        output = b"".join(m.get("body", b"") for m in messages
                          if m["type"] == "http.response.body")
        return status, json.loads(output)

    async def test_register_stores_distinct_hashes_and_returns_public_fields(self):
        password = "test-only-registration-password"
        for username in ("first_user", "second_user"):
            status, output = await self.register({"username": "  " + username + "  ",
                                                  "password": password})
            self.assertEqual(status, 201)
            self.assertEqual(set(output), {"id", "username", "created_at"})
            self.assertEqual(output["username"], username)
            self.assertIsInstance(output["id"], int)
            datetime.fromisoformat(output["created_at"])
            self.assertNotIn(password, json.dumps(output))
        with self.sessions() as db:
            users = db.query(models.User).order_by(models.User.id).all()
            self.assertEqual(len(users), 2)
            self.assertNotEqual(users[0].password_hash, users[1].password_hash)
            for user in users:
                self.assertTrue(verify_password(password, user.password_hash))
                self.assertFalse(verify_password("wrong-test-password", user.password_hash))
                self.assertNotEqual(user.password_hash, password)

    async def test_duplicate_username_rejected_without_changing_original(self):
        payload = {"username": "same_user", "password": "first-test-password-only"}
        status, original_response = await self.register(payload)
        self.assertEqual(status, 201)
        with self.sessions() as db:
            original = db.query(models.User).one()
            snapshot = (original.id, original.username, original.password_hash, original.created_at)
        status, output = await self.register({"username": " same_user ",
                                              "password": "replacement-test-password"})
        self.assertEqual(status, 409)
        self.assertIsInstance(output["detail"], str)
        with self.sessions() as db:
            row = db.query(models.User).one()
            self.assertEqual((row.id, row.username, row.password_hash, row.created_at), snapshot)
            self.assertEqual(row.id, original_response["id"])

    async def test_invalid_input_and_json_do_not_echo_password_or_write_user(self):
        samples = [
            {"username": "user", "password": "short-test"},
            {"username": "   ", "password": "long-test-password-only"},
            {"username": "user", "password": "x" * 129},
            {"username": "user"},
        ]
        for payload in samples:
            status, output = await self.register(payload)
            self.assertEqual(status, 422)
            self.assertEqual(set(output), {"detail"})
            self.assertIsInstance(output["detail"], str)
            if "password" in payload:
                self.assertNotIn(payload["password"], json.dumps(output))
        status, output = await self.register(b'{"password":"malformed-test-secret",', raw=True)
        self.assertEqual(status, 422)
        self.assertNotIn("malformed-test-secret", json.dumps(output))
        with self.sessions() as db:
            self.assertEqual(db.query(models.User).count(), 0)
