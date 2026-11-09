"""Append one SQLite account and its records to an existing Neon DB.

Preview: python -B -m scripts.import_account_to_neon --username NAME
Apply:   same command with --apply (prompts for a hidden connection URL).
Existing Neon rows are preserved. Sessions are never imported.
"""
import argparse
from datetime import datetime, timezone
from getpass import getpass
import os
from pathlib import Path

from sqlalchemy import create_engine, func, inspect, select, text
from sqlalchemy.engine import make_url

from app.database import Base
from scripts.migrate_to_neon import copy_snapshot, read_snapshot

ROOT = Path(__file__).resolve().parents[1]


def select_account(snapshot, username):
    users = [r for r in snapshot["users"] if r["username"] == username]
    if len(users) != 1:
        raise ValueError("Source account must exist exactly once")
    owner = users[0]["id"]
    result = {name: [] for name in snapshot}
    result["users"] = users
    for name in ("plans", "daily_notes"):
        result[name] = [r for r in snapshot[name] if r["user_id"] == owner]
    plans = {r["id"] for r in result["plans"]}
    for name in ("plan_versions", "tasks", "reviews"):
        result[name] = [r for r in snapshot[name] if r["plan_id"] in plans]
    tasks = {r["id"] for r in result["tasks"]}
    for name in ("executions", "task_links"):
        result[name] = [r for r in snapshot[name] if r["task_id"] in tasks]
    if any(r["next_plan_id"] is not None and r["next_plan_id"] not in plans
           for r in result["reviews"]):
        raise ValueError("Review links outside the selected account; resolve before importing")
    return result


def import_account(conn, snapshot):
    """Caller owns transaction and, on PostgreSQL, locks against concurrent writes."""
    tables = Base.metadata.sorted_tables
    users = Base.metadata.tables["users"]
    if conn.scalar(select(users.c.id).where(
        users.c.username == snapshot["users"][0]["username"]
    )) is not None:
        raise ValueError("Target username already exists; no records imported")
    mappings = {}
    for table in tables:
        mappings[table.name] = {}
        next_id = (conn.scalar(select(func.max(table.c.id))) or 0) + 1
        for source in snapshot[table.name]:
            row = dict(source)
            row["id"] = next_id
            for column in table.c:
                if row[column.name] is not None:
                    for fk in column.foreign_keys:
                        row[column.name] = mappings[fk.column.table.name][row[column.name]]
            conn.execute(table.insert(), row)
            actual = dict(conn.execute(select(table).where(table.c.id == next_id)).mappings().one())
            if actual != row:
                raise ValueError("Target row verification failed")
            mappings[table.name][source["id"]] = next_id
            next_id += 1
    if conn.dialect.name == "postgresql":
        for table in tables:
            if not snapshot[table.name]:
                continue
            sequence = conn.scalar(text("SELECT pg_get_serial_sequence(:name, 'id')"),
                                   {"name": "public." + table.name})
            if sequence is None:
                raise ValueError("Target ID sequence missing")
            maximum = conn.scalar(select(func.max(table.c.id)))
            # Never rewind a sequence, including after a previously rolled-back import.
            conn.execute(text(
                "SELECT setval(CAST(:seq AS regclass), "
                "GREATEST(:maximum, pg_sequence_last_value(CAST(:seq AS regclass))), true)"
            ), {"seq": sequence, "maximum": maximum})
    return {name: len(rows) for name, rows in snapshot.items() if name != "auth_sessions"}


def save_backup(snapshot, label):
    directory = ROOT / "backups"
    directory.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = directory / f"account-import-{label}-{stamp}.db"
    engine = create_engine("sqlite:///" + path.as_posix())
    try:
        with engine.begin() as conn:
            copy_snapshot(conn, snapshot)
    finally:
        engine.dispose()
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    target = None
    committed = False
    try:
        full_source = read_snapshot(ROOT / "planner.db")
        selected = select_account(full_source, args.username)
        for name, rows in selected.items():
            if name != "auth_sessions":
                print(f"Source {name}: {len(rows)}")
        if not args.apply:
            print("Local preview only; no DB changed. Add --apply to import.")
            return 0
        raw = os.environ.get("NEON_DATABASE_URL") or getpass("Neon connection URL (hidden): ")
        url = make_url(raw)
        if url.get_backend_name() not in ("postgres", "postgresql"):
            raise ValueError("Target must be PostgreSQL")
        if not url.host or not url.host.endswith(".neon.tech"):
            raise ValueError("Target must use a Neon host")
        url = url.set(drivername="postgresql+psycopg2")
        target = create_engine(url, connect_args={"connect_timeout": 15, "sslmode": "require"})
        with target.begin() as conn:
            conn.execute(text("SET LOCAL lock_timeout = '5s'"))
            conn.execute(text("SET LOCAL statement_timeout = '60s'"))
            conn.execute(text("SET LOCAL search_path = public"))
            table_names = ", ".join('public."' + t.name + '"' for t in Base.metadata.sorted_tables)
            conn.execute(text("LOCK TABLE " + table_names + " IN EXCLUSIVE MODE"))
            existing = {}
            inspector = inspect(conn)
            for table in Base.metadata.sorted_tables:
                columns = {c["name"] for c in inspector.get_columns(table.name)}
                if columns != set(table.c.keys()):
                    raise ValueError("Target schema differs from the application")
                existing[table.name] = [dict(r) for r in conn.execute(
                    select(table).order_by(table.c.id)).mappings()]
            constraints = inspector.get_unique_constraints("daily_notes")
            indexes = inspector.get_indexes("daily_notes")
            unique = [set(c["column_names"]) for c in constraints]
            unique += [set(i["column_names"]) for i in indexes if i["unique"]]
            if {"note_date"} in unique or {"user_id", "note_date"} not in unique:
                raise ValueError("Target daily-note uniqueness must be per user and date")
            for name in ("plans", "daily_notes", "auth_sessions"):
                fks = inspector.get_foreign_keys(name)
                if not any(f["constrained_columns"] == ["user_id"] and
                           f["referred_table"] == "users" and
                           f["referred_columns"] == ["id"] for f in fks):
                    raise ValueError("Target user foreign key missing")
            if any(r["username"] == args.username for r in existing["users"]):
                raise ValueError("Target username already exists; no records imported")
            print("Local backup:", save_backup(full_source, "source").name)
            print("Neon application-data backup:", save_backup(existing, "target").name)
            counts = import_account(conn, selected)
            for table in Base.metadata.sorted_tables:
                old_ids = [r["id"] for r in existing[table.name]]
                actual = [dict(r) for r in conn.execute(select(table).where(
                    table.c.id.in_(old_ids)).order_by(table.c.id)).mappings()]
                if actual != existing[table.name]:
                    raise ValueError("Existing target rows changed")
                total = conn.scalar(select(func.count()).select_from(table))
                if total != len(existing[table.name]) + len(selected[table.name]):
                    raise ValueError("Target record count verification failed")
        committed = True
        print("SUCCESS: Account and records committed; existing Neon rows preserved.")
        for name, count in counts.items():
            print(f"Imported {name}: {count}")
        print("Old Neon records remain separate; login sessions were not copied.")
        return 0
    except (Exception, KeyboardInterrupt) as exc:
        # Driver errors may include credentials or password hashes: never echo them.
        if type(exc) is ValueError and str(exc).startswith(("Source ", "Target ", "Review ", "Existing ")):
            print(str(exc))
        else:
            print(f"FAILED ({type(exc).__name__}); commit status must be checked before retrying.")
        if not committed:
            print("No successful commit confirmed. Local SQLite was read-only.")
        return 1
    finally:
        if target is not None:
            target.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
