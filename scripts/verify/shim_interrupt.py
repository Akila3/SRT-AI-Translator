"""Regression probe for the frozen shim's abort and interrupt handling.

Run it with:  python scripts/verify/shim_interrupt.py

Why this exists
---------------
`scripts/gst_entry.py` binds `exit`/`quit` (absent in a frozen build, because PyInstaller does
not run `site`) and normalises the exit code of an interrupted run. Neither behaviour can be
observed in `npm run dev` — `resolveGstBin()` falls back to a pip-installed `gst` there, which
already has a real `exit` — and neither is reachable from the TypeScript gates. Without this
probe a careless shim edit would silently restore either defect, exactly as `run-buffering.mjs`
guards REP-11a's line buffering.

Each case runs in a child interpreter started with `-S`, which disables the `site` module and so
reproduces the condition a frozen build is permanently in. The child replays the two interrupt
handler shapes the engine installs (`main.py` 801-814 for translation, 1601-1622 for
transcription) and the plain abort sites, and the parent asserts the resulting exit code.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SHIM = ROOT / "scripts" / "gst_entry.py"

# (case, expected exit code, what it proves)
CASES = [
    ("transcribe", 130, "an interrupted transcription cannot report success"),
    ("translate", 130, "an interrupted translation keeps the engine's own 130"),
    ("clean", 0, "a completed run is still a completed run"),
    ("failure", 1, "a real failure keeps its own code"),
    ("abort", 1, "a bare exit(1) aborts instead of raising NameError"),
    ("ignored", 0, "registering SIG_IGN does not break the wrapper"),
]


def child(case: str) -> None:
    import signal

    prelude = SHIM.read_text(encoding="utf-8").split("from gemini_srt_translator.cli import main")[0]
    exec(compile(prelude, "gst_entry_prelude", "exec"), globals())

    if case in ("transcribe", "translate"):
        # The engine saves partial output and then exits: 0 on the transcribe path, 130 on the
        # translate one. A success code after an interrupt is what this probe exists to catch.
        engine_code = 0 if case == "transcribe" else 130

        def handler(signum, frame):
            print(f"{case} interrupted. Saving partial results...")
            exit(engine_code)

        signal.signal(signal.SIGINT, handler)
        signal.raise_signal(signal.SIGINT)

    elif case == "ignored":
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        exit(0)

    elif case == "clean":
        exit(0)

    elif case == "abort" or case == "failure":
        exit(1)


def main() -> None:
    if len(sys.argv) > 1:
        child(sys.argv[1])
        return

    if not SHIM.exists():
        sys.exit(f"Shim not found: {SHIM}")

    print(f"Shim: {SHIM}")
    print("Child interpreters run with -S, reproducing the frozen build's missing `site`.\n")

    failures = 0
    for case, expected, describes in CASES:
        result = subprocess.run(
            [sys.executable, "-S", str(Path(__file__).resolve()), case],
            capture_output=True,
            text=True,
        )
        ok = result.returncode == expected
        if not ok:
            failures += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {describes}")
        print(f"        expected {expected}, got {result.returncode}")

    print()
    if failures:
        sys.exit(f"{failures} case(s) failed.")
    print("PASS  the shim aborts, and never reports an interrupted run as finished")


if __name__ == "__main__":
    main()
