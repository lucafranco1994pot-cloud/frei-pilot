"""ATLAS-DEPENDENCY-REPLAY-01: parent exception after a dependent task is persisted.

This is an exception/retry experiment, not an OS process-kill experiment.
Run: python repro.py
"""
import json
import sys
import uuid
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.func import entrypoint, task


def probe(fail_status_once: bool):
    events = []
    state = {"status_calls": 0, "parent_calls": 0}

    @task
    def check_status() -> str:
        state["status_calls"] += 1
        n = state["status_calls"]
        events.append(f"check_status#{n}")
        if fail_status_once and n == 1:
            raise ConnectionError("transient read error")
        return "up"

    @task
    def draft_alert(status: str) -> str:
        events.append(f"draft_alert({status})")
        return f"Alert: status={status}"

    @entrypoint(checkpointer=InMemorySaver())
    def workflow(_):
        state["parent_calls"] += 1
        try:
            status = check_status().result()
        except ConnectionError:
            status = "down"
        alert = draft_alert(status).result()
        events.append(f"parent_snapshot({status}, {alert})")
        if state["parent_calls"] == 1:
            raise RuntimeError("simulated parent failure AFTER draft_alert.result()")
        return {"status": status, "alert": alert}

    config = {"configurable": {"thread_id": uuid.uuid4().hex}}
    initial = None
    try:
        workflow.invoke("check", config, durability="sync")
        initial = "UNEXPECTED_FIRST_RUN_SUCCESS"
    except RuntimeError as exc:
        initial = f"RuntimeError: {exc}"

    result = workflow.invoke(None, config, durability="sync")
    consistent = result["alert"] == f"Alert: status={result['status']}"
    return {"fail_status_once": fail_status_once, "initial": initial,
            "result": result, "consistent": consistent,
            "events": events, "counters": state}


def main():
    cases = []
    for fail in (False, True):
        try:
            cases.append(probe(fail))
        except Exception as exc:
            cases.append({"fail_status_once": fail, "execution_error": repr(exc)})
    report = {"case": "ATLAS-DEPENDENCY-REPLAY-01",
              "environment": "in-process parent exception/retry; no host kill",
              "results": cases}
    print("ATLAS_RESULT=" + json.dumps(report, sort_keys=True), flush=True)
    errors = [r for r in cases if "execution_error" in r]
    if errors:
        print("ATLAS_STATUS=BLOCKED", flush=True)
        return 2
    if not cases[0]["consistent"]:
        print("ATLAS_STATUS=INVALID_CONTROL", flush=True)
        return 3
    if not cases[1]["consistent"]:
        print("ATLAS_STATUS=RED_INCONSISTENT_DEPENDENCY", flush=True)
        return 0  # Detecting a bug is a completed diagnostic, not a green correctness claim.
    print("ATLAS_STATUS=GREEN_NO_DIVERGENCE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
