from datetime import date, datetime
from app.time_utils import now_in_seoul, today_in_seoul
from pathlib import Path
from fastapi import Depends, FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import or_, func
from sqlalchemy.orm import Session
from fastapi import HTTPException

# ORM 객체와 날짜·시각을 JSON으로 변환 가능한 값으로 바꾼다.
from fastapi.encoders import jsonable_encoder

# JSON 응답의 다운로드 헤더를 설정할 때 사용한다.
from fastapi.responses import JSONResponse

from app import models, schemas
from app.database import Base, engine, get_db

# get_db => schemas에서 만든 함수
# 

Base.metadata.create_all(bind=engine)

app = FastAPI()

# 실행 위치에 관계없이 app 폴더의 화면과 정적 파일을 찾는다.
APP_DIR = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
templates = Jinja2Templates(directory=APP_DIR / "templates")


@app.get("/")
def root(request: Request):
    # 화면의 데이터 변경은 기존 JSON API를 통해 처리한다.
    return templates.TemplateResponse(
        request=request, name="index.html", context={"today": today_in_seoul().isoformat()}
    )

@app.post("/plans")

# 사용자가 보낸 데이터
def create_plan(
    plan: schemas.PlanCreate,
    db: Session = Depends(get_db)
):
    # DB에 넣을 Plan 객체 생성
    new_plan = models.Plan(
        title=plan.title,
        description=plan.description,
        category=plan.category,
        start_date=plan.start_date,
        end_date=plan.end_date,
        priority=plan.priority,
        success_criteria=plan.success_criteria,
        expected_minutes=plan.expected_minutes,
    )

    db.add(new_plan)    # 삽입
    db.commit()     # 저장
    db.refresh(new_plan)    # 저장 후, 생성된 id 같은 값을 다시 가져온다.

    return {
        "id": new_plan.id,
        "title": new_plan.title,
        "status": new_plan.status
    }

# SQL = SELECT * FROM plans;
# plans table에서 조회를 하고, 모든 행을 가져온다.
@app.get("/plans")
def get_plans(
    db: Session = Depends(get_db)
):
    plans = db.query(models.Plan).all()

    return plans

# endpoint
@app.put("/plans/{plan_id}")
def update_plan(
    plan_id: int,
    plan: schemas.PlanUpdate,
    db: Session = Depends(get_db)
):
    # 수정할 기존 Plan을 찾는다.
    existing_plan = db.query(models.Plan).filter(
        models.Plan.id == plan_id
    ).first()

    if existing_plan is None:
        return {"message": "Plan not found"}

    version_count = db.query(models.PlanVersion).filter(
        models.PlanVersion.plan_id == plan_id
    ).count()

    # 수정 전 값을 history table에 복사한다.
    old_version = models.PlanVersion(
        plan_id=existing_plan.id,
        version_no=version_count + 1,
        title=existing_plan.title,
        description=existing_plan.description,
        category=existing_plan.category,
        start_date=existing_plan.start_date,
        end_date=existing_plan.end_date,
        priority=existing_plan.priority,
        success_criteria=existing_plan.success_criteria,
        expected_minutes=existing_plan.expected_minutes,
        status=existing_plan.status
    )

    db.add(old_version)

    existing_plan.title = plan.title    # 현재 Plan의 값을 새 값으로 바꾼다.
    existing_plan.description = plan.description
    existing_plan.category = plan.category
    existing_plan.start_date = plan.start_date
    existing_plan.end_date = plan.end_date
    existing_plan.priority = plan.priority
    existing_plan.success_criteria = plan.success_criteria
    existing_plan.expected_minutes = plan.expected_minutes
    existing_plan.status = plan.status

    db.commit()
    db.refresh(existing_plan)

    return {
        "id": existing_plan.id,
        "title": existing_plan.title,
        "status": existing_plan.status
    }

# endpoint
@app.get("/plans/{plan_id}/versions")
def get_plan_versions(
    plan_id: int,
    db: Session = Depends(get_db)
):
    versions = (
        db.query(models.PlanVersion)
        .filter(models.PlanVersion.plan_id == plan_id)
        .order_by(models.PlanVersion.version_no)
        .all()
    )

    return versions

# Tasks
@app.post("/tasks")
def create_task(
    task: schemas.TaskCreate,
    db: Session = Depends(get_db)
):
    # plan_id에 대한 검증(확인)
    plan = db.query(models.Plan).filter(
        models.Plan.id == task.plan_id
    ).first()

    if plan is None:
        return {"message": "Plan not found"}

    new_task = models.Task(
        plan_id=task.plan_id,
        title=task.title,
        description=task.description,
        scheduled_date=task.scheduled_date,
        due_date=task.due_date,
        priority=task.priority,
        tag=task.tag,
        expected_minutes=task.expected_minutes,
    )

    db.add(new_task)
    db.commit()
    db.refresh(new_task)

    return {
        "id": new_task.id,
        "plan_id": new_task.plan_id,
        "title": new_task.title,
        "status": new_task.status
    }

# 저장된 tasks 전체
def task_date_filters(start_date: date | None = None, end_date: date | None = None):
    """집계와 근거 조회가 같은 예정일 범위를 사용하도록 조건을 한곳에서 만든다."""
    if start_date is not None and end_date is not None and start_date > end_date:
        raise HTTPException(status_code=422, detail="종료일은 시작일보다 빠를 수 없습니다.")
    filters = []
    if start_date is not None:
        filters.append(models.Task.scheduled_date >= start_date)
    if end_date is not None:
        filters.append(models.Task.scheduled_date <= end_date)
    return filters


@app.get("/tasks")
def get_tasks(
    plan_id: int | None = None,
    overdue_only: bool = False,  # true일 때만 지연 Task로 제한한다.
    keyword: str | None = None,
    status: str | None = None,
    priority: str | None = None,
    blocked_only: bool = False,  # true일 때만 막힌 이유가 있는 Task로 제한한다.
    tag: str | None = None,
    sort_by: str = "scheduled_date",
    order: str = "asc",
    date_filters: list = Depends(task_date_filters),
    db: Session = Depends(get_db)
):

    query = db.query(models.Task).filter(*date_filters)

    # Plan을 지정한 경우 해당 Plan의 Task만 남긴다.
    # is not None을 사용해 생략 여부를 명확히 구분한다.
    if plan_id is not None:
        query = query.filter(models.Task.plan_id == plan_id)

    # 집계 API와 같은 조건으로 지연 Task만 조회한다.
    # false이거나 생략하면 기존 조회 결과를 유지한다.
    if overdue_only:
        query = query.filter(
            models.Task.status != "DONE",
            models.Task.due_date < today_in_seoul()
        )

            # 막힌 이유가 있는 Task만 조회하도록 조건을 추가한다.
    if blocked_only:
        reasons_query = (
            db.query(
                models.Execution.task_id,
                models.Execution.blocked_reason
            )
            .join(
                models.Task,
                models.Execution.task_id == models.Task.id
            )
        )

        # Plan이 지정되어 있으면 해당 Plan의 이유만 확인한다.
        if plan_id is not None:
            reasons_query = reasons_query.filter(
                models.Task.plan_id == plan_id
            )

        # 같은 Task에 이유가 여러 건 있어도 ID는 하나만 남긴다.
        blocked_task_ids = {
            task_id
            for task_id, reason in reasons_query.all()
            if reason is not None and reason.strip()
        }

        # 기존 Plan·지연 필터에 막힘 조건을 추가한다.
        # ID 집합이 비어 있으면 조회 결과도 빈 목록이 된다.
        query = query.filter(models.Task.id.in_(blocked_task_ids))

        
    # 검색
    if keyword:
        query = query.filter(
            or_(
                models.Task.title.contains(keyword),
                models.Task.description.contains(keyword)
            )
        )

    # 필터
    if status:
        query = query.filter(models.Task.status == status)

    if priority:
        query = query.filter(models.Task.priority == priority)

    if tag:
        query = query.filter(models.Task.tag == tag)

    # 정렬 가능한 항목
    sort_columns = {
        "scheduled_date": models.Task.scheduled_date,
        "due_date": models.Task.due_date,
        "expected_minutes": models.Task.expected_minutes,
        "created_at": models.Task.created_at
    }

    sort_column = sort_columns.get(
        sort_by,
        models.Task.scheduled_date
    )

    if order == "desc":
        query = query.order_by(sort_column.desc())
    else:
        query = query.order_by(sort_column.asc())

    return query.all()

# 저장된 tasks에서 scheduled_date == today
@app.get("/tasks/today")
def get_today_tasks(
    db: Session = Depends(get_db)
):
    today = today_in_seoul()

    tasks = (
        db.query(models.Task)
        .filter(models.Task.scheduled_date == today)
        .order_by(models.Task.id)
        .all()
    )

    return tasks

# Task의 일부 수정
@app.patch("/tasks/{task_id}/complete")
def complete_task(
    task_id: int,
    db: Session = Depends(get_db)
):
    task = (
        db.query(models.Task)
        .filter(models.Task.id == task_id)
        .first()
    )

    if task is None:
        raise HTTPException(
            status_code=404,
            detail="Task not found"
        )

    if task.status == "DONE":
        return {
            "id": task.id,
            "title": task.title,
            "status": task.status,
            "completed_at": task.completed_at
        }

    task.status = "DONE"
    task.completed_at = now_in_seoul()

    db.commit()
    db.refresh(task)

    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "completed_at": task.completed_at
    }

# Task를 미완료로 되돌리는 기능
@app.patch("/tasks/{task_id}/reopen")
def reopen_task(
    task_id: int,
    db: Session = Depends(get_db)
):
    task = (
        db.query(models.Task)
        .filter(models.Task.id == task_id)
        .first()
    )

    if task is None:
        return {"message": "Task not found"}

    if task.status == "TODO":
        return {
            "id": task.id,
            "title": task.title,
            "status": task.status,
            "completed_at": task.completed_at
        }

    task.status = "TODO"
    task.completed_at = None

    db.commit()
    db.refresh(task)

    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "completed_at": task.completed_at
    }

# Task 수정
@app.put("/tasks/{task_id}")
def update_task(
    task_id: int,
    task: schemas.TaskUpdate,
    db: Session = Depends(get_db)
):
    existing_task = (
        db.query(models.Task)
        .filter(models.Task.id == task_id)
        .first()
    )

    if existing_task is None:
        return {"message": "Task not found"}

    existing_task.title = task.title
    existing_task.description = task.description
    existing_task.scheduled_date = task.scheduled_date
    existing_task.due_date = task.due_date
    existing_task.priority = task.priority
    existing_task.tag = task.tag
    existing_task.expected_minutes = task.expected_minutes

    db.commit()
    db.refresh(existing_task)

    return existing_task

#Delete
@app.delete("/tasks/{task_id}")
def delete_task(
    task_id: int,
    db: Session = Depends(get_db)
):
    # 삭제할 Task가 있는지 먼저 확인한다.
    task = (
        db.query(models.Task)
        .filter(models.Task.id == task_id)
        .first()
    )

    if task is None:
        raise HTTPException(
            status_code=404,
            detail="Task not found"
        )

    try:
        # 해당 Task에 연결된 링크만 삭제한다.
        db.query(models.TaskLink).filter(
            models.TaskLink.task_id == task_id
        ).delete(synchronize_session=False)

        # 해당 Task의 실행 기록만 삭제한다.
        db.query(models.Execution).filter(
            models.Execution.task_id == task_id
        ).delete(synchronize_session=False)

        # 연결 기록을 먼저 삭제한 뒤 Task를 삭제한다.
        db.delete(task)

        # 모든 삭제를 한 번에 확정한다.
        db.commit()

    except Exception:
        # 삭제나 커밋 중 실패하면 이번 작업 전체를 취소한다.
        db.rollback()

        # 오류를 다시 전달하여 성공 응답이 나가지 않게 한다.
        raise

    return {
        "message": "Task deleted",
        "id": task_id
    }

# 특정 Task에 실제 수행 기록을 추가한다.
# 새 기록이 생성되면 HTTP 201을 반환한다.
@app.post("/tasks/{task_id}/executions", status_code=201)
def create_execution(
    task_id: int,
    execution: schemas.ExecutionCreate,
    db: Session = Depends(get_db)
):
    # 실행 기록을 연결할 Task가 실제로 존재하는지 확인한다.
    task = (
        db.query(models.Task)
        .filter(models.Task.id == task_id)
        .first()
    )

    if task is None:
        raise HTTPException(
            status_code=404,
            detail="Task not found"
        )

    # 입력값으로 새 실행 기록을 만든다.
    # Task의 예상 시간과 완료 상태는 변경하지 않는다.
    new_execution = models.Execution(
        task_id=task.id,
        started_at=execution.started_at,
        ended_at=execution.ended_at,
        actual_minutes=execution.actual_minutes,
        memo=execution.memo,
        # 입력받은 막힌 이유를 실행 기록에 저장한다.
        blocked_reason=execution.blocked_reason
    )

    try:
        # 실행 기록을 저장 대상으로 등록하고 DB에 확정한다.
        db.add(new_execution)
        db.commit()
    except Exception:
        # 저장 실패 시 이번 트랜잭션을 취소한다.
        db.rollback()
        raise

    # DB에서 생성된 ID와 생성 시각 등을 가져온다.
    db.refresh(new_execution)

    return {
        "id": new_execution.id,
        "task_id": new_execution.task_id,
        "started_at": new_execution.started_at,
        "ended_at": new_execution.ended_at,
        "actual_minutes": new_execution.actual_minutes,
        "memo": new_execution.memo,
        # 생성 응답에도 저장된 막힌 이유를 포함한다.
        "blocked_reason": new_execution.blocked_reason,
        "created_at": new_execution.created_at
    }

# 특정 Task에 연결된 실행 기록 목록을 조회한다.
@app.get("/tasks/{task_id}/executions")
def get_executions(
    task_id: int,
    db: Session = Depends(get_db)
):
    # 실행 기록이 없는 경우와 Task 자체가 없는 경우를 구분한다.
    task = (
        db.query(models.Task)
        .filter(models.Task.id == task_id)
        .first()
    )

    if task is None:
        raise HTTPException(
            status_code=404,
            detail="Task not found"
        )

    # 해당 Task의 기록만 조회한다.
    # 생성 시각이 같아도 ID를 추가 기준으로 사용해 순서를 일정하게 유지한다.
    executions = (
        db.query(models.Execution)
        .filter(models.Execution.task_id == task_id)
        .order_by(
            models.Execution.created_at.asc(),
            models.Execution.id.asc()
        )
        .all()
    )

    # 기록이 없으면 빈 목록 []을 반환한다.
    return executions

# 특정 Task에 자료 링크를 추가한다.
@app.post("/tasks/{task_id}/links", status_code=201)
def create_task_link(
    task_id: int,
    link: schemas.TaskLinkCreate,
    db: Session = Depends(get_db)
):
    # 링크를 연결할 Task가 실제로 존재하는지 확인한다.
    task = (
        db.query(models.Task)
        .filter(models.Task.id == task_id)
        .first()
    )

    if task is None:
        raise HTTPException(
            status_code=404,
            detail="Task not found"
        )

    # HttpUrl 객체를 DB의 Text 컬럼에 저장할 수 있도록 문자열로 바꾼다.
    new_link = models.TaskLink(
        task_id=task.id,
        label=link.label,
        url=str(link.url),
        link_type=link.link_type
    )

    try:
        # 링크를 저장하고 변경을 확정한다.
        db.add(new_link)
        db.commit()
    except Exception:
        # 저장에 실패하면 이번 작업을 취소한다.
        db.rollback()
        raise

    # DB에서 생성된 ID와 생성 시각을 가져온다.
    db.refresh(new_link)

    return {
        "id": new_link.id,
        "task_id": new_link.task_id,
        "label": new_link.label,
        "url": new_link.url,
        "link_type": new_link.link_type,
        "created_at": new_link.created_at
    }

# 특정 Task에 연결된 자료 링크 목록을 조회한다.
@app.get("/tasks/{task_id}/links")
def get_task_links(
    task_id: int,
    db: Session = Depends(get_db)
):
    # 링크가 없는 경우와 Task 자체가 없는 경우를 구분한다.
    task = (
        db.query(models.Task)
        .filter(models.Task.id == task_id)
        .first()
    )

    if task is None:
        raise HTTPException(
            status_code=404,
            detail="Task not found"
        )

    # 해당 Task에 연결된 링크만 조회한다.
    # 먼저 생성한 순서로 정렬하고, 생성 시각이 같으면 ID로 정렬한다.
    links = (
        db.query(models.TaskLink)
        .filter(models.TaskLink.task_id == task_id)
        .order_by(
            models.TaskLink.created_at.asc(),
            models.TaskLink.id.asc()
        )
        .all()
    )

    # 링크가 없으면 빈 목록 []을 반환한다.
    return links

# 특정 Plan에서 막힌 이유가 기록된 Task 수를 집계한다.
@app.get("/plans/{plan_id}/summary")
def get_plan_summary(
    plan_id: int,
    date_filters: list = Depends(task_date_filters),
    db: Session = Depends(get_db)
):
    # Plan이 없는 경우와 Task가 없는 경우를 구분한다.
    plan = (
        db.query(models.Plan)
        .filter(models.Plan.id == plan_id)
        .first()
    )

    if plan is None:
        raise HTTPException(
            status_code=404,
            detail="Plan not found"
        )

    # 해당 Plan의 Task에 연결된 막힌 이유만 조회한다.
    reasons = (
        db.query(
            models.Execution.task_id,
            models.Execution.blocked_reason
        )
        .join(
            models.Task,
            models.Execution.task_id == models.Task.id
        )
        .filter(models.Task.plan_id == plan_id, *date_filters)
        .all()
    )

    # 이유가 여러 번 기록돼도 같은 Task는 한 번만 센다.
    blocked_task_ids = set()

    for task_id, reason in reasons:
        # 막힌 Task를 모두 모은 뒤 집계해야 한다.
        if reason is not None and reason.strip():
            blocked_task_ids.add(task_id)

    # 여기부터는 for문 밖이다. 앞에 공백 4칸을 사용한다.
    task_count = (
        db.query(models.Task)
        .filter(models.Task.plan_id == plan_id, *date_filters)
        .count()
    )

    # 현재 완료 상태인 Task만 센다.
    completed_task_count = (
        db.query(models.Task)
        .filter(
            models.Task.plan_id == plan_id,
            models.Task.status == "DONE",
            *date_filters
        )
        .count()
    )

    # Task가 없으면 0%, 있으면 소수점 첫째 자리까지 계산한다.
    completion_rate = (
        round(completed_task_count / task_count * 100, 1)
        if task_count > 0
        else 0.0
    )

        # 서버의 현재 날짜를 기준으로 지연 여부를 판단한다.
    today = today_in_seoul()

    # 해당 Plan에서 미완료이고 마감일이 오늘보다 이전인 Task만 센다.
    # 마감일이 NULL이면 날짜 비교 조건에 해당하지 않아 제외된다.
    overdue_task_count = (
        db.query(models.Task)
        .filter(
            models.Task.plan_id == plan_id,
            models.Task.status != "DONE",
            models.Task.due_date < today,
            *date_filters
        )
        .count()
    )

        # 해당 Plan의 Task 예상 시간을 합산한다.
    # 합칠 기록이 없으면 SQL SUM은 NULL을 반환하므로 0으로 처리한다.
    expected_minutes = (
        db.query(func.sum(models.Task.expected_minutes))
        .filter(models.Task.plan_id == plan_id, *date_filters)
        .scalar()
    ) or 0

    # 해당 Plan의 Task에 연결된 실행 기록의 실제 시간을 합산한다.
    # 같은 Task에 실행 기록이 여러 건이면 모두 더한다.
    actual_minutes = (
        db.query(func.sum(models.Execution.actual_minutes))
        .join(
            models.Task,
            models.Execution.task_id == models.Task.id
        )
        .filter(models.Task.plan_id == plan_id, *date_filters)
        .scalar()
    ) or 0

    # 양수면 예상보다 더 사용했고, 음수면 덜 사용한 시간이다.
    difference_minutes = actual_minutes - expected_minutes

    # 모든 기록을 확인한 다음 결과를 한 번 반환한다.
    return {
        "plan_id": plan.id,
        "task_count": task_count,
        "completed_task_count": completed_task_count,
        "completion_rate": completion_rate,
        "blocked_task_count": len(blocked_task_ids),
        "overdue_task_count": overdue_task_count,
        "expected_minutes": expected_minutes,
        "actual_minutes": actual_minutes,
        "difference_minutes": difference_minutes
    }

# 특정 Plan에 속한 Task들의 실행 기록을 조회한다.
@app.get("/plans/{plan_id}/executions")
def get_plan_executions(
    plan_id: int,
    date_filters: list = Depends(task_date_filters),
    db: Session = Depends(get_db)
):
    # Plan이 없는 경우와 실행 기록이 없는 경우를 구분한다.
    plan = (
        db.query(models.Plan)
        .filter(models.Plan.id == plan_id)
        .first()
    )

    if plan is None:
        raise HTTPException(
            status_code=404,
            detail="Plan not found"
        )

    # Execution에는 plan_id가 없으므로 Task를 통해 Plan을 찾는다.
    executions = (
        db.query(models.Execution)
        .join(
            models.Task,
            models.Execution.task_id == models.Task.id
        )
        .filter(models.Task.plan_id == plan_id, *date_filters)
        .order_by(
            models.Execution.created_at.asc(),
            models.Execution.id.asc()
        )
        .all()
    )

    # Task가 없거나 실행 기록이 없으면 빈 목록 []을 반환한다.
    return executions

# Plan의 회고를 저장한다. 이미 있으면 기존 회고를 수정한다.
@app.put("/plans/{plan_id}/review")
def save_review(
    plan_id: int,
    review: schemas.ReviewSave,
    db: Session = Depends(get_db)
):
    # 회고를 작성할 Plan이 존재하는지 확인한다.
    plan = (
        db.query(models.Plan)
        .filter(models.Plan.id == plan_id)
        .first()
    )

    if plan is None:
        raise HTTPException(
            status_code=404,
            detail="Plan not found"
        )

    # 다음 Plan을 지정한 경우에만 연결 대상을 검사한다.
    if review.next_plan_id is not None:
        # 자기 자신을 다음 Plan으로 연결하지 못하게 한다.
        if review.next_plan_id == plan_id:
            raise HTTPException(
                status_code=422,
                detail="다음 Plan은 현재 Plan과 달라야 합니다."
            )

        next_plan = (
            db.query(models.Plan)
            .filter(models.Plan.id == review.next_plan_id)
            .first()
        )

        if next_plan is None:
            raise HTTPException(
                status_code=404,
                detail="Next plan not found"
            )

    # Plan당 회고는 하나이므로 기존 기록을 먼저 찾는다.
    saved_review = (
        db.query(models.Review)
        .filter(models.Review.plan_id == plan_id)
        .first()
    )

    if saved_review is None:
        saved_review = models.Review(plan_id=plan_id)

    # 새 회고와 기존 회고 모두 같은 방식으로 값을 채운다.
    # PUT 전체 교체 방식이므로 생략한 필드는 None이 된다.
    saved_review.reflection = review.reflection
    saved_review.improvement = review.improvement
    saved_review.next_action = review.next_action
    saved_review.next_plan_id = review.next_plan_id

    try:
        # 새 객체는 추가하고, 기존 객체는 변경된 값을 저장한다.
        db.add(saved_review)
        db.commit()
    except Exception:
        # 저장에 실패하면 이번 작업을 취소한다.
        db.rollback()
        raise

    # DB에 저장된 최신 값을 가져온다.
    db.refresh(saved_review)

    return {
        "id": saved_review.id,
        "plan_id": saved_review.plan_id,
        "reflection": saved_review.reflection,
        "improvement": saved_review.improvement,
        "next_action": saved_review.next_action,
        "next_plan_id": saved_review.next_plan_id,
        "created_at": saved_review.created_at,
        "updated_at": saved_review.updated_at
    }

# 특정 Plan에 저장된 회고를 조회한다.
@app.get("/plans/{plan_id}/review")
def get_review(
    plan_id: int,
    db: Session = Depends(get_db)
):
    # Plan 자체가 존재하는지 먼저 확인한다.
    plan = (
        db.query(models.Plan)
        .filter(models.Plan.id == plan_id)
        .first()
    )

    if plan is None:
        raise HTTPException(
            status_code=404,
            detail="Plan not found"
        )

    # Plan당 회고는 최대 하나이므로 첫 기록을 조회한다.
    review = (
        db.query(models.Review)
        .filter(models.Review.plan_id == plan_id)
        .first()
    )

    # 회고는 선택 기능이므로 없으면 200과 null을 반환한다.
    return review

# 회고의 개선점을 가져와 다음 Plan을 만들고 연결한다.
@app.post("/plans/{plan_id}/next-plan", status_code=201)
def create_next_plan(
    plan_id: int,
    plan: schemas.PlanCreate,
    db: Session = Depends(get_db)
):
    # 출발점인 기존 Plan이 존재하는지 확인한다.
    source_plan = (
        db.query(models.Plan)
        .filter(models.Plan.id == plan_id)
        .first()
    )
    if source_plan is None:
        raise HTTPException(status_code=404, detail="Plan not found")

    # 다음 계획에 가져올 회고가 있어야 한다.
    review = (
        db.query(models.Review)
        .filter(models.Review.plan_id == plan_id)
        .first()
    )
    if review is None:
        raise HTTPException(status_code=404, detail="Review not found")

    # 이미 연결된 Plan이 있으면 새로 만들지 않는다.
    if review.next_plan_id is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "이미 다음 Plan이 연결되어 있습니다.",
                "next_plan_id": review.next_plan_id
            }
        )

    # 공백뿐인 내용은 개선점으로 사용하지 않는다.
    improvement = (review.improvement or "").strip()
    if not improvement:
        raise HTTPException(
            status_code=422,
            detail="다음 계획에 반영할 개선점을 먼저 작성해주세요."
        )

    # 사용자가 입력한 설명에 회고 내용을 덧붙인다.
    description_parts = []
    if plan.description:
        description_parts.append(plan.description)

    description_parts.append(
        f"이전 계획에서 가져온 개선점:\n{improvement}"
    )

    next_action = (review.next_action or "").strip()
    if next_action:
        description_parts.append(f"다음 실천:\n{next_action}")

    # 검증된 PlanCreate 입력값을 딕셔너리로 변환한다.
    plan_data = plan.model_dump()
    plan_data["description"] = "\n\n".join(description_parts)
    new_plan = models.Plan(**plan_data)

    try:
        db.add(new_plan)

        # DB에 INSERT하여 새 ID를 받되 아직 저장을 확정하지 않는다.
        db.flush()

        # 아직 연결되지 않은 회고만 새 Plan에 연결한다.
        # 다른 요청이 먼저 연결했다면 이번 새 Plan 생성도 취소한다.
        linked_count = (
            db.query(models.Review)
            .filter(
                models.Review.id == review.id,
                models.Review.next_plan_id.is_(None)
            )
            .update(
                {"next_plan_id": new_plan.id},
                synchronize_session=False
            )
        )
        if linked_count != 1:
            raise HTTPException(
                status_code=409,
                detail="다음 Plan 연결 상태가 변경되었습니다. 다시 조회해주세요."
            )

        # 새 Plan 생성과 회고 연결을 함께 확정한다.
        db.commit()
    except Exception:
        # 연결에 실패하면 새 Plan 생성도 함께 취소한다.
        db.rollback()
        raise

    db.refresh(new_plan)

    return {
        "source_plan_id": plan_id,
        "next_plan_id": new_plan.id,
        "title": new_plan.title,
        "description": new_plan.description,
        "status": new_plan.status
    }

# 지정한 날짜의 메모를 저장한다. 이미 있으면 내용을 교체한다.
@app.put("/daily-notes/{note_date}")
def save_daily_note(
    note_date: date,
    note: schemas.DailyNoteSave,
    db: Session = Depends(get_db)
):
    # 날짜당 메모는 하나이므로 기존 기록을 먼저 찾는다.
    saved_note = (
        db.query(models.DailyNote)
        .filter(models.DailyNote.note_date == note_date)
        .first()
    )

    if saved_note is None:
        # 해당 날짜에 처음 저장하는 메모를 만든다.
        saved_note = models.DailyNote(note_date=note_date)

    # 기존 메모가 있으면 입력한 내용으로 전체 교체한다.
    # 빈 문자열도 허용하므로 내용을 비울 수 있다.
    saved_note.content = note.content

    try:
        db.add(saved_note)
        db.commit()
    except Exception:
        # 저장 실패 시 이번 작업을 취소한다.
        db.rollback()
        raise

    # DB에서 생성된 ID와 저장 시각 등을 가져온다.
    db.refresh(saved_note)

    return {
        "id": saved_note.id,
        "note_date": saved_note.note_date,
        "content": saved_note.content,
        "created_at": saved_note.created_at,
        "updated_at": saved_note.updated_at
    }

# 지정한 날짜의 메모를 조회한다.
@app.get("/daily-notes/{note_date}")
def get_daily_note(
    note_date: date,
    db: Session = Depends(get_db)
):
    # 날짜당 메모는 최대 하나이므로 첫 기록을 조회한다.
    note = (
        db.query(models.DailyNote)
        .filter(models.DailyNote.note_date == note_date)
        .first()
    )

    # 작성한 메모가 없으면 200과 null을 반환한다.
    # 조회만 하므로 commit()은 필요 없다.
    return note

# 저장된 전체 데이터를 JSON 파일 하나로 내보낸다.
@app.get("/export")
def export_data(
    db: Session = Depends(get_db)
):
    # 테이블별로 ID순 정렬해 내보내는 순서를 일정하게 유지한다.
    # 날짜·시각과 외래키 ID도 포함한다.
    data = {
        "plans": db.query(models.Plan).order_by(models.Plan.id).all(),
        "plan_versions": (
            db.query(models.PlanVersion)
            .order_by(models.PlanVersion.id)
            .all()
        ),
        "tasks": db.query(models.Task).order_by(models.Task.id).all(),
        "task_links": (
            db.query(models.TaskLink)
            .order_by(models.TaskLink.id)
            .all()
        ),
        "executions": (
            db.query(models.Execution)
            .order_by(models.Execution.id)
            .all()
        ),
        "reviews": db.query(models.Review).order_by(models.Review.id).all(),
        "daily_notes": (
            db.query(models.DailyNote)
            .order_by(models.DailyNote.id)
            .all()
        )
    }

    # ORM 객체 및 date/datetime을 JSON 응답용으로 변환한다.
    # SQLAlchemy 내부 관리 정보는 기본적으로 제외된다.
    encoded_data = jsonable_encoder(data)

    return JSONResponse(
        content=encoded_data,
        headers={
            # 브라우저에서 응답을 JSON 파일로 다운로드하도록 안내한다.
            "Content-Disposition": 'attachment; filename="planner-export.json"'
        }
    )   
