import sqlite3
from pathlib import Path

def ensure_users_table(conn):
    exists = conn.execute("""
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'users'
    """).fetchone()

    if exists:
        print("users 테이블이 있어 생성 생략")
        return

    conn.execute("""
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            username VARCHAR(50) NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at DATETIME NOT NULL
        )
    """)
    print("users 테이블 생성 완료")

def ensure_ownership_columns(conn):
    for table in ("plans", "daily_notes"):
        columns = {
            row[1]
            for row in conn.execute(f"PRAGMA table_info({table})")
        }

        if not columns:
            raise RuntimeError(f"{table} 테이블이 없습니다.")

        if "user_id" in columns:
            print(f"{table}: user_id가 있어 추가 생략")
            continue

        conn.execute(f"""
            ALTER TABLE {table}
            ADD COLUMN user_id INTEGER REFERENCES users(id)
        """)
        print(f"{table}: user_id 추가 완료")

def ensure_daily_note_unique(conn):
    unique_columns = []

    for index in conn.execute("PRAGMA index_list(daily_notes)").fetchall():
        if index[2]:
            index_name = index[1].replace('"', '""')
            columns = [
                row[2]
                for row in conn.execute(
                    f'PRAGMA index_info("{index_name}")'
                ).fetchall()
            ]
            unique_columns.append(columns)

    if (
        ["user_id", "note_date"] in unique_columns
        and ["note_date"] not in unique_columns
    ):
        print("메모 고유 조건이 이미 적용돼 교체 생략")
        return

    # 교체 후 복원할 명시적 인덱스와 트리거
    saved_objects = conn.execute("""
        SELECT sql FROM sqlite_master
        WHERE tbl_name = 'daily_notes'
        AND type IN ('index', 'trigger')
        AND sql IS NOT NULL
        ORDER BY type, name
    """).fetchall()

    fields = "id, user_id, note_date, content, created_at, updated_at"

    before = conn.execute(
        f"SELECT {fields} FROM daily_notes ORDER BY id"
    ).fetchall()

    conn.execute("""
        CREATE TABLE daily_notes_new (
            id INTEGER NOT NULL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            note_date DATE NOT NULL,
            content TEXT,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            CONSTRAINT uq_daily_notes_user_date
                UNIQUE (user_id, note_date)
        )
    """)

    conn.execute(f"""
        INSERT INTO daily_notes_new ({fields})
        SELECT {fields} FROM daily_notes
    """)

    after = conn.execute(
        f"SELECT {fields} FROM daily_notes_new ORDER BY id"
    ).fetchall()

    if before != after:
        raise RuntimeError("메모가 일치하지 않아 교체를 취소합니다.")

    conn.execute("DROP TABLE daily_notes")
    conn.execute("ALTER TABLE daily_notes_new RENAME TO daily_notes")

    for (sql,) in saved_objects:
        conn.execute(sql)

    print(f"메모 {len(after)}건 보존, 고유 조건 변경 완료")

def main():
    db_path = Path("planner.db").resolve()

    if not db_path.is_file():
        raise FileNotFoundError(f"DB 파일이 없습니다: {db_path}")

    with sqlite3.connect(
        db_path.as_uri() + "?mode=rw",
        uri=True,
    ) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("BEGIN")
        ensure_users_table(conn)
        ensure_ownership_columns(conn)
        ensure_daily_note_unique(conn)
        tables = conn.execute("""
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
            ORDER BY name
        """).fetchall()

        print("연결한 DB:", db_path)
        for (name,) in tables:
            print(name)

        ownership_columns_ok = True

        for table in ("plans", "daily_notes"):
            columns = {
                row[1]
                for row in conn.execute(f"PRAGMA table_info({table})")
            }

            if "user_id" in columns:
                print(f"{table}: user_id 있음")
            else:
                print(f"{table}: user_id 추가 필요")
                ownership_columns_ok = False


        unique_columns = []

        for index in conn.execute("PRAGMA index_list(daily_notes)").fetchall():
            if not index[2]:
                continue

            index_name = index[1].replace('"', '""')
            columns = [
                row[2]
                for row in conn.execute(
                    f'PRAGMA index_info("{index_name}")'
                ).fetchall()
            ]
            unique_columns.append(columns)

        print(
            "사용자+날짜 고유 조건:",
            ["user_id", "note_date"] in unique_columns,
        )
        print(
            "날짜 단독 고유 조건:",
            ["note_date"] in unique_columns,
        )

        ownership_foreign_keys_ok = True

        for table in ("plans", "daily_notes"):
            foreign_keys = conn.execute(
                f"PRAGMA foreign_key_list({table})"
            ).fetchall()

            has_user_reference = any(
                row[2] == "users"
                and row[3] == "user_id"
                and row[4] == "id"
                for row in foreign_keys
            )

            print(f"{table}: users.id 외래키 있음: {has_user_reference}")

            if not has_user_reference:
                ownership_foreign_keys_ok = False

        
        foreign_key_errors = conn.execute(
            "PRAGMA foreign_key_check"
        ).fetchall()

        foreign_key_data_ok = not foreign_key_errors

        print("전체 자료의 외래키 위반 없음:", foreign_key_data_ok)
        print("외래키 위반 건수:", len(foreign_key_errors))

        user_columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(users)")
        }

        required_user_columns = {
            "id",
            "username",
            "password_hash",
            "created_at",
        }

        missing_user_columns = required_user_columns - user_columns
        user_columns_ok = not missing_user_columns

        print("users 필수 컬럼 있음:", user_columns_ok)
        print("users 누락 컬럼:", sorted(missing_user_columns))

        schema_ready = (
            user_columns_ok
            and ownership_columns_ok
            and ownership_foreign_keys_ok
            and foreign_key_data_ok
            and ["user_id", "note_date"] in unique_columns
            and ["note_date"] not in unique_columns
        )

        if not schema_ready:
            raise RuntimeError("최종 검사 실패: 변경을 롤백합니다.")

        print("최종 구조 검사 통과")


if __name__ == "__main__":
    main()