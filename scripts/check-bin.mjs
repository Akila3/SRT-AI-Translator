/**
 * Packaging preflight: refuse to build a release without the binaries it must ship.
 *
 * `resources/bin/` is git-ignored, so a clean clone has none of them. Nothing downstream
 * notices: electron-builder happily produces a portable zip whose `extraResources` filter
 * matched zero files, and the packaged app then falls back to a bare `gst` on PATH, which
 * a portable user does not have. The failure surfaces to the end user as a translation
 * that dies on spawn — a long way from the build that caused it.
 *
 * The names checked here are the EXACT ones the packaged runtime resolves, not the
 * `extraResources` globs. Those globs are deliberately looser (`gst*`), so a stray
 * `gst.txt` or a leftover `ffmpeg.old` satisfies the filter and ships, while
 * `resolveGstBin()` (`pythonBridge.ts`) still looks for `gst.exe` and `resolveTool()`
 * (`ffmpeg.ts`) for `ffmpeg.exe` / `ffprobe.exe`. Checking the glob would reproduce the
 * exact bug this script exists to prevent.
 *
 * Only release packaging is gated. `npm run dev` deliberately falls back to a `gst` on
 * PATH (the pip install), which is a supported development setup, so this must not run
 * there.
 *
 * Usage: `node scripts/check-bin.mjs [--target=win32|darwin|linux]`
 * (defaults to the host platform, which is correct for `--dir` builds).
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const BIN_DIR = path.resolve('resources/bin')
const STAMP = path.resolve('build/python/gst.buildstamp.json')

/**
 * Which platform the RELEASE is for — not which platform is building it.
 *
 * `resolveGstBin()` and `resolveTool()` pick their filenames from the platform the
 * packaged app runs on, so the preflight has to do the same. Reading `process.platform`
 * here would make a Linux or macOS CI host cross-building `--win` check for extensionless
 * `gst` / `ffmpeg` / `ffprobe`, pass, and ship a Windows package with no `.exe` in it —
 * the same class of false pass as matching the packaging globs, one level further out.
 *
 * Unknown values are rejected rather than defaulted, because a silently wrong target is
 * exactly the failure this script exists to make loud.
 */
const VALID_TARGETS = ['win32', 'darwin', 'linux']

function parseTarget(argv) {
  const arg = argv.find((a) => a === '--target' || a.startsWith('--target='))
  if (!arg) return process.platform
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[argv.indexOf(arg) + 1]
  if (!VALID_TARGETS.includes(value)) {
    console.error(
      `\nRelease build blocked: unknown --target "${value ?? ''}".\n` +
        `  expected one of: ${VALID_TARGETS.join(', ')}\n`
    )
    process.exit(1)
  }
  return value
}

const TARGET = parseTarget(process.argv.slice(2))

// Mirrors `const EXE` in ffmpeg.ts and the win32 branch of resolveGstBin().
const EXE = TARGET === 'win32' ? '.exe' : ''

const REQUIRED = [
  { name: `gst${EXE}`, why: 'the translation engine', fix: 'npm run build:python' },
  { name: `ffmpeg${EXE}`, why: 'audio/video decoding and track extraction', fix: `copy ffmpeg${EXE} into resources/bin` },
  { name: `ffprobe${EXE}`, why: 'subtitle-track probing', fix: `copy ffprobe${EXE} into resources/bin` }
]

const problems = []

for (const req of REQUIRED) {
  const full = path.join(BIN_DIR, req.name)
  let stat
  try {
    stat = fs.statSync(full)
  } catch {
    problems.push({ ...req, detail: 'missing' })
    continue
  }
  // A directory or a zero-byte placeholder satisfies "exists" but not "is runnable",
  // and both have shown up in practice from interrupted copies and antivirus quarantine.
  if (!stat.isFile()) problems.push({ ...req, detail: 'not a regular file' })
  else if (stat.size === 0) problems.push({ ...req, detail: 'empty (0 bytes)' })
}

if (problems.length) {
  console.error(
    `\nRelease build blocked: ${BIN_DIR} does not contain the binaries a ${TARGET} package resolves.\n`
  )
  for (const p of problems) {
    console.error(`  - ${p.name}  ${p.detail}  (${p.why})\n      fix: ${p.fix}`)
  }
  console.error(
    '\nThese are not tracked in git, so a fresh clone never has them. The packaging filter\n' +
      'in package.json matches "gst*" / "ffmpeg*" / "ffprobe*", which is looser than what the\n' +
      'app actually looks for — so a build can succeed and still fail at runtime on every spawn.\n'
  )
  process.exit(1)
}

/**
 * Verify the engine binary was frozen from the CURRENT build inputs.
 *
 * `gst.exe` is git-ignored, so changing what goes into it is invisible to everything
 * downstream: the checks above pass on a binary built months earlier and the release ships
 * without the change. That is not hypothetical — the line-buffering fix is an edit to
 * `gst_entry.py` whose entire effect lives inside the frozen executable.
 *
 * Every input that can alter the artifact is covered, not just the shim: `build_python.py`
 * carries the pinned engine version and the PyInstaller collection recipe, and the lock file
 * carries the dependency set, so bumping the pin without touching the shim would otherwise
 * look identical to a current build. The cost is that any edit to those files — including a
 * comment — forces a re-freeze, which is the right side to err on for a release gate.
 *
 * Only presence and freshness are checked here. Rebuilding automatically would force Python
 * and the build venv onto every packaging host and would invite a silent cross-build, which
 * PyInstaller cannot do.
 */
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * The inputs a stamp has to account for — exactly these, no more and no fewer.
 *
 * Declared HERE and never read from the stamp, because iterating whatever the stamp happens
 * to list lets it grade its own homework: a stamp written before an input existed records
 * fewer files, every one of them matches, and the gate passes while checking less than the
 * message below claims. That is the "looks current, is not" failure the stamp exists to
 * catch, moved up one level onto the checker.
 *
 * The set is compared in BOTH directions, and the second one is not tidiness. Requiring every
 * name catches a stamp that is behind this list. Refusing an unrecognised name catches this
 * list being behind `BUILD_INPUTS` in `scripts/build_python.py` — without it, a newly added
 * build input would be stamped but never hashed here, and a later edit to that input alone
 * would pass: the three names below are untouched by such an edit, so nothing would notice
 * that the engine predates it. Adding a build input is therefore deliberately a two-file
 * change, and packaging stays blocked until both are made.
 */
const REQUIRED_INPUTS = [
  'scripts/gst_entry.py',
  'scripts/build_python.py',
  'scripts/build-python-requirements.lock'
]

const gstName = `gst${EXE}`
const stampProblem = (() => {
  if (!fs.existsSync(STAMP)) {
    return `no build stamp at ${STAMP} — ${gstName} predates this check, or the work directory was cleaned`
  }
  let stamp
  try {
    stamp = JSON.parse(fs.readFileSync(STAMP, 'utf-8'))
  } catch (err) {
    return `build stamp is unreadable (${err.message})`
  }
  if (stamp.binary !== gstName) {
    return `build stamp is for "${stamp.binary}", but a ${TARGET} package needs "${gstName}" (PyInstaller cannot cross-compile)`
  }
  if (!stamp.inputs || typeof stamp.inputs !== 'object') {
    return 'build stamp records no input fingerprints — it predates this check'
  }
  // Names only: an unrecognised entry is reported, never resolved or read, so the stamp
  // cannot steer this script at a path of its choosing.
  const unrecognised = Object.keys(stamp.inputs).filter((name) => !REQUIRED_INPUTS.includes(name))
  if (unrecognised.length) {
    return (
      `the build recipe now fingerprints ${unrecognised.join(', ')}, which this check does not ` +
      `verify — add it to REQUIRED_INPUTS in scripts/check-bin.mjs, or a later edit to it alone ` +
      `would ship an engine frozen before that edit`
    )
  }
  for (const name of REQUIRED_INPUTS) {
    const recorded = stamp.inputs[name]
    if (typeof recorded !== 'string') {
      return `the build stamp does not account for ${name}, so it was written by an older build recipe`
    }
    const file = path.resolve(name)
    if (!fs.existsSync(file)) return `${name} is recorded in the build stamp but no longer exists`
    if (recorded !== sha256(file)) {
      return `${name} has changed since the engine was frozen, so the binary was not built from it`
    }
  }
  if (stamp.binarySha256 !== sha256(path.join(BIN_DIR, gstName))) {
    return `${gstName} has been replaced since it was built, so what it contains is unknown`
  }
  return null
})()

if (stampProblem) {
  console.error(`\nRelease build blocked: ${stampProblem}.\n`)
  console.error(
    `  fix: npm run build:python\n\n` +
      `${gstName} is git-ignored and is built from scripts/gst_entry.py, scripts/build_python.py\n` +
      `and the pinned requirements lock, so a stale binary is indistinguishable from a current\n` +
      `one by size or name alone. Shipping one silently reverts every fix it predates — the\n` +
      `stdout line buffering, the UTF-8 stdio that keeps non-Latin output from crashing, and\n` +
      `any engine version bump.\n`
  )
  process.exit(1)
}

for (const req of REQUIRED) {
  const size = fs.statSync(path.join(BIN_DIR, req.name)).size
  console.log(`  ok  ${req.name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
}
console.log(`  ok  ${gstName} was frozen from the current shim, build recipe and requirements lock`)
console.log(`Release preflight passed: all binaries required by a ${TARGET} package are present.\n`)
