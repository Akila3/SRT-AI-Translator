# Third-Party Notices

SRT AI Translator itself is released under the MIT License (see [LICENSE](LICENSE)). The portable
build additionally redistributes the components below, which remain under their own licenses.

This file exists so that those licenses travel with the distribution, as each of them requires.

**Where these live in the portable build.** Everything below ships inside the ZIP alongside
`SRT AI Translator.exe`:

```
LICENSE.txt                              this application (MIT)
THIRD-PARTY-NOTICES.md                   this file
LICENSE.electron.txt                     Electron
LICENSES.chromium.html                   Chromium
licenses\README.txt                      what each licence covers, and where to get source
licenses\FFmpeg-GPL-3.0.txt              FFmpeg and FFprobe (GPL v3)
licenses\gemini-srt-translator-MIT.txt   the translation engine (MIT)
```

---

## gemini-srt-translator

The translation and transcription engine. Bundled as `resources/bin/gst.exe`, frozen from the
Python package with PyInstaller. Version 3.7.0 ships with release 1.1.0; `scripts/build_python.py`
asserts the version before freezing.

Project: <https://github.com/MaKTaiL/gemini-srt-translator>

```
MIT License

Copyright (c) 2024 Matheus Castro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The frozen executable also embeds the engine's own Python dependencies. Their licenses are those
declared by each package; `scripts/build-python-requirements.lock` pins the exact set that produced
the shipped binary.

---

## FFmpeg and FFprobe

Used for subtitle-track extraction and for converting audio into a format the engine reads. Bundled
as `resources/bin/ffmpeg.exe` and `resources/bin/ffprobe.exe`. These binaries are **not** tracked in
this repository and are supplied by whoever produces a build.

Project: <https://ffmpeg.org/>
Licensing: <https://ffmpeg.org/legal.html>

FFmpeg is licensed under the **LGPL v2.1 or later**, or under the **GPL** when built with components
that require it. **Which one applies depends on the specific binary that was bundled**, not on this
project.

The binary used to produce the 1.1.0 portable build reports:

```
ffmpeg version 8.1.2-essentials_build-www.gyan.dev
configuration: --enable-gpl --enable-version3 --enable-static ...
```

`--enable-gpl` together with `--enable-version3` makes that binary **GPL v3**. Redistributing it
carries the obligations of that license for the binary itself: the GPL v3 text must accompany it,
and the corresponding source must be made available — either shipped, or offered in writing on the
terms the GPL sets out. FFmpeg source is published at <https://ffmpeg.org/download.html>, and the
build scripts for these particular binaries at <https://github.com/GyanD/codexffmpeg>.

FFmpeg here is invoked as a **separate executable over its command line**; no FFmpeg code is linked
into this application. That is the ordinary basis for treating the two as aggregated works rather
than one combined work, but it does not remove the obligations attaching to the redistributed binary
itself.

**If you produce your own build, check your own binary** with `ffmpeg -version` and read the
`configuration:` line rather than assuming it matches this one.

**Nothing this application asks FFmpeg to do requires a GPL build.** It issues exactly three kinds
of call, and every one of them is satisfied by an LGPL configuration:

| Purpose | Codec arguments |
|---|---|
| Export a text subtitle track | `-c:s srt` |
| Export an image/PGS subtitle track | `-c:s copy` |
| Convert audio for the engine | `-c:a libmp3lame` (LAME is LGPL and needs no `--enable-gpl`) |

The GPL-only components in the shipped binary — x264, x265, Xvid, vidstab, VMAF and similar — are
encoders this application never invokes. Moving to an LGPL build would therefore change no
behaviour while removing the GPL obligations entirely. Verify before swapping that the LGPL build
you choose still ships `libmp3lame` (`ffmpeg -encoders | findstr mp3`), because FFmpeg has no
built-in MP3 encoder of its own and the audio path depends on it.

---

## Electron, Node.js and the renderer stack

The application shell is [Electron](https://www.electronjs.org/), which embeds Chromium and Node.js
and carries its own set of licenses; the packaged build includes `LICENSE.electron.txt` and
`LICENSES.chromium.html`, generated by electron-builder. The React, Zustand, Tailwind and Vite
packages used to build the interface are MIT-licensed and are compiled into the application bundle
rather than redistributed as separate files. Their full dependency set and versions are recorded in
`package-lock.json`.

---

## TMDB

Metadata search and cast lookups are served by [The Movie Database](https://www.themoviedb.org/)
API. This product uses the TMDB API but is **not endorsed or certified by TMDB**. No TMDB code is
bundled; the API is called at run time.
