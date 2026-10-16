from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# 어떤 DB를 사용할지 지정 -> 현: SQLite의 planner.db

DATABASE_URL = "sqlite:///./planner.db"

# python과 DB를 실제로 연결하는 통로

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}
)

# engine이 새 DB 연결을 만들 때마다 아래 함수를 실행한다.
@event.listens_for(engine, "connect")
def enable_sqlite_foreign_keys(dbapi_connection, connection_record):
    # dbapi_connection: SQLite에 직접 명령을 보낼 수 있는 실제 연결
    # connection_record: SQLAlchemy가 연결을 관리하는 객체. 여기서는 사용하지 않는다.

    # SQL 명령을 실행할 커서를 만든다.
    cursor = dbapi_connection.cursor()
    try:
        # 이 연결에서 외래키 제약을 검사하도록 설정한다.
        # 예: 존재하지 않는 Task를 참조하는 Execution 저장을 막는다.
        # 연결 기록이 남아 있는 Task만 삭제하는 것도 막는다.
        cursor.execute("PRAGMA foreign_keys=ON")
    finally:
        # 성공하거나 오류가 발생해도 커서를 닫는다.
        # DB 연결 자체를 닫는 것은 아니다.
        cursor.close()

# SessionLocal = DB 조회/추가/수정/삭제할 때 사용하는 세션

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False
)

# 앞으로 만들 Plan, Task 같은 SQLAlchemy 모델의 부모 클래스
class Base(DeclarativeBase):
    pass

# 요청 -> DB 세션 open ->
# 세션에서 조회 및 저장 -> 요청이 끝나면 세션 닫기
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()