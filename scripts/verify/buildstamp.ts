/**
 * Does the release preflight actually BLOCK?
 *
 * `scripts/check-bin.mjs` is the last thing standing between a stale `gst.exe` and a release.
 * Until now nobody had ever seen it refuse: every run of it has passed, which proves the happy
 * path and nothing else. A gate that has only ever said yes is indistinguishable from a gate
 * that always says yes — and this one guards the failure it was written for, a binary that
 * silently predates the fixes it is supposed to contain.
 *
 * FIDELITY. The real script is executed as a child process, unmodified, exactly as
 * `npm run check:bin` invokes it. Nothing is imported and nothing is stubbed, because the parts
 * worth testing are its exit code and the sentence it prints to a human at 2 a.m.
 *
 * HOW. Every scenario builds a disposable tree — three fake binaries, three fake build inputs
 * and a stamp — and runs the script with that tree as its working directory. `check-bin.mjs`
 * resolves `resources/bin`, `build/python` and every recorded input relative to the working
 * directory, so a sandbox is a complete substitute for the repository. `--target=win32` is
 * passed throughout so the expected filenames are `.exe` on every host and the assertions do
 * not drift between a developer's machine and CI.
 *
 * COST. No key, no network, no engine: a few kilobytes of temporary files and one node process
 * per scenario. Seconds.
 *
 * Run with `node scripts/verify/run-buildstamp.mjs`. Exits non-zero on failure.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

const ROOT = process.cwd()
const CHECK_BIN = path.join(ROOT, 'scripts', 'check-bin.mjs')
const VERIFY = path.join(ROOT, 'scripts', 'electron-builder-verify.cjs')

/** Mirrors `REQUIRED_INPUTS` in check-bin.mjs and `BUILD_INPUTS` in build_python.py. */
const INPUTS = [
  'scripts/gst_entry.py',
  'scripts/build_python.py',
  'scripts/build-python-requirements.lock'
]

let failures = 0
let passes = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===\n`)
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

interface Stamp {
  binary: string
  binarySha256: string
  inputs: Record<string, string>
  engineVersion: string
  builtAt: string
}

/**
 * A tree in the state a successful `npm run build:python` leaves behind.
 *
 * The binaries are small files rather than real executables: the preflight checks that they
 * exist, are regular files and are not empty, and hashes only the engine. Nothing here is ever
 * executed.
 */
function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-buildstamp-'))
  fs.mkdirSync(path.join(dir, 'resources', 'bin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'build', 'python'), { recursive: true })

  for (const name of ['gst.exe', 'ffmpeg.exe', 'ffprobe.exe']) {
    fs.writeFileSync(path.join(dir, 'resources', 'bin', name), `binary:${name}\n`)
  }
  for (const rel of INPUTS) {
    fs.writeFileSync(path.join(dir, rel), `original contents of ${rel}\n`)
  }
  writeStamp(dir, freshStamp(dir))
  return dir
}

/** What `write_stamp()` in build_python.py records immediately after a freeze. */
function freshStamp(dir: string): Stamp {
  return {
    binary: 'gst.exe',
    binarySha256: sha256(path.join(dir, 'resources', 'bin', 'gst.exe')),
    inputs: Object.fromEntries(INPUTS.map((rel) => [rel, sha256(path.join(dir, rel))])),
    engineVersion: '3.7.0',
    builtAt: new Date().toISOString()
  }
}

function writeStamp(dir: string, stamp: Stamp | string): void {
  const file = path.join(dir, 'build', 'python', 'gst.buildstamp.json')
  fs.writeFileSync(file, typeof stamp === 'string' ? stamp : JSON.stringify(stamp, null, 2))
}

function readStamp(dir: string): Stamp {
  return JSON.parse(
    fs.readFileSync(path.join(dir, 'build', 'python', 'gst.buildstamp.json'), 'utf-8')
  )
}

interface Outcome {
  blocked: boolean
  output: string
}

function preflight(dir: string, extraArgs: string[] = []): Outcome {
  const res = spawnSync(process.execPath, [CHECK_BIN, '--target=win32', ...extraArgs], {
    cwd: dir,
    encoding: 'utf8'
  })
  return { blocked: res.status !== 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/**
 * Run one scenario against a fresh tree, then throw the tree away.
 *
 * Each scenario gets its own sandbox so a mutation cannot leak into the next assertion — the
 * failure mode of a shared fixture is a test that passes for the wrong reason.
 */
function scenario(mutate: (dir: string) => void, extraArgs: string[] = []): Outcome {
  const dir = sandbox()
  try {
    mutate(dir)
    return preflight(dir, extraArgs)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function stagePackedCopy(dir: string): string {
  const packed = path.join(dir, 'packed', 'resources', 'bin')
  fs.mkdirSync(packed, { recursive: true })
  for (const name of ['gst.exe', 'ffmpeg.exe', 'ffprobe.exe']) {
    fs.copyFileSync(path.join(dir, 'resources', 'bin', name), path.join(packed, name))
  }
  return packed
}

function sevenZa(): string {
  const plat = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
  const exe = process.platform === 'win32' ? '7za.exe' : '7za'
  return path.join(ROOT, 'node_modules', '7zip-bin', plat, process.arch, exe)
}

function makeZip(dir: string, zipName: string, members: string[]): void {
  const zip = path.join(dir, zipName)
  const res = spawnSync(sevenZa(), ['a', '-tzip', zip, ...members], { cwd: dir, encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`7za could not write ${zipName}: ${res.stderr || res.stdout}`)
  }
}

function archiveCheck(zipPath: string, stampPath: string): Outcome {
  const src =
    `require(${JSON.stringify(VERIFY)}).verifyPackedArchive(${JSON.stringify(zipPath)}, ${JSON.stringify(stampPath)})`
  const res = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8' })
  return { blocked: res.status !== 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

function main(): void {
  console.log('\n=== The release preflight, in both directions ===')

  // ── A consistent tree, so every refusal below means something ──────────────
  section('A — a build whose binary matches its inputs')

  const clean = scenario(() => {})
  check('a consistent tree passes', !clean.blocked, clean.output.trim().split('\n').pop())
  check('and says the engine was frozen from the current inputs', /was frozen from the current/.test(clean.output))

  // ── The stamp itself ───────────────────────────────────────────────────────
  section('B — the stamp is missing or unusable')

  const noStamp = scenario((dir) => {
    fs.rmSync(path.join(dir, 'build', 'python', 'gst.buildstamp.json'))
  })
  check('a binary with no stamp is refused', noStamp.blocked)
  check('and the reason is that it predates the check', /predates this check|was cleaned/.test(noStamp.output))

  const corrupt = scenario((dir) => writeStamp(dir, '{ not json'))
  check('an unreadable stamp is refused', corrupt.blocked)
  check('and says so, rather than crashing', /unreadable/.test(corrupt.output))

  const wrongPlatform = scenario((dir) => {
    const s = readStamp(dir)
    s.binary = 'gst'
    writeStamp(dir, s)
  })
  check('a stamp from another platform is refused', wrongPlatform.blocked)
  check('and names cross-compilation as the reason', /cross-compile/.test(wrongPlatform.output))

  // ── The inputs — the case the stamp exists for ─────────────────────────────
  section('C — an input moved after the freeze')

  for (const rel of INPUTS) {
    const edited = scenario((dir) => {
      fs.writeFileSync(path.join(dir, rel), 'edited after the engine was frozen\n')
    })
    check(`editing ${rel} refuses the build`, edited.blocked)
    check(`  …and names ${rel}`, edited.output.includes(rel))
  }

  const deleted = scenario((dir) => fs.rmSync(path.join(dir, 'scripts', 'gst_entry.py')))
  check('an input recorded in the stamp but since deleted is refused', deleted.blocked)
  check('and says it no longer exists', /no longer exists/.test(deleted.output))

  // ── A stamp that under-reports: the gate must not grade its own homework ───
  section('D — a stamp written by an older recipe')

  const omitted = scenario((dir) => {
    const s = readStamp(dir)
    delete s.inputs['scripts/build-python-requirements.lock']
    writeStamp(dir, s)
  })
  check('a stamp that omits an input is refused', omitted.blocked)
  check('and names the input it fails to account for', /does not account for/.test(omitted.output))
  check(
    '  …specifically the lock file',
    omitted.output.includes('scripts/build-python-requirements.lock')
  )

  const noInputs = scenario((dir) => {
    const s = readStamp(dir)
    s.inputs = {}
    writeStamp(dir, s)
  })
  check('a stamp with an empty input map is refused too', noInputs.blocked)

  // ── The mirror case: the CHECKER is the one that is behind ────────────────
  // A stamp may not carry an input this script does not verify. Without this, adding a build
  // input to build_python.py alone would be stamped but never hashed here — and while adding
  // it forces one re-freeze (that file is itself fingerprinted), every LATER edit to the new
  // input on its own leaves all three declared names matching, so the gate would pass on an
  // engine frozen before the edit. That is the same false pass, arrived at from the other side.
  section('D2 — a build input this check does not know about')

  const HOOK = 'scripts/freeze_hook.py'

  const stampExtra = (dir: string, contents: string): void => {
    const hook = path.join(dir, HOOK)
    fs.writeFileSync(hook, contents)
    const s = readStamp(dir)
    s.inputs[HOOK] = sha256(hook)
    writeStamp(dir, s)
  }

  const unknownInput = scenario((dir) => stampExtra(dir, 'a new build input\n'))
  check('a stamp fingerprinting an undeclared input is refused', unknownInput.blocked)
  check('and names the input', unknownInput.output.includes(HOOK))
  check('and says which list has to learn about it', /REQUIRED_INPUTS/.test(unknownInput.output))

  const unknownThenEdited = scenario((dir) => {
    stampExtra(dir, 'original hook\n')
    fs.writeFileSync(path.join(dir, HOOK), 'hook edited after the freeze\n')
  })
  check(
    'editing that undeclared input after the freeze cannot slip through',
    unknownThenEdited.blocked
  )
  check(
    '  …even though all three declared inputs still match',
    unknownThenEdited.output.includes(HOOK)
  )

  // Adding it to BOTH manifests is the supported path; this asserts the gate stays closed
  // until it is done, rather than that it opens — check-bin.mjs's list is a constant here.
  const declaredElsewhere = scenario((dir) => {
    const s = readStamp(dir)
    delete s.inputs['scripts/gst_entry.py']
    s.inputs[HOOK] = 'whatever'
    writeStamp(dir, s)
  })
  check('a stamp that swaps a declared input for an undeclared one is refused', declaredElsewhere.blocked)

  // ── The binary ─────────────────────────────────────────────────────────────
  section('E — the binary itself changed')

  const replaced = scenario((dir) => {
    fs.writeFileSync(path.join(dir, 'resources', 'bin', 'gst.exe'), 'a different binary\n')
  })
  check('replacing the engine after the freeze is refused', replaced.blocked)
  check('and says its contents are unknown', /has been replaced|unknown/.test(replaced.output))

  // ── Regression: the checks that existed before the stamp still run first ───
  section('F — the original presence checks are untouched')

  const missing = scenario((dir) => fs.rmSync(path.join(dir, 'resources', 'bin', 'ffmpeg.exe')))
  check('a missing ffmpeg is still refused', missing.blocked)
  check('with the original message, not the stamp one', /does not contain the binaries/.test(missing.output))

  const empty = scenario((dir) => {
    fs.writeFileSync(path.join(dir, 'resources', 'bin', 'ffprobe.exe'), '')
  })
  check('a zero-byte binary is still refused', empty.blocked)
  check('and is described as empty', /empty \(0 bytes\)/.test(empty.output))

  // ── Every refusal has to tell the reader what to do ────────────────────────
  section('G — a refusal is actionable')

  const stale = scenario((dir) => {
    fs.writeFileSync(path.join(dir, 'scripts', 'gst_entry.py'), 'edited\n')
  })
  check('a stale-engine refusal names the command that fixes it', /npm run build:python/.test(stale.output))
  check('and explains what shipping it would revert', /line buffering|silently reverts/.test(stale.output))

  // ── The packed copy electron-builder actually ships (SOL-42 afterPack) ──────
  section('H — afterPack hashes the copied artifact, not the source tree')

  const packedOk = scenario((dir) => {
    stagePackedCopy(dir)
  }, ['--bin-dir=packed/resources/bin'])
  check('a packed copy that still matches the stamp passes', !packedOk.blocked, packedOk.output.trim().split('\n').pop())

  const packedReplaced = scenario((dir) => {
    const packed = stagePackedCopy(dir)
    fs.writeFileSync(path.join(packed, 'gst.exe'), 'swapped after extraResources copy\n')
  }, ['--bin-dir=packed/resources/bin'])
  check(
    'replacing the packed engine after the copy is refused',
    packedReplaced.blocked,
    packedReplaced.output.trim().split('\n').pop()
  )
  check('and says the packed contents are unknown', /has been replaced|unknown/.test(packedReplaced.output))

  // ── The archive electron-builder emits after afterPack (SOL-42 remainder) ──
  section('I — the ZIP that ships is hashed, not only the unpacked copy')

  const zipDir = sandbox()
  try {
    const members = [
      path.join('resources', 'bin', 'gst.exe'),
      path.join('resources', 'bin', 'ffmpeg.exe'),
      path.join('resources', 'bin', 'ffprobe.exe')
    ]
    const stampFile = path.join(zipDir, 'build', 'python', 'gst.buildstamp.json')
    const gstBytes = fs.readFileSync(path.join(zipDir, 'resources', 'bin', 'gst.exe'))
    makeZip(zipDir, 'ship.zip', members)
    const zipOk = archiveCheck(path.join(zipDir, 'ship.zip'), stampFile)
    check('a zip whose gst matches the stamp is accepted', !zipOk.blocked, zipOk.output.trim())

    fs.writeFileSync(path.join(zipDir, 'resources', 'bin', 'gst.exe'), 'swapped after afterPack\n')
    makeZip(zipDir, 'ship-bad.zip', members)
    const zipBad = archiveCheck(path.join(zipDir, 'ship-bad.zip'), stampFile)
    check('a zip whose gst was swapped after the unpacked check is refused', zipBad.blocked)
    check(
      'and says the shipped engine is not the one that was checked',
      /does not match the freeze stamp|shipped engine/.test(zipBad.output),
      zipBad.output.trim().split('\n').pop()
    )

    fs.mkdirSync(path.join(zipDir, 'unrelated'), { recursive: true })
    fs.writeFileSync(path.join(zipDir, 'unrelated', 'gst.exe'), gstBytes)
    makeZip(zipDir, 'ship-wrong-path.zip', [path.join('unrelated', 'gst.exe')])
    const zipWrong = archiveCheck(path.join(zipDir, 'ship-wrong-path.zip'), stampFile)
    check('a zip whose stamped gst is not at resources/bin is refused', zipWrong.blocked)
    check(
      'and names the Windows runtime path',
      /resources\/bin\/gst\.exe/.test(zipWrong.output) && !/Contents\/Resources/.test(zipWrong.output),
      zipWrong.output.trim().split('\n').pop()
    )

    const macLayout = path.join('Contents', 'Resources', 'bin', 'gst.exe')
    fs.mkdirSync(path.join(zipDir, 'Contents', 'Resources', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(zipDir, macLayout), gstBytes)
    makeZip(zipDir, 'ship-mac-path.zip', [macLayout])
    const zipMac = archiveCheck(path.join(zipDir, 'ship-mac-path.zip'), stampFile)
    check('a Windows zip whose gst is only at the macOS path is refused', zipMac.blocked)
    check(
      'and still names resources/bin, not the macOS layout',
      /resources\/bin\/gst\.exe/.test(zipMac.output),
      zipMac.output.trim().split('\n').pop()
    )
  } finally {
    fs.rmSync(zipDir, { recursive: true, force: true })
  }

  const macStampDir = sandbox()
  try {
    const linuxLayout = path.join('resources', 'bin', 'gst')
    fs.copyFileSync(path.join(macStampDir, 'resources', 'bin', 'gst.exe'), path.join(macStampDir, linuxLayout))
    const s = readStamp(macStampDir)
    s.binary = 'gst'
    s.binarySha256 = sha256(path.join(macStampDir, linuxLayout))
    writeStamp(macStampDir, s)
    makeZip(macStampDir, 'ship-linux-layout.zip', [linuxLayout])
    const zipLinuxOnMac = archiveCheck(
      path.join(macStampDir, 'ship-linux-layout.zip'),
      path.join(macStampDir, 'build', 'python', 'gst.buildstamp.json')
    )
    check('a macOS zip whose gst is only at the Linux path is refused', zipLinuxOnMac.blocked)
    check(
      'and names Contents/Resources/bin',
      /Contents\/Resources\/bin\/gst/.test(zipLinuxOnMac.output),
      zipLinuxOnMac.output.trim().split('\n').pop()
    )
  } finally {
    fs.rmSync(macStampDir, { recursive: true, force: true })
  }

  console.log(`\n${passes} passed, ${failures} failed`)
  if (failures > 0) {
    console.log('\nPROBE FAILED — the release preflight does not refuse what it claims to refuse.')
    process.exit(1)
  }
  console.log('\nALL BUILD-STAMP PROBES PASSED')
}

main()
