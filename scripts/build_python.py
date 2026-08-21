"""Bundle the gemini-srt-translator CLI into a standalone `gst` executable.

Produces resources/bin/gst[.exe] which electron-builder ships via extraResources.
Run once before packaging:  npm run build:python

Note: PyInstaller does not cross-compile. Build each OS on that OS.

The engine is installed into an ISOLATED virtualenv (.venv-build) that is never put
on the ambient PATH, because `resolveGstBin()` returns a bare `gst` in dev: a global
pip install would shadow the shipped binary and every dev-run test would silently
measure the wrong artifact. This script re-executes itself inside that venv when it
finds one, so `npm run build:python` keeps working from the ambient interpreter.

Set up the venv with:
    py -3.14 -m venv .venv-build
    .venv-build\\Scripts\\python.exe -m pip install -r scripts/build-python-requirements.lock
"""
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "resources" / "bin"
WORK = ROOT / "build" / "python"
ENTRY = ROOT / "scripts" / "gst_entry.py"
VENV = ROOT / ".venv-build"
LOCK = ROOT / "scripts" / "build-python-requirements.lock"

# Records what produced the binary now sitting in resources/bin.
#
# The executable is git-ignored, so nothing a packaging run can see changes when its inputs
# do: check-bin.mjs would pass on a stale binary and ship a release without the change.
# Every input that can alter the frozen artifact is fingerprinted, not just the entry shim —
# the pinned engine version and the PyInstaller collection recipe both live in THIS file, and
# the exact dependency set lives in the lock, so a pin bump with an untouched shim would
# otherwise look identical to a current build. Kept in the git-ignored work directory rather
# than beside the binary, because the extraResources filter is `gst*` and anything matching it
# is packaged into the app.
STAMP = WORK / "gst.buildstamp.json"
BUILD_INPUTS = {
    "scripts/gst_entry.py": ENTRY,
    "scripts/build_python.py": Path(__file__).resolve(),
    "scripts/build-python-requirements.lock": LOCK,
}

# The engine release this build is pinned to. Bump this and the lock file together.
REQUIRED_GST_VERSION = "3.7.0"

# Packages whose data files / dynamically imported submodules PyInstaller cannot
# discover by static analysis. Over-collecting costs binary size; under-collecting
# costs a runtime ModuleNotFoundError in a code path a smoke test may never reach.
COLLECT_ALL = ["gemini_srt_translator", "pysubs2", "google.genai"]
COPY_METADATA = ["gemini-srt-translator", "pysubs2", "google-genai"]


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def reexec_in_build_venv() -> None:
    """Re-run this script with the isolated build interpreter, if one exists."""
    target = venv_python()
    if not target.exists():
        return
    try:
        already_inside = Path(sys.executable).resolve() == target.resolve()
    except OSError:
        already_inside = False
    if already_inside:
        return
    print(f"Re-executing inside the isolated build venv: {target}")
    result = subprocess.run([str(target), str(Path(__file__).resolve()), *sys.argv[1:]])
    sys.exit(result.returncode)


def installed_version() -> str:
    from importlib import metadata

    return metadata.version("gemini-srt-translator")


def ensure_installed() -> None:
    """Assert the engine imports AND is the pinned release.

    Importability alone is not enough: without a version assertion the script will
    happily freeze whatever release happens to be installed, which is exactly how a
    stale engine can ship without any source change.
    """
    try:
        import gemini_srt_translator  # noqa: F401
    except ImportError:
        sys.exit(
            "gemini-srt-translator is not installed in this interpreter "
            f"({sys.executable}).\n"
            "Create the isolated build environment first:\n"
            "  py -3.14 -m venv .venv-build\n"
            f'  .venv-build\\Scripts\\python.exe -m pip install -r "{LOCK}"'
        )

    try:
        version = installed_version()
    except Exception as exc:  # pragma: no cover - metadata should always be present
        sys.exit(f"Could not determine the installed gemini-srt-translator version: {exc}")

    if version != REQUIRED_GST_VERSION:
        sys.exit(
            f"gemini-srt-translator {version} is installed but this build is pinned to "
            f"{REQUIRED_GST_VERSION}.\n"
            f'Run: pip install "gemini-srt-translator=={REQUIRED_GST_VERSION}"\n'
            "and regenerate scripts/build-python-requirements.lock."
        )

    print(f"Engine: gemini-srt-translator {version} ({sys.executable})")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def write_stamp(produced: Path) -> None:
    """Record what this build was made from, for check-bin.mjs to verify before packaging."""
    STAMP.parent.mkdir(parents=True, exist_ok=True)
    STAMP.write_text(
        json.dumps(
            {
                "binary": produced.name,
                "binarySha256": sha256(produced),
                "inputs": {name: sha256(path) for name, path in BUILD_INPUTS.items()},
                "engineVersion": REQUIRED_GST_VERSION,
                "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Build stamp: {STAMP}")


def main() -> None:
    reexec_in_build_venv()
    ensure_installed()
    entry = str(ENTRY)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onefile",
        "--noconfirm",
        "--name",
        "gst",
        "--distpath",
        str(OUT_DIR),
        "--workpath",
        str(WORK),
        "--specpath",
        str(WORK),
    ]
    for pkg in COLLECT_ALL:
        cmd += ["--collect-all", pkg]
    for pkg in COPY_METADATA:
        cmd += ["--copy-metadata", pkg]
    cmd.append(entry)

    print("Running:", " ".join(cmd))
    result = subprocess.run(cmd)
    if result.returncode != 0:
        sys.exit("PyInstaller build failed.")

    produced = OUT_DIR / ("gst.exe" if os.name == "nt" else "gst")
    if produced.exists():
        write_stamp(produced)
        print(f"\nBuilt: {produced}")
    else:
        sys.exit("Build finished but executable not found.")


if __name__ == "__main__":
    main()
