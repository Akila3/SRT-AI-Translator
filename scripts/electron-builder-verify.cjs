/**
 * Shared release-preflight for electron-builder hooks.
 *
 * npm script order is not a packaging invariant (SOL-42): `npx electron-builder --win`
 * never runs `check:bin`, and a binary swapped after that script but before extraResources
 * copy would still ship. These hooks are inside the packer. beforePack hashes the source
 * tree; afterPack hashes the *copied* artifact in the unpacked app; afterAllArtifactBuild
 * hashes the engine inside the ZIP/AppImage that is actually shipped, because afterPack
 * returns before that archive exists.
 */
const { spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO_ROOT = path.join(__dirname, '..')
const DEFAULT_STAMP = path.join(REPO_ROOT, 'build', 'python', 'gst.buildstamp.json')

function targetOf(context) {
  const p = context.electronPlatformName
  if (p === 'win32' || p === 'windows') return 'win32'
  if (p === 'darwin' || p === 'mac') return 'darwin'
  if (p === 'linux') return 'linux'
  throw new Error(`Release pack blocked: unknown electron platform "${p}"`)
}

function runCheckBin(args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'check-bin.mjs'), ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error('Release pack blocked: check-bin.mjs refused')
  }
}

function packedBinDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const app = `${context.packager.appInfo.productFilename}.app`
    return path.join(context.appOutDir, app, 'Contents', 'Resources', 'bin')
  }
  return path.join(context.appOutDir, 'resources', 'bin')
}

function path7za() {
  // electron-builder already ships this; resolve from the repo so the hook does not
  // depend on whatever cwd the packer happens to have.
  return require(path.join(REPO_ROOT, 'node_modules', '7zip-bin')).path7za
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function listArchiveFiles(archive) {
  const listed = spawnSync(path7za(), ['l', '-slt', archive], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  if (listed.error) throw listed.error
  if (listed.status !== 0) {
    throw new Error(
      `Release pack blocked: cannot inspect ${path.basename(archive)} ` +
        `(${(listed.stderr || listed.stdout || '').trim() || `exit ${listed.status}`})`
    )
  }
  const files = []
  let current = {}
  const flush = () => {
    if (current.Path && current.Folder !== '+') files.push(current)
    current = {}
  }
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    const eq = line.indexOf(' = ')
    if (eq > 0) current[line.slice(0, eq)] = line.slice(eq + 3)
  }
  flush()
  const archiveName = path.basename(archive)
  return files.filter((f) => path.basename(f.Path.replace(/\\/g, '/')) !== archiveName)
}

/**
 * One runtime path per artifact. ORing Windows and macOS suffixes let a Windows
 * zip ship Contents/Resources/bin/gst.exe and still pass (SOL-51 remainder).
 *
 *   gst.exe + zip      → Windows portable:  resources/bin/gst.exe
 *   gst + AppImage     → Linux:             resources/bin/gst
 *   gst + zip          → macOS:             Contents/Resources/bin/gst
 */
function requiredEngineSuffix(archive, binary) {
  const ext = path.extname(archive).toLowerCase()
  const windows = binary.toLowerCase().endsWith('.exe')
  if (ext === '.appimage') {
    if (windows) {
      throw new Error('Release pack blocked: an AppImage cannot ship a Windows gst.exe')
    }
    return `/resources/bin/${binary}`
  }
  if (ext === '.zip') {
    return windows ? `/resources/bin/${binary}` : `/Contents/Resources/bin/${binary}`
  }
  throw new Error(`Release pack blocked: cannot determine the runtime path for ${path.basename(archive)}`)
}

function matchesRuntimePath(entryPath, suffix) {
  const n = entryPath.replace(/\\/g, '/')
  const withSlash = n.startsWith('/') ? n : `/${n}`
  if (withSlash !== suffix && !withSlash.endsWith(suffix)) return false
  // `/Contents/Resources/bin/gst.exe` must not count as `/resources/bin/gst.exe`.
  if (suffix.includes('/resources/bin/') && /\/contents\/resources\/bin\//i.test(withSlash)) {
    return false
  }
  return true
}

function findEngineEntry(files, binary, archive) {
  const suffix = requiredEngineSuffix(archive, binary)
  const matches = files.filter((f) => matchesRuntimePath(f.Path, suffix))
  if (matches.length === 0) {
    throw new Error(
      `Release pack blocked: ${binary} is not at ${suffix.slice(1)} in the packed archive`
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `Release pack blocked: packed archive contains ${matches.length} copies of ${binary}`
    )
  }
  return matches[0].Path
}

/**
 * Hash the engine that is actually inside a ZIP or AppImage, and refuse if it is
 * not the freeze recorded by the stamp. Used by afterAllArtifactBuild and by the
 * build-stamp probe.
 */
function verifyPackedArchive(archive, stampPath = DEFAULT_STAMP) {
  if (!fs.existsSync(stampPath)) {
    throw new Error(`Release pack blocked: no build stamp at ${stampPath}`)
  }
  let stamp
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'))
  } catch (err) {
    throw new Error(`Release pack blocked: build stamp is unreadable (${err.message})`)
  }
  if (typeof stamp.binary !== 'string' || typeof stamp.binarySha256 !== 'string') {
    throw new Error('Release pack blocked: build stamp records no engine hash')
  }
  const files = listArchiveFiles(archive)
  const entry = findEngineEntry(files, stamp.binary, archive)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-pack-gst-'))
  try {
    const extracted = spawnSync(path7za(), ['e', '-y', `-o${tmp}`, archive, entry], {
      encoding: 'utf8'
    })
    if (extracted.error) throw extracted.error
    if (extracted.status !== 0) {
      throw new Error(
        `Release pack blocked: could not extract ${stamp.binary} from ${path.basename(archive)}`
      )
    }
    const produced = path.join(tmp, path.basename(entry.replace(/\\/g, '/')))
    if (!fs.existsSync(produced) || fs.statSync(produced).size === 0) {
      throw new Error(`Release pack blocked: extracted ${stamp.binary} is missing or empty`)
    }
    const got = sha256File(produced)
    if (got !== stamp.binarySha256) {
      throw new Error(
        `Release pack blocked: ${path.basename(archive)} contains a ${stamp.binary} that ` +
          'does not match the freeze stamp, so the shipped engine is not the one that was checked'
      )
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

exports.beforePack = async function beforePack(context) {
  runCheckBin([`--target=${targetOf(context)}`])
}

exports.afterPack = async function afterPack(context) {
  const target = targetOf(context)
  runCheckBin([`--target=${target}`, `--bin-dir=${packedBinDir(context)}`])
}

exports.afterAllArtifactBuild = async function afterAllArtifactBuild(result) {
  const archives = (result.artifactPaths || []).filter((p) => /\.(zip|appimage)$/i.test(p))
  for (const file of archives) {
    verifyPackedArchive(file)
    console.log(`  ok  packed ${path.basename(file)} contains the stamped engine`)
  }
}

exports.verifyPackedArchive = verifyPackedArchive
