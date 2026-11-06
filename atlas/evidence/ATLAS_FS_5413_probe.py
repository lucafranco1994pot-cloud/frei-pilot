"""ATLAS-FS-20261106-003: offline approval-scope observation.

Requires openai-agents==0.24.0. Uses the real SDK and ScriptedModel.
The outcome is an observed behavior, NOT a normative SDK-contract verdict.
"""
import asyncio
import hashlib
import json
import platform
import traceback
from importlib.metadata import version
from pathlib import Path

from agents import Agent, RunConfig, Runner, function_tool
from agents.testing import ScriptedModel, assistant_message, function_call

CFG = RunConfig(tracing_disabled=True)
OUTPUT = Path("ATLAS_FS_5413_results.json")


def scripted(*names):
    return ScriptedModel(
        [[function_call("write_marker", {"path": name}, call_id=f"c_{name}")]
         for name in names] + [[assistant_message("done")]]
    )


def describe(items):
    return [
        {"tool_name": item.tool_name, "arguments": item.arguments}
        for item in items
    ]


async def scenario(send_stale):
    effects = []

    @function_tool(needs_approval=True)
    def write_marker(path: str) -> str:
        """Record a local marker without external side effects."""
        effects.append(path)
        return "ok"

    first_model = scripted("A")
    agent = Agent(name="ATLAS", model=first_model, tools=[write_marker])
    first = await Runner.run(agent, "first independent run", run_config=CFG)
    assert len(first.interruptions) == 1, "first run must interrupt on A"
    old_a = first.interruptions[0]
    s1 = first.to_state()
    s1.approve(old_a)
    first_done = await Runner.run(agent, s1, run_config=CFG)
    assert not first_done.interruptions, "first run must finish"
    assert effects == ["A"], f"first approval did not execute exactly A: {effects!r}"
    first_model.assert_complete()

    second_model = scripted("B", "A")
    agent.model = second_model  # Keep the SAME Agent instance.
    second = await Runner.run(agent, "second independent run", run_config=CFG)
    assert len(second.interruptions) == 1, "second run must interrupt on B"
    assert second.interruptions[0].arguments, "second interruption has no arguments"
    current_b = second.interruptions[0]
    s2 = second.to_state()
    stale_exception = None
    if send_stale:
        try:
            s2.approve(old_a)
        except Exception as error:
            stale_exception = f"{type(error).__name__}: {error}"
    s2.approve(current_b)
    after_b = await Runner.run(agent, s2, run_config=CFG)
    observed = {
        "stale_approval_submitted": send_stale,
        "stale_approval_exception": stale_exception,
        "effects_before_current_A_approval": list(effects),
        "interruptions_after_B": describe(after_b.interruptions),
        "A_executed_in_run2_before_current_approval": effects.count("A") == 2,
        "remaining_model_steps_after_B": second_model.remaining_steps,
    }
    # The control must pause on A. Approve the CURRENT item to verify ordinary resume.
    if after_b.interruptions:
        assert len(after_b.interruptions) == 1, "unexpected number of pending approvals"
        assert after_b.interruptions[0].tool_name == "write_marker"
        sa = after_b.to_state()
        sa.approve(after_b.interruptions[0])
        finished = await Runner.run(agent, sa, run_config=CFG)
        observed["legitimate_current_resume"] = {
            "effects": list(effects),
            "interruptions": describe(finished.interruptions),
        }
    second_model.assert_complete()  # Prevent false results from incomplete scripts.
    return observed


async def main():
    report = {
        "case": "ATLAS-FS-20261106-003",
        "python": platform.python_version(),
        "sdk_version": version("openai-agents"),
        "method": "original SDK + ScriptedModel; no API key or live tool effects",
        "scenarios": {},
        "status": "INCOMPLETE",
    }
    exit_code = 3
    try:
        for label, send_stale in (("stale", True), ("control_without_stale", False)):
            try:
                report["scenarios"][label] = await scenario(send_stale)
            except Exception as exc:
                report["scenarios"][label] = {
                    "status": "HARNESS_OR_RUNTIME_ERROR",
                    "error": f"{type(exc).__name__}: {exc}",
                    "traceback": traceback.format_exc(),
                }
        s = report["scenarios"]["stale"]
        c = report["scenarios"]["control_without_stale"]
        if "error" in s or "error" in c:
            report["status"] = "BLOCKED"
            exit_code = 3
        else:
            isolated = (
                s["stale_approval_exception"] is None
                and s["A_executed_in_run2_before_current_approval"]
                and not s["interruptions_after_B"]
                and not c["A_executed_in_run2_before_current_approval"]
                and len(c["interruptions_after_B"]) == 1
                and c.get("legitimate_current_resume", {}).get("interruptions") == []
                and c.get("legitimate_current_resume", {}).get("effects") == ["A", "B", "A"]
            )
            report["difference_isolated"] = isolated
            report["status"] = "REPRODUCED" if isolated else "NOT_REPRODUCED"
            exit_code = 0 if isolated else 2
    finally:
        OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(OUTPUT.read_text(encoding="utf-8"))
        print("RESULT_SHA256", hashlib.sha256(OUTPUT.read_bytes()).hexdigest())
    return exit_code


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
