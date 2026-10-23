from datetime import date, datetime
from pydantic import BaseModel, Field, HttpUrl, SecretStr, model_validator, field_validator

# Field -> 입력 필드의 검증 조건 등을 지정한다.

class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    # 비밀번호는 공백을 포함해 입력 그대로 15~128자를 허용한다.
    password: SecretStr = Field(min_length=15, max_length=128)
    @field_validator("username", mode="before")
    @classmethod
    def strip_username(cls, value):
        if isinstance(value, str):
            return value.strip()
        return value

class UserLogin(UserCreate):
    pass

# UserCreate → 서버가 받는 것: username, password
# UserRead   → 서버가 돌려주는 것: id, username, created_at
class UserRead(BaseModel):
    id: int
    username: str
    created_at: datetime

# 로그인 성공 시 돌려줄 공개 정보
class LoginRead(BaseModel):
    user: UserRead
    expires_at: datetime

# 비밀번호 변경 요청으로 받을 정보
class PasswordChange(BaseModel):
    # 실제로 맞는지는 서버에서 기존 해시로 검사한다.
    current_password: SecretStr = Field(min_length=1, max_length=128)

    # 새 비밀번호에는 현재 가입 정책을 적용한다.
    new_password: SecretStr = Field(min_length=15, max_length=128)

# 사용자에게 어떤 데이터를 받을지 정의한다.
class PlanCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    category: str
    start_date: date
    end_date: date
    priority: str
    success_criteria: str
    expected_minutes: int =  Field(ge=0)

# 시작일이 종료일 보다 빠를 수 없다
    @model_validator(mode="after")
    def validate_date_range(self):
        if self.end_date < self.start_date:
            raise ValueError("종료일은 시작일보다 빠를 수 없습니다.")
        return self

# 수정용 schema
class PlanUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    category: str
    start_date: date
    end_date: date
    priority: str
    success_criteria: str
    expected_minutes: int = Field(ge=0)
    status: str

# 시작일이 종료일 보다 빠를 수 없다
    @model_validator(mode="after")
    def validate_date_range(self):
        if self.end_date < self.start_date:
            raise ValueError("종료일은 시작일보다 빠를 수 없습니다.")
        return self

# Task CRUD
class TaskCreate(BaseModel):
    plan_id: int
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    scheduled_date: date
    due_date: date | None = None
    priority: str
    tag: str | None = None
    expected_minutes: int = Field(ge=0)

# Task 업데이트 
class TaskUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    scheduled_date: date
    due_date: date | None = None
    priority: str
    tag: str | None = None
    expected_minutes: int = Field(ge=0)

# Task의 실제 수행 기록을 입력받는 형식
class ExecutionCreate(BaseModel):
    # 시작·종료 시각은 선택 입력이다.
    # 시간대 없는 날짜·시각을 입력받는다.
    started_at: datetime | None = None
    ended_at: datetime | None = None

    # 실제 소요 시간은 사용자가 분 단위로 직접 입력한다.
    # 생략할 수 있지만, 입력한다면 0 이상이어야 한다.
    actual_minutes: int | None = Field(default=None, ge=0)

    # 수행 내용이나 막힌 이유 등을 자유롭게 기록한다.
    memo: str | None = None

    # 수행 내용 등을 자유롭게 기록한다.
    memo: str | None = None

    # 막힌 이유는 일반 메모와 별도로 입력받는다.
    blocked_reason: str | None = None

    @model_validator(mode="after")
    def validate_execution_times(self):
        # 현재 DB의 시간 저장 방식에 맞춰 시간대 포함 입력은 거부한다.
        for value in (self.started_at, self.ended_at):
            if value is not None and value.utcoffset() is not None:
                raise ValueError("시각은 시간대 없이 입력해주세요.")

        # 두 시각이 모두 있을 때만 앞뒤 순서를 비교한다.
        if self.started_at is not None and self.ended_at is not None:
            if self.ended_at < self.started_at:
                raise ValueError("종료 시각은 시작 시각보다 빠를 수 없습니다.")

        return self

# Task에 연결할 자료 링크의 입력 형식
class TaskLinkCreate(BaseModel):
    # 화면에 표시할 이름: 예) "Python 복습 노트"
    label: str = Field(min_length=1, max_length=200)

    # http 또는 https 형식의 URL인지 검사한다.
    # javascript: 같은 주소는 허용하지 않는다.
    url: HttpUrl

    # 링크 종류를 생략하면 "web"으로 처리한다.
    link_type: str = Field(default="web", min_length=1, max_length=30)

# Plan의 회고를 저장하거나 수정할 때 사용하는 입력 형식
class ReviewSave(BaseModel):
    # 계획을 진행하며 느낀 점
    reflection: str | None = None

    # 다음에 개선할 점
    improvement: str | None = None

    # 다음 계획에서 실천할 구체적인 행동
    next_action: str | None = None

    # 연결할 다음 Plan의 ID. 연결하지 않으면 생략할 수 있다.
    # ID가 실제로 존재하는지는 API에서 DB를 조회해 검사한다.
    next_plan_id: int | None = Field(default=None, ge=1)

# 특정 날짜의 메모를 저장하거나 교체할 때 사용하는 입력 형식
class DailyNoteSave(BaseModel):
    # 빈 문자열을 보내면 메모 내용을 비울 수 있다.
    # 기본값이 없으므로 요청에는 content 항목을 반드시 포함해야 한다.
    content: str