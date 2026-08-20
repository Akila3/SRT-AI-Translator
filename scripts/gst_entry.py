"""PyInstaller entry shim.

Importing the package's CLI `main` (rather than running cli.py as a script)
preserves the package context so the module's relative imports resolve.
"""
import builtins
import io
import signal
import sys

# The PyInstaller-frozen interpreter ignores PYTHONUTF8, so on Windows it falls
# back to the legacy cp1252 ("charmap") codec and crashes when writing non-Latin
# output (e.g. Hebrew). We cannot flip UTF-8 Mode after startup, so force UTF-8
# for stdio and make text-mode open() default to UTF-8 for every file gst touches.
#
# line_buffering is set for the same reason: the frozen interpreter also ignores
# PYTHONUNBUFFERED, so writing to a pipe block-buffers. Audio extraction announces each
# step and then works for minutes, so the UI received nothing until an unrelated flush
# released it all at once — measured at 19s of output arriving in a single burst.
try:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:
    pass

# `exit` and `quit` are injected into builtins by the `site` module, which a frozen build
# does not run, so neither name exists here. The engine aborts through a bare `exit(1)` at
# 45 sites; unresolved, each one raises NameError instead — and because NameError is an
# Exception, the engine's own `except Exception` retry handlers catch the abort and retry
# the very operation that asked to stop. A refusal that should end the run in one pass
# became several minutes of retries reported under a misleading error.
#
# sys.exit raises SystemExit, which derives from BaseException. The engine has no bare
# `except:`, no `except BaseException` and no `except SystemExit` anywhere, so nothing can
# intercept it; cli.main's `except KeyboardInterrupt` and `except Exception` both let it
# past. The exit code the engine chose is therefore the code the process returns.
_interrupted = False


def _exit(code=0):
    # The engine's two interrupt handlers disagree: the translation one ends with exit(130),
    # the transcription one with exit(0) (main.py 801-814 and 1601-1622). Both save partial
    # output first, so a 0 here means "interrupted, and what was written is incomplete" —
    # indistinguishable, to the app, from a finished run. Rather than have the app second-guess
    # exit codes, an interrupted run reports itself honestly: a success code becomes 130.
    if _interrupted and not code:
        code = 130
    sys.exit(code)


builtins.exit = _exit
builtins.quit = _exit

_orig_signal = signal.signal


def _signal(signalnum, handler):
    """Record that a SIGINT was actually delivered, then run the engine's own handler.

    The flag cannot be set by installing a handler at startup: the engine replaces the SIGINT
    handler when a run begins. Wrapping registration is what survives that. Only SIGINT is
    wrapped, and only when the engine installs a callable (SIG_IGN / SIG_DFL are ints).

    This does not touch the app's Stop button, which never sends SIGINT — it uses
    `taskkill /f /t` on Windows and SIGTERM elsewhere.
    """
    if signalnum == signal.SIGINT and callable(handler):
        engine_handler = handler

        def wrapper(signum, frame):
            global _interrupted
            _interrupted = True
            return engine_handler(signum, frame)

        handler = wrapper
    return _orig_signal(signalnum, handler)


signal.signal = _signal

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
