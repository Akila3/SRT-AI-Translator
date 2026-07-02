"""PyInstaller entry shim.

Importing the package's CLI `main` (rather than running cli.py as a script)
preserves the package context so the module's relative imports resolve.
"""
import builtins
import io
import sys

# The PyInstaller-frozen interpreter ignores PYTHONUTF8, so on Windows it falls
# back to the legacy cp1252 ("charmap") codec and crashes when writing non-Latin
# output (e.g. Hebrew). We cannot flip UTF-8 Mode after startup, so force UTF-8
# for stdio and make text-mode open() default to UTF-8 for every file gst touches.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

_orig_open = builtins.open


def _utf8_open(file, mode="r", buffering=-1, encoding=None, *args, **kwargs):
    if encoding is None and "b" not in mode:
        encoding = "utf-8"
    return _orig_open(file, mode, buffering, encoding, *args, **kwargs)


builtins.open = _utf8_open
io.open = _utf8_open

from gemini_srt_translator.cli import main

if __name__ == "__main__":
    main()
