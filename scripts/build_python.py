"""Bundle the gemini-srt-translator CLI into a standalone `gst` executable.

Produces resources/bin/gst[.exe] which electron-builder ships via extraResources.
Run once before packaging:  npm run build:python

Note: PyInstaller does not cross-compile. Build each OS on that OS.

The driver script runs in an ISOLATED virtualenv (.venv-build) that is never put on
the ambient PATH, because `resolveGstBin()` returns a bare `gst` in dev: a global
pip install would shadow the shipped binary and every dev-run test would silently
measure the wrong artifact. A missing driver venv is a hard error, not a fallback.

The freeze itself does not use that driver environment. Pre/post hashes of a mutable
tree cannot see a file that changes and is restored (SOL-43 remainder), and the same
is true of site-packages (SOL-45 remainder). Inputs are copied to a read-only staging
dir, and PyInstaller runs inside a throwaway venv created from the staged lock.

Set up the driver venv with:
    py -3.14 -m venv .venv-build
    .venv-build\\Scripts\\python.exe -m pip install -r scripts/build-python-requirements.lock
"""
import hashlib
import json
import os
import re
import shutil
import stat
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
SNAPSHOT = WORK / "freeze-inputs"
FREEZE_VENV = WORK / "venv-freeze"
PYI_WORK = WORK / "pyi"

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
# The interpreter the lock was frozen on. Patch-level may move; major.minor must not.
REQUIRED_PYTHON = (3, 14)

# Packages whose data files / dynamically imported submodules PyInstaller cannot
# discover by static analysis. Over-collecting costs binary size; under-collecting
# costs a runtime ModuleNotFoundError in a code path a smoke test may never reach.
COLLECT_ALL = ["gemini_srt_translator", "pysubs2", "google.genai"]
COPY_METADATA = ["gemini-srt-translator", "pysubs2", "google-genai"]

# pip and wheel are installed by `venv` itself and are not pins in the lock.
_LOCK_EXCLUDE = {"pip", "wheel"}


def venv_python(root: Path) -> Path:
    return root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def reexec_in_build_venv() -> None:
    """Re-run this script with the isolated 3.14 driver. Never the ambient one."""
    target = venv_python(VENV)
    if not target.exists():
        sys.exit(
            "No isolated build venv at .venv-build.\n"
            "This freeze will not use the ambient interpreter — that is how a lock-stamped\n"
            "binary can contain something else (SOL-45).\n"
            "Create it first:\n"
            "  py -3.14 -m venv .venv-build\n"
            f'  .venv-build\\Scripts\\python.exe -m pip install -r "{LOCK}"'
        )
    try:
        already_inside = Path(sys.executable).resolve() == target.resolve()
    except OSError:
        already_inside = False
    if already_inside:
        return
    print(f"Re-executing inside the isolated build venv: {target}")
    result = subprocess.run([str(target), str(Path(__file__).resolve()), *sys.argv[1:]])
    sys.exit(result.returncode)


def canonicalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_pins(text: str) -> dict[str, str]:
    pkgs: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "==" not in line:
            continue
        name, ver = line.split("==", 1)
        key = canonicalize(name)
        if key in _LOCK_EXCLUDE:
            continue
        pkgs[key] = ver.strip()
    return pkgs


def python_mm(python: str) -> tuple[int, int]:
    result = subprocess.run(
        [python, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        sys.exit(f"Could not read interpreter version ({python}): {result.stderr.strip()}")
    parts = result.stdout.split()
    return int(parts[0]), int(parts[1])


def ensure_lock_matches(python: str, lock_path: Path) -> None:
    """Prove this interpreter's distributions match the (staged) lock."""
    mm = python_mm(python)
    if mm != REQUIRED_PYTHON:
        sys.exit(
            f"Build interpreter is Python {mm[0]}.{mm[1]} ({python}), but this recipe is "
            f"pinned to {REQUIRED_PYTHON[0]}.{REQUIRED_PYTHON[1]}."
        )
    if not lock_path.exists():
        sys.exit(f"Requirements lock is missing: {lock_path}")
    locked = parse_pins(lock_path.read_text(encoding="utf-8"))
    freeze = subprocess.run(
        [python, "-m", "pip", "freeze"],
        capture_output=True,
        text=True,
        check=False,
    )
    if freeze.returncode != 0:
        sys.exit(f"pip freeze failed: {freeze.stderr.strip() or freeze.stdout}")
    installed = parse_pins(freeze.stdout)
    missing = sorted(k for k in locked if installed.get(k) != locked[k])
    extra = sorted(k for k in installed if k not in locked)
    if missing or extra:
        lines = ["Installed distributions do not match the requirements lock."]
        for name in missing:
            lines.append(f"  lock {name}=={locked[name]}  env {installed.get(name, 'MISSING')}")
        for name in extra:
            lines.append(f"  extra in env: {name}=={installed[name]}")
        lines.append(f'Reinstall from the lock: pip install -r "{lock_path}"')
        sys.exit("\n".join(lines))
    gst = installed.get("gemini-srt-translator")
    if gst != REQUIRED_GST_VERSION:
        sys.exit(
            f"gemini-srt-translator {gst or 'MISSING'} is installed but this build is pinned to "
            f"{REQUIRED_GST_VERSION}."
        )
    print(f"Lock: {len(locked)} pins match pip freeze ({python})")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fingerprint_staged(snapshot: Path) -> dict[str, str]:
    return {name: sha256(snapshot / name) for name in BUILD_INPUTS}


def rmtree(path: Path) -> None:
    if not path.exists():
        return

    def onexc(fn, p, exc):
        try:
            os.chmod(p, stat.S_IWUSR | stat.S_IRUSR | stat.S_IXUSR)
            fn(p)
        except OSError:
            raise exc

    shutil.rmtree(path, onexc=onexc)


def make_readonly_files(root: Path) -> None:
    if root.is_file():
        os.chmod(root, stat.S_IREAD)
        return
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            try:
                os.chmod(Path(dirpath) / name, stat.S_IREAD)
            except OSError:
                pass


def site_packages(venv: Path) -> Path:
    if os.name == "nt":
        return venv / "Lib" / "site-packages"
    found = list((venv / "lib").glob("python*/site-packages"))
    if len(found) != 1:
        sys.exit(f"Could not locate site-packages under {venv}")
    return found[0]


def stage_inputs() -> dict[str, str]:
    rmtree(SNAPSHOT)
    hashes: dict[str, str] = {}
    for name, src in BUILD_INPUTS.items():
        dest = SNAPSHOT / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        hashes[name] = sha256(dest)
        os.chmod(dest, stat.S_IREAD)
    return hashes


def create_freeze_venv(lock_path: Path) -> str:
    """A throwaway interpreter installed from the staged lock. Not the driver venv."""
    rmtree(FREEZE_VENV)
    created = subprocess.run([sys.executable, "-m", "venv", str(FREEZE_VENV)])
    if created.returncode != 0:
        sys.exit("Could not create the disposable freeze venv.")
    python = str(venv_python(FREEZE_VENV))
    print(f"Installing the freeze environment from the staged lock into {FREEZE_VENV}")
    installed = subprocess.run(
        [
            python,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            str(lock_path),
        ]
    )
    if installed.returncode != 0:
        sys.exit("pip install of the staged lock into the disposable freeze venv failed.")
    ensure_lock_matches(python, lock_path)
    make_readonly_files(site_packages(FREEZE_VENV))
    return python


def discard_artifact(produced: Path, reason: str) -> None:
    produced.unlink(missing_ok=True)
    if STAMP.exists():
        STAMP.unlink()
    sys.exit(reason)


def write_stamp(produced: Path, inputs: dict[str, str]) -> None:
    """Record the staged input snapshot, for check-bin.mjs to verify before packaging."""
    STAMP.parent.mkdir(parents=True, exist_ok=True)
    STAMP.write_text(
        json.dumps(
            {
                "binary": produced.name,
                "binarySha256": sha256(produced),
                "inputs": inputs,
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
    if sys.version_info[:2] != REQUIRED_PYTHON:
        sys.exit(
            f"Build interpreter is Python {sys.version_info.major}.{sys.version_info.minor} "
            f"({sys.executable}), but this recipe is pinned to "
            f"{REQUIRED_PYTHON[0]}.{REQUIRED_PYTHON[1]}."
        )
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    PYI_WORK.mkdir(parents=True, exist_ok=True)

    before = stage_inputs()
    staged_lock = SNAPSHOT / "scripts" / "build-python-requirements.lock"
    staged_entry = SNAPSHOT / "scripts" / "gst_entry.py"

    try:
        freeze_python = create_freeze_venv(staged_lock)
        cmd = [
            freeze_python,
            "-m",
            "PyInstaller",
            "--onefile",
            "--noconfirm",
            "--name",
            "gst",
            "--distpath",
            str(OUT_DIR),
            "--workpath",
            str(PYI_WORK),
            "--specpath",
            str(PYI_WORK),
        ]
        for pkg in COLLECT_ALL:
            cmd += ["--collect-all", pkg]
        for pkg in COPY_METADATA:
            cmd += ["--copy-metadata", pkg]
        cmd.append(str(staged_entry))

        print("Running:", " ".join(cmd))
        env = os.environ.copy()
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        result = subprocess.run(cmd, env=env)
        if result.returncode != 0:
            sys.exit("PyInstaller build failed.")

        produced = OUT_DIR / ("gst.exe" if os.name == "nt" else "gst")
        if not produced.exists():
            sys.exit("Build finished but executable not found.")

        after = fingerprint_staged(SNAPSHOT)
        if after != before:
            discard_artifact(
                produced,
                "Staged freeze inputs changed while PyInstaller was running, so the binary "
                "and the stamp would disagree about what was frozen. Restart the freeze.",
            )
        try:
            ensure_lock_matches(freeze_python, staged_lock)
        except SystemExit as exc:
            reason = (
                exc.code
                if isinstance(exc.code, str)
                else "Installed distributions no longer match the lock after the freeze."
            )
            discard_artifact(produced, reason)
        write_stamp(produced, before)
        print(f"\nBuilt: {produced}")
    finally:
        rmtree(FREEZE_VENV)


if __name__ == "__main__":
    main()
