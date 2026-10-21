from datetime import date, datetime
from app.time_utils import now_in_seoul
from sqlalchemy import Date, DateTime, Integer, String, Text, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# DB에 어떻게 저장할지 정의한다.
class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        index=True
    )

    title: Mapped[str] = mapped_column(
        String(200),
        nullable=False
    )

    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    category: Mapped[str] = mapped_column(
        String(50),
        nullable=False
    )

    start_date: Mapped[date] = mapped_column(
        Date,
        nullable=False
    )

    end_date: Mapped[date] = mapped_column(
        Date,
        nullable=False
    )

    priority: Mapped[str] = mapped_column(
        String(20),
        nullable=False
    )

    success_criteria: Mapped[str] = mapped_column(
        Text,
        nullable=False
    )

    expected_minutes: Mapped[int] = mapped_column(
        Integer,
        nullable=False
    )

    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="ACTIVE"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul,
        onupdate=now_in_seoul
    )

class PlanVersion(Base):
    __tablename__ = "plan_versions"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        index=True
    )

    plan_id: Mapped[int] = mapped_column(
        ForeignKey("plans.id"),
        nullable=False
    )

    version_no: Mapped[int] = mapped_column(
        Integer,
        nullable=False
    )

    title: Mapped[str] = mapped_column(
        String(200),
        nullable=False
    )

    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    category: Mapped[str] = mapped_column(
        String(50),
        nullable=False
    )

    start_date: Mapped[date] = mapped_column(
        Date,
        nullable=False
    )

    end_date: Mapped[date] = mapped_column(
        Date,
        nullable=False
    )

    priority: Mapped[str] = mapped_column(
        String(20),
        nullable=False
    )

    success_criteria: Mapped[str] = mapped_column(
        Text,
        nullable=False
    )

    expected_minutes: Mapped[int] = mapped_column(
        Integer,
        nullable=False
    )

    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False
    )

    changed_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul
    )

class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        index=True
    )

    plan_id: Mapped[int] = mapped_column(
        ForeignKey("plans.id"),
        nullable=False
    )

    title: Mapped[str] = mapped_column(
        String(200),
        nullable=False
    )

    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    scheduled_date: Mapped[date] = mapped_column(
        Date,
        nullable=False
    )

    due_date: Mapped[date | None] = mapped_column(
        Date,
        nullable=True
    )

    priority: Mapped[str] = mapped_column(
        String(20),
        nullable=False
    )

    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="TODO"
    )

    tag: Mapped[str | None] = mapped_column(
        String(50),
        nullable=True
    )

    expected_minutes: Mapped[int] = mapped_column(
        Integer,
        nullable=False
    )

    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul,
        onupdate=now_in_seoul
    )

class TaskLink(Base):
    __tablename__ = "task_links"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        index=True
    )

    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id"),
        nullable=False
    )

    label: Mapped[str] = mapped_column(
        String(200),
        nullable=False
    )

    url: Mapped[str] = mapped_column(
        Text,
        nullable=False
    )

    link_type: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
        default="web"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul
    )

class Execution(Base):
    __tablename__ = "executions"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        index=True
    )

    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id"),
        nullable=False
    )

    started_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        nullable=True
    )

    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime,
        nullable=True
    )

    actual_minutes: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True
    )

    memo: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    # 일반 메모와 구분해서 저장하는 막힌 이유
    # 선택 항목이므로 기록하지 않으면 NULL을 허용한다.
    blocked_reason: Mapped[str | None] = mapped_column(
    Text,
    nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul
    )

class Review(Base):
    __tablename__ = "reviews"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        index=True
    )

    plan_id: Mapped[int] = mapped_column(
        ForeignKey("plans.id"),
        nullable=False,
        unique=True
    )

    reflection: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    improvement: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    next_action: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    next_plan_id: Mapped[int | None] = mapped_column(
        ForeignKey("plans.id"),
        nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul,
        onupdate=now_in_seoul
    )

class DailyNote(Base):
    __tablename__ = "daily_notes"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        index=True
    )

    note_date: Mapped[date] = mapped_column(
        Date,
        nullable=False,
        unique=True
    )

    content: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=now_in_seoul,
        onupdate=now_in_seoul
    )

