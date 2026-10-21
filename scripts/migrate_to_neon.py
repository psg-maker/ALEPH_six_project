"""Copy local SQLite records to an empty Neon database, preserving IDs.

Preview: python -B -m scripts.migrate_to_neon
Apply:   python -B -m scripts.migrate_to_neon --apply
The target URL is read exclusively from NEON_DATABASE_URL.
"""
import argparse
import os
from pathlib import Path
import sqlite3

from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.engine import make_url

from app import models  # Registers the seven tables without importing app.main.
from app.database import Base


ROOT = Path(__file__).resolve().parents[1]


def read_snapshot(path):
    """Open the existing source read-only; do not create or change planner.db."""
    path = Path(path).resolve()
    if not path.is_file():
        raise ValueError("Source DB file does not exist")
    uri = path.as_uri() + "?mode=ro"
    source = create_engine("sqlite://", creator=lambda: sqlite3.connect(uri, uri=True))
    try:
        with source.connect() as conn:
            # A single read transaction gives all tables the same snapshot.
            conn.exec_driver_sql("BEGIN")
            if conn.exec_driver_sql("PRAGMA integrity_check").scalars().all() != ["ok"]:
                raise ValueError("Source integrity check failed")
            if conn.exec_driver_sql("PRAGMA foreign_key_check").first() is not None:
                raise ValueError("Source has foreign key violations")
            snapshot = {}
            for table in Base.metadata.sorted_tables:
                columns = {c["name"] for c in inspect(conn).get_columns(table.name)}
                if columns != set(table.c.keys()):
                    raise ValueError("Source schema does not match the application")
                snapshot[table.name] = [
                    dict(row) for row in conn.execute(select(table).order_by(table.c.id)).mappings()
                ]
            return snapshot
    finally:
        source.dispose()


def copy_snapshot(conn, snapshot):
    """Caller owns the transaction: create, copy, verify, then commit together."""
    if inspect(conn).get_table_names():
        raise ValueError("Target DB is not empty; no tables will be overwritten")
    Base.metadata.create_all(conn)
    for table in Base.metadata.sorted_tables:
        rows = snapshot[table.name]
        if rows:
            conn.execute(table.insert(), rows)

    # Compare complete rows, not just counts, before confirming the transaction.
    for table in Base.metadata.sorted_tables:
        actual = [dict(row) for row in conn.execute(select(table).order_by(table.c.id)).mappings()]
        if actual != snapshot[table.name]:
            raise ValueError("Target verification failed; transaction must be rolled back")

    if conn.dialect.name == "postgresql":
        for table in Base.metadata.sorted_tables:
            sequence = conn.scalar(
                text("SELECT pg_get_serial_sequence(:table_name, 'id')"),
                {"table_name": table.name},
            )
            if sequence is not None:
                rows = snapshot[table.name]
                # Explicit imported IDs do not advance PostgreSQL sequences.
                conn.execute(
                    text("SELECT setval(CAST(:sequence AS regclass), :value, :called)"),
                    {"sequence": sequence, "value": max(r["id"] for r in rows) if rows else 1,
                     "called": bool(rows)},
                )
    return {name: len(rows) for name, rows in snapshot.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Write to the empty Neon DB")
    args = parser.parse_args()
    target = None
    try:
        snapshot = read_snapshot(ROOT / "planner.db")
        for name, rows in snapshot.items():
            print(f"Source {name}: {len(rows)}")
        if not args.apply:
            print("Preview only. No changes made. Use --apply after backing up SQLite.")
            return 0
        raw_url = os.environ.get("NEON_DATABASE_URL")
        if not raw_url:
            raise ValueError("NEON_DATABASE_URL is not set in this terminal")
        url = make_url(raw_url)
        if url.get_backend_name() not in ("postgres", "postgresql"):
            raise ValueError("Target must be a PostgreSQL database")
        url = url.set(drivername="postgresql+psycopg2")
        target = create_engine(url, connect_args={"connect_timeout": 15}, pool_pre_ping=True)
        with target.begin() as conn:
            counts = copy_snapshot(conn, snapshot)
        print("SUCCESS: All seven tables copied and every stored value verified.")
        for name, count in counts.items():
            print(f"Verified {name}: {count}")
        return 0
    except ValueError as exc:
        # Print only our own safe messages; never echo a malformed connection URL.
        allowed = ("Source ", "Target ", "NEON_DATABASE_URL ")
        print(str(exc) if str(exc).startswith(allowed) else "Invalid database configuration.")
        return 1
    except Exception as exc:
        # Database exception details can contain credentials or personal row values.
        print(f"FAILED ({type(exc).__name__}). No target commit was confirmed. SQLite was read-only.")
        return 1
    finally:
        if target is not None:
            target.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
