"""Check the login helper using an isolated in-memory user table."""
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import Base
from app.security import DUMMY_PASSWORD_HASH, hash_password, verify_password

with patch.object(Base.metadata, "create_all"):
    from app import main


class CredentialsTest(unittest.TestCase):
    def setUp(self):
        self.authenticate = getattr(main, "authenticate_user", None)
        self.assertTrue(callable(self.authenticate),
                        "authenticate_user must be a standalone module function")
        self.engine = create_engine("sqlite:///:memory:")
        models.User.__table__.create(self.engine)
        self.addCleanup(self.engine.dispose)
        self.password = "test-only-valid-password"
        with Session(self.engine) as db:
            user = models.User(username="known_user", password_hash=hash_password(self.password))
            db.add(user)
            db.commit()
            self.uid = user.id
            self.stored_hash = user.password_hash
            self.created_at = user.created_at

    def test_valid_credentials_return_existing_user(self):
        credentials = schemas.UserLogin(username="  known_user  ", password=self.password)
        with Session(self.engine) as db:
            result = self.authenticate(credentials, db)
            self.assertEqual(result.id, self.uid)
            self.assertEqual(result.username, "known_user")
            self.assertEqual(result.password_hash, self.stored_hash)
            self.assertEqual(db.query(models.User).count(), 1)

    def test_missing_user_and_wrong_password_have_same_failure_and_verify_hash(self):
        failures = []
        with Session(self.engine) as db, patch.object(main, "verify_password", wraps=verify_password) as verify:
            for username in ("known_user", "missing_user"):
                credentials = schemas.UserLogin(username=username, password="test-only-wrong-password")
                with self.assertRaises(HTTPException) as caught:
                    self.authenticate(credentials, db)
                failures.append((caught.exception.status_code, caught.exception.detail))
            self.assertEqual(failures[0], failures[1])
            self.assertEqual(failures[0][0], 401)
            self.assertEqual(verify.call_count, 2)
            self.assertEqual(verify.call_args_list[0].args[1], self.stored_hash)
            self.assertEqual(verify.call_args_list[1].args[1], DUMMY_PASSWORD_HASH)
            user = db.query(models.User).one()
            self.assertEqual((user.id, user.username, user.password_hash, user.created_at),
                             (self.uid, "known_user", self.stored_hash, self.created_at))
