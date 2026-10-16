"""브라우저 확인용 서버. 개인 planner.db와 무관한 메모리 DB만 사용한다.

실행: venv/Scripts/python.exe -m tests.ui_preview
"""
from datetime import date, timedelta

import uvicorn
from sqlalchemy import create_engine, event
from sqlalchemy.pool import StaticPool

from app import database, models

engine = create_engine(
    "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
)
event.listen(engine, "connect", database.enable_sqlite_foreign_keys)
database.engine = engine
database.SessionLocal.configure(bind=engine)
database.Base.metadata.create_all(engine)

with database.SessionLocal() as db:
    today = date.today()
    plan = models.Plan(
        title="Python 프로젝트", category="공부", start_date=today,
        end_date=today + timedelta(days=7), priority="HIGH",
        success_criteria="매일 복습", expected_minutes=120,
    )
    db.add(plan)
    db.flush()
    task = models.Task(
        plan_id=plan.id, title="Python API 복습", scheduled_date=today,
        priority="HIGH", expected_minutes=30,
    )
    db.add(task)
    db.flush()
    db.add(models.Execution(task_id=task.id, actual_minutes=25))
    db.add(models.TaskLink(task_id=task.id, label="Python 공식 문서", url="https://docs.python.org/3/"))
    db.add(models.Task(
        plan_id=plan.id, title="<script>alert(1)</script>", scheduled_date=today,
        due_date=today - timedelta(days=1), priority="LOW", expected_minutes=20,
    ))
    db.commit()

from app.main import app

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765)
