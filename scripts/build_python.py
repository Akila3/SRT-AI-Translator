"""Bundle the gemini-srt-translator CLI into a standalone `gst` executable.

Produces resources/bin/gst[.exe] which electron-builder ships via extraResources.
Run once before packaging:  npm run build:python

Note: PyInstaller does not cross-compile. Build each OS on that OS.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "resources" / "bin"
WORK = ROOT / "build" / "python"
ENTRY = ROOT / "scripts" / "gst_entry.py"


def ensure_installed() -> None:
    try:
        import gemini_srt_translator  # noqa: F401
    except ImportError:
        sys.exit(
            "gemini-srt-translator is not installed.\n"
            "Run: pip install gemini-srt-translator pyinstaller"
        )


def main() -> None:
    ensure_installed()
    entry = str(ENTRY)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onefile",
        "--name",
        "gst",
        "--distpath",
        str(OUT_DIR),
        "--workpath",
        str(WORK),
        "--specpath",
        str(WORK),
        "--collect-all",
        "gemini_srt_translator",
        "--copy-metadata",
        "gemini-srt-translator",
        entry,
    ]
    print("Running:", " ".join(cmd))
    result = subprocess.run(cmd)
    if result.returncode != 0:
        sys.exit("PyInstaller build failed.")

    produced = OUT_DIR / ("gst.exe" if os.name == "nt" else "gst")
    if produced.exists():
        print(f"\nBuilt: {produced}")
    else:
        sys.exit("Build finished but executable not found.")


if __name__ == "__main__":
    main()
