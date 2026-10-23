"""Check two simultaneous completion requests using one temporary deployed Task.

Only the uniquely named Task created by this run is deleted. Existing records
stay in memory for before/after comparison and are not written to the report.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from threading import Barrier
from time import perf_counter
from urllib.request import Request, urlopen
from uuid import uuid4


BASE = "https://aleph-six-project.vercel.app"
REPORT = Path("work/deployed-completion-check-20261023.json")


def request(path, method="GET", data=None):
    body = None if data is None else json.dumps(data).encode()
    req = Request(BASE + path, data=body, method=method,
                  headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=45) as response:
        return json.load(response)


def main():
    now = datetime.now(timezone(timedelta(hours=9)))
    title = "Codex temporary completion check " + uuid4().hex
    report = {"checked_at": now.isoformat(), "app_url": BASE,
              "scope": "Currently deployed app; local fix deployment not established",
              "method": "Two client requests released together; server overlap not instrumented"}
    before = request("/export")
    plans = before["plans"]
    assert plans, "No existing Plan available for temporary Task"
    occupied = {t["plan_id"] for t in before["tasks"]}
    pid = next((p["id"] for p in plans if p["id"] not in occupied), plans[0]["id"])
    baseline = request(f"/plans/{pid}/summary")
    tid = None
    error = None
    try:
        created = request("/tasks", "POST", {
            "plan_id": pid, "title": title, "scheduled_date": now.date().isoformat(),
            "priority": "LOW", "expected_minutes": 0,
        })
        tid = created["id"]
        report["temporary_task_id"] = tid
        barrier = Barrier(2)

        def complete(_):
            barrier.wait(timeout=10)
            started = perf_counter()
            value = request(f"/tasks/{tid}/complete", "PATCH")
            return {"elapsed_seconds": round(perf_counter() - started, 3),
                    "id": value["id"], "status": value["status"],
                    "completed_at": value["completed_at"]}

        with ThreadPoolExecutor(max_workers=2) as pool:
            report["responses"] = list(pool.map(complete, range(2)))
        current = request("/export")
        matches = [t for t in current["tasks"] if t["id"] == tid]
        summary = request(f"/plans/{pid}/summary")
        retry = request(f"/tasks/{tid}/complete", "PATCH")
        results = report["responses"]
        report["checks"] = {
            "both_requests_done": all(r["id"] == tid and r["status"] == "DONE" for r in results),
            "one_task_row": len(matches) == 1,
            "same_completion_timestamp": results[0]["completed_at"] == results[1]["completed_at"],
            "responses_match_stored_timestamp": all(r["completed_at"] == matches[0]["completed_at"] for r in results),
            "completed_count_increased_once": summary["completed_task_count"] == baseline["completed_task_count"] + 1,
            "retry_preserves_timestamp": retry["completed_at"] == matches[0]["completed_at"],
            "no_automatic_execution": not any(e["task_id"] == tid for e in current["executions"]),
        }
    except Exception as exc:
        error = exc
        report["error_type"] = type(exc).__name__
    finally:
        # If creation timed out after reaching the server, recover by this run's
        # UUID title. Never delete a pre-existing or differently named Task.
        current = request("/export")
        owned = [t for t in current["tasks"] if t["title"] == title]
        assert len(owned) <= 1, "Unexpected duplicate temporary Task; inspect before cleanup"
        for task in owned:
            assert tid is None or task["id"] == tid
            request(f"/tasks/{task['id']}", "DELETE")
        after = request("/export")
        report["temporary_task_removed"] = not any(t["title"] == title for t in after["tasks"])
        report["original_export_unchanged"] = before == after
        report["summary_restored"] = baseline == request(f"/plans/{pid}/summary")
        report["passed"] = (error is None and all(report.get("checks", {}).values())
                            and report["temporary_task_removed"]
                            and report["original_export_unchanged"] and report["summary_restored"])
        REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
