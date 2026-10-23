"""Session creation must persist only a hash and roll back failed writes."""
from datetime import timedelta
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from app import models
from app.database import Base, enable_sqlite_foreign_keys
from app.security import hash_session_token
from app.time_utils import now_in_seoul

with patch.object(Base.metadata, "create_all"):
    from app import main


class SessionCreationTest(unittest.TestCase):
    def setUp(self):
        self.create_session = getattr(main, "create_auth_session", None)
        self.assertTrue(callable(self.create_session),
                        "create_auth_session must be a standalone function")
        self.engine = create_engine("sqlite:///:memory:")
        event.listen(self.engine, "connect", enable_sqlite_foreign_keys)
        Base.metadata.create_all(self.engine, tables=[models.User.__table__, models.AuthSession.__table__])
        self.addCleanup(self.engine.dispose)

    def make_user(self, db):
        user = models.User(username="session_user", password_hash="test-only-placeholder")
        db.add(user)
        db.commit()
        return user

    def test_sessions_store_only_hash_with_twelve_hour_expiry(self):
        with Session(self.engine) as db:
            user = self.make_user(db)
            start = now_in_seoul()
            first, first_expiry = self.create_session(user, db)
            second, _ = self.create_session(user, db)
            self.assertTrue(isinstance(first, str) and bool(first))
            self.assertTrue(first != second, "sessions must have distinct tokens")
            rows = db.query(models.AuthSession).order_by(models.AuthSession.id).all()
            self.assertEqual(len(rows), 2)
            for token, row in zip((first, second), rows):
                self.assertEqual(row.user_id, user.id)
                self.assertTrue(row.session_hash == hash_session_token(token))
                self.assertTrue(row.session_hash != token)
                self.assertIsNone(row.revoked_at)
                self.assertEqual(row.expires_at - row.created_at, timedelta(hours=12))
                self.assertTrue(start <= row.created_at <= now_in_seoul())
            self.assertEqual(rows[0].expires_at, first_expiry)

    def test_failed_commit_rolls_back_and_allows_retry(self):
        with Session(self.engine) as db:
            user = self.make_user(db)
            with patch.object(db, "commit", side_effect=RuntimeError("simulated commit failure")):
                with self.assertRaises(RuntimeError):
                    self.create_session(user, db)
            self.assertEqual(len(db.new), 0)
            self.assertEqual(db.query(models.AuthSession).count(), 0)
            self.create_session(user, db)
            self.assertEqual(db.query(models.AuthSession).count(), 1)
