"""ATLAS guardrail-tripwire evidence reproducer.

Target: openai-agents==0.24.0, Python 3.13, public Runner.run.
Records (1) original SDK task states before tripwire cancellation and
(2) uninstrumented public Runner.run observations as an observer control.
No API key / network model calls. A zero exit code means that the *bug baseline*
was reproduced, NOT that the SDK is fixed.

Only the input guardrail path is in scope. Results in JSON are observations,
not a claim of independent confirmation until a CI execution is available.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import traceback

from agents import (
    Agent,
    GuardrailFunctionOutput,
    InputGuardrailTripwireTriggered,
    RunConfig,
    Runner,
    input_guardrail,
)
from agents.models.interface import Model
import agents.run_internal.guardrails as guardrails_module

EXPECTED_VERSION = "0.24.0"
REPETITIONS = 20
OUT = Path(os.environ.get("ATLAS_EVIDENCE_OUT", "ATLAS_guardrail_tripwire_results.json"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class IdleModel(Model):
    async def get_response(self, *args, **kwargs):
        await asyncio.sleep(5)
        raise AssertionError("Unexpected model completion (input tripwire did not stop run)")

    def stream_response(self, *args, **kwargs):
        raise AssertionError("Streaming out of scope")


class AsCompletedObserver:
    """Intercept only the module's as_completed; all other asyncio APIs delegate."""

    def __init__(self, real_asyncio, snapshots):
        self.real_asyncio = real_asyncio
        self.snapshots = snapshots

    def __getattr__(self, key):
        return getattr(self.real_asyncio, key)

    def as_completed(self, tasks):
        original_tasks = tuple(tasks)  # the actual SDK-created asyncio.Tasks
        iterator = self.real_asyncio.as_completed(original_tasks)

        async def await_and_snapshot(completion):
            result = await completion
            if result.output.tripwire_triggered:
                # No await from here until returning the tripwire result to SDK.
                rows = []
                for task in original_tasks:
                    row = {"done": task.done(), "cancelled": task.cancelled()}
                    if task.done() and not task.cancelled():
                        try:
                            finished = task.result()
                        except BaseException as error:
                            row.update({"succeeded": False, "exception": type(error).__name__})
                        else:
                            row.update({
                                "succeeded": True,
                                "guardrail": finished.guardrail.get_name(),
                                "tripwire": bool(finished.output.tripwire_triggered),
                            })
                    rows.append(row)
                self.snapshots.append(rows)
            return result

        return (await_and_snapshot(completion) for completion in iterator)


@input_guardrail(name="trips", run_in_parallel=True)
async def trips(ctx, agent, inp):
    return GuardrailFunctionOutput(output_info="trip", tripwire_triggered=True)


@input_guardrail(name="passes", run_in_parallel=True)
async def passes(ctx, agent, inp):
    return GuardrailFunctionOutput(output_info="pass", tripwire_triggered=False)


async def one_trial(order: str, instrumented: bool) -> dict:
    chosen = [trips, passes] if order == "trip-first" else [passes, trips]
    row: dict = {"order": order, "instrumented": instrumented, "verdict": "INCONCLUSIVE"}
    snapshots: list = []
    old_asyncio = guardrails_module.asyncio
    if instrumented:
        guardrails_module.asyncio = AsCompletedObserver(asyncio, snapshots)
    try:
        agent = Agent(name="ATLAS tripwire baseline", model=IdleModel(), input_guardrails=chosen)
        try:
            await Runner.run(agent, "hi", run_config=RunConfig(tracing_disabled=True))
        except InputGuardrailTripwireTriggered as error:
            if error.run_data is None:
                row["reason"] = "Missing exception.run_data"
                return row
            reported = [r.guardrail.get_name() for r in error.run_data.input_guardrail_results]
            row["reported"] = reported
            counts = Counter(reported)
            row["counts"] = dict(counts)
            row["tripwire_preserved"] = error.guardrail_result.guardrail.get_name() == "trips"
            if not row["tripwire_preserved"]:
                row["reason"] = "Unexpected tripwire result"
                return row
            if any(name not in {"trips", "passes"} for name in reported):
                row["reason"] = "Unexpected guardrail name in public results"
                return row
            if counts["trips"] != 1:
                row["reason"] = "Tripping guardrail not present exactly once"
                return row

            if instrumented:
                row["snapshots"] = snapshots
                if len(snapshots) != 1:
                    row["reason"] = "Expected exactly one pre-cancellation snapshot"
                    return row
                original = snapshots[0]
                if len(original) != 2 or not all(
                    r.get("done") is True
                    and r.get("cancelled") is False
                    and r.get("succeeded") is True
                    for r in original
                ):
                    row["reason"] = "Not both original SDK tasks successfully done before cancel"
                    return row
                snapshot_by_name = {r.get("guardrail"): r for r in original}
                if set(snapshot_by_name) != {"trips", "passes"}:
                    row["reason"] = "Original task names not unique or incomplete"
                    return row
                if snapshot_by_name["trips"]["tripwire"] is not True or snapshot_by_name["passes"]["tripwire"] is not False:
                    row["reason"] = "Incorrect tripwire classifications"
                    return row

                row["missing"] = [name for name in ("trips", "passes") if counts[name] == 0]
                row["duplicates"] = [name for name in ("trips", "passes") if counts[name] > 1]
                row["verdict"] = (
                    "CONTRACT_VIOLATION_OBSERVED" if row["missing"] or row["duplicates"]
                    else "NO_OMISSION_OBSERVED"
                )
            else:
                # No task-timing claim is made for the uninstrumented public-output check.
                row["public_omission"] = "passes" not in counts
                row["duplicates"] = [name for name in ("trips", "passes") if counts[name] > 1]
                row["verdict"] = (
                    "PUBLIC_OMISSION_OBSERVED" if row["public_omission"]
                    else "NO_PUBLIC_OMISSION_OBSERVED"
                )
            return row
        except Exception as error:
            row["reason"] = f"Unexpected exception: {type(error).__name__}: {error}"
            return row
        row["reason"] = "Runner.run returned without a tripwire exception"
        return row
    finally:
        if instrumented:
            guardrails_module.asyncio = old_asyncio


async def collect_trials() -> list[dict]:
    rows = []
    for instrumented in (True, False):
        for order in ("trip-first", "pass-first"):
            for trial in range(1, REPETITIONS + 1):
                result = await one_trial(order, instrumented)
                result["trial"] = trial
                rows.append(result)
    return rows


def decide(rows: list[dict]) -> tuple[str, dict]:
    def subset(instrumented, order):
        return [r for r in rows if r["instrumented"] == instrumented and r["order"] == order]

    groups = {
        "instrumented_trip_first": subset(True, "trip-first"),
        "instrumented_pass_first": subset(True, "pass-first"),
        "unmodified_trip_first": subset(False, "trip-first"),
        "unmodified_pass_first": subset(False, "pass-first"),
    }
    summary = {key: dict(Counter(row["verdict"] for row in val)) for key, val in groups.items()}
    if any(len(val) != REPETITIONS for val in groups.values()):
        return "INCONCLUSIVE", summary
    if any(row["verdict"] == "INCONCLUSIVE" or row.get("duplicates") for row in rows):
        return "INCONCLUSIVE", summary

    # Need at least one genuine pre-cancel contract violation, the same public
    # omission without instrumentation, and clean reverse-order controls.
    if (
        any(row["verdict"] == "CONTRACT_VIOLATION_OBSERVED" and row.get("missing") == ["passes"] for row in groups["instrumented_trip_first"])
        and any(row["verdict"] == "PUBLIC_OMISSION_OBSERVED" for row in groups["unmodified_trip_first"])
        and all(row["verdict"] == "NO_OMISSION_OBSERVED" for row in groups["instrumented_pass_first"])
        and all(row["verdict"] == "NO_PUBLIC_OMISSION_OBSERVED" for row in groups["unmodified_pass_first"])
    ):
        return "BASELINE_REPRODUCED", summary
    if (
        all(row["verdict"] == "NO_OMISSION_OBSERVED" for row in groups["instrumented_trip_first"])
        and all(row["verdict"] == "NO_PUBLIC_OMISSION_OBSERVED" for row in groups["unmodified_trip_first"])
    ):
        return "NO_OMISSION_OBSERVED", summary
    return "INCONCLUSIVE", summary


def main() -> int:
    result = {
        "verdict": "INCONCLUSIVE",
        "note": "Baseline bug reproduction: exit code 0 means bug observed, not SDK fixed",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "expected_sdk_version": EXPECTED_VERSION,
        "python_version": sys.version,
        "workflow_commit": os.environ.get("GITHUB_SHA", "LOCAL"),
        "workflow_run_id": os.environ.get("GITHUB_RUN_ID", "LOCAL"),
        "reproducer_sha256": sha256(Path(__file__)),
        "sdk_guardrails_path": str(Path(guardrails_module.__file__).resolve()),
        "sdk_guardrails_sha256": sha256(Path(guardrails_module.__file__)),
        "observer_contract": "snapshot original SDK tasks after tripwire completion awaited and before SDK cancel; no intervening await",
        "trials_per_group": REPETITIONS,
        "groups": ["instrumented_trip_first", "instrumented_pass_first", "unmodified_trip_first", "unmodified_pass_first"],
        "runs": [],
    }
    try:
        result["sdk_version"] = importlib.metadata.version("openai-agents")
        if result["sdk_version"] != EXPECTED_VERSION:
            result["reason"] = "SDK package version differs from frozen baseline"
            return 2
        result["runs"] = asyncio.run(collect_trials())
        verdict, summary = decide(result["runs"])
        result["verdict"] = verdict
        result["summary"] = summary
        return 0 if verdict == "BASELINE_REPRODUCED" else 2
    except BaseException as error:
        result["reason"] = f"Unexpected harness error: {type(error).__name__}: {error}"
        result["traceback"] = traceback.format_exc()
        return 3
    finally:
        # Write *after* verdict. A JSON file alone does not prove success;
        # the process exit code, workflow status and artifact must all be checked.
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("ATLAS_VERDICT:", result["verdict"], flush=True)
        print("ATLAS_SUMMARY:", json.dumps(result.get("summary", {}), sort_keys=True), flush=True)
        print("ATLAS_EVIDENCE_FILE:", OUT, flush=True)
        print("ATLAS_EVIDENCE_SHA256:", sha256(OUT), flush=True)
        if result["verdict"] == "BASELINE_REPRODUCED":
            print("ATLAS_BASELINE_REPRODUCED: AFFECTED VERSION (NOT FIXED)", flush=True)


if __name__ == "__main__":
    sys.exit(main())
