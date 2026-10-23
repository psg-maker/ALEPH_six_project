"""DB uniqueness must separate users while keeping one note per user/date."""
from datetime import date
import unittest

from sqlalchemy import create_engine, event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models
from app.database import Base, enable_sqlite_foreign_keys


class DailyNoteOwnershipTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        event.listen(self.engine, "connect", enable_sqlite_foreign_keys)
        Base.metadata.create_all(self.engine, tables=[models.User.__table__, models.DailyNote.__table__])
        self.addCleanup(self.engine.dispose)
        with Session(self.engine) as db:
            users = [models.User(username=name, password_hash="test-only-placeholder")
                     for name in ("first_owner", "second_owner")]
            db.add_all(users)
            db.commit()
            self.first_id, self.second_id = [user.id for user in users]

    def test_different_users_can_store_notes_on_the_same_date(self):
        with Session(self.engine) as db:
            db.add_all([
                models.DailyNote(user_id=self.first_id, note_date=date(2026, 10, 23), content="first"),
                models.DailyNote(user_id=self.second_id, note_date=date(2026, 10, 23), content="second"),
            ])
            saved = True
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                saved = False
            self.assertTrue(saved, "Different users must be able to save notes on the same date")
            notes = db.query(models.DailyNote).order_by(models.DailyNote.user_id).all()
            self.assertEqual([(n.user_id, n.content) for n in notes],
                             [(self.first_id, "first"), (self.second_id, "second")])

    def test_same_user_date_is_unique_but_other_dates_are_allowed(self):
        with Session(self.engine) as db:
            db.add_all([
                models.DailyNote(user_id=self.first_id, note_date=date(2026, 10, 23), content="original"),
                models.DailyNote(user_id=self.first_id, note_date=date(2026, 10, 24), content="next day"),
            ])
            db.commit()
            db.add(models.DailyNote(user_id=self.first_id, note_date=date(2026, 10, 23), content="duplicate"))
            with self.assertRaises(IntegrityError):
                db.commit()
            db.rollback()
            self.assertEqual(db.query(models.DailyNote).count(), 2)
            self.assertEqual(db.query(models.DailyNote).filter_by(
                user_id=self.first_id, note_date=date(2026, 10, 23)).one().content, "original")

    def test_existing_content_can_be_updated_without_adding_a_row(self):
        with Session(self.engine) as db:
            own = models.DailyNote(user_id=self.first_id, note_date=date(2026, 10, 23), content="before")
            other = models.DailyNote(user_id=self.second_id, note_date=date(2026, 10, 23), content="other")
            db.add_all([own, other])
            db.commit()
            original_id = own.id
            own.content = "after"
            db.commit()
            db.refresh(own)
            db.refresh(other)
            self.assertEqual(own.id, original_id)
            self.assertEqual(own.content, "after")
            self.assertEqual(own.user_id, self.first_id)
            self.assertEqual(own.note_date, date(2026, 10, 23))
            self.assertEqual(other.content, "other")
            self.assertEqual(db.query(models.DailyNote).count(), 2)
