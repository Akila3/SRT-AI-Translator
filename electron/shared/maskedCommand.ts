/**
 * The command line a run actually used, in a form that is safe to show.
 *
 * MAN-7: the app has never shown the user what it ran. Every question of the shape "was
 * `--paid-quota` sent?", "which key was used?", "did my thinking budget apply?" is answerable
 * from the argv and by nothing else, which is why three checklist rows have been unperformable
 * since stage 2 — they ask the tester to confirm a flag the app never displays.
 *
 * The whole risk of answering that is printing an API key into a log the user will paste into
 * a bug report, so the masking contract is deliberately narrow:
 *
 *  - **Positional and structural, never heuristic.** The value masked is the one *after* `-k`
 *    or `-k2`. Nothing here tries to recognise a string that "looks like" a key: a key of an
 *    unexpected shape would then be printed in full, and Google has changed key formats before.
 *  - **Plus every configured key the caller supplies.** Translation emits at most two keys and
 *    transcription emits one, so a reserve pasted into `-d` would otherwise print in full
 *    (SOL-20). Extra secrets are swept by exact match; they do not replace positional masking.
 *  - **Built from the argv, never stored.** Nothing retains a redacted-plus-raw pair.
 *  - **One renderer.** This is the only function permitted to turn an argv array into text for
 *    display, a file or a console. No other code path may hand an argv array to `onOutput`.
 *
 * The sweep below is the one addition to that contract, and it is exact-match rather than
 * heuristic: once the key values are known *positionally*, any further occurrence of one of them
 * elsewhere in the same command line is the same secret and is redacted too. It costs nothing and
 * it closes the case where a user pastes their key into the description field and the app then
 * prints it back at them.
 */

/** Flags whose following argument is a credential. */
export const KEY_FLAGS = ['-k', '-k2'] as const

/** What a masked value is shown as. Distinctive enough to be obviously deliberate. */
export const MASK = '***'

/**
 * Shortest value the exact-match sweep will act on.
 *
 * The positional mask applies to a key of ANY length; this floor governs only whether that same
 * value is also hunted for elsewhere in the line. A Gemini key is 39 characters, so nothing real
 * is below this — while blanket-replacing a two-character value would corrupt unrelated arguments
 * (`-m`, a language code, part of a path) and protect nothing, turning a diagnostic into a puzzle.
 */
const MIN_SWEEP_LENGTH = 8

/** Quote only what needs it, so the line stays readable and remains copy-pasteable. */
function quote(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

/**
 * Render an argv array as a single displayable line, with every credential masked.
 *
 * `bin` is rendered as given: the caller decides whether to show the resolved absolute path or
 * the bare name, and both are true statements about different things (what will run, versus what
 * was asked for). Neither is ever a secret.
 */
export function maskCommandLine(
  bin: string,
  args: readonly string[],
  extraSecrets: readonly string[] = []
): string {
  const secrets: string[] = []
  const shown: (string | null)[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const flag = KEY_FLAGS.find((f) => arg === f)
    if (flag) {
      shown.push(arg)
      // A flag with nothing after it is malformed argv, not a secret — but it must not
      // consume a value that is not there, or the next flag would be masked instead.
      if (i + 1 < args.length) {
        secrets.push(args[i + 1])
        shown.push(null)
        i++
      }
      continue
    }
    // `-k=value` is not a form this app emits, but it is a form the engine's parser accepts,
    // so a future builder that used it must not silently start printing keys.
    const joined = KEY_FLAGS.find((f) => arg.startsWith(`${f}=`))
    if (joined) {
      secrets.push(arg.slice(joined.length + 1))
      shown.push(`${joined}=${MASK}`)
      continue
    }
    shown.push(arg)
  }

  for (const raw of extraSecrets) {
    const s = (raw ?? '').trim()
    if (s) secrets.push(s)
  }

  // Longest first, and deduplicated. The sweep rewrites the text it is searching, so a SHORTER
  // secret that happens to be a prefix of a longer one would consume its opening characters and
  // leave the rest of the longer key standing in clear — `***IJK` instead of `***`. Replacing the
  // longest candidate first makes that impossible: whatever is left afterwards cannot contain a
  // longer secret, because a longer one would already have matched (validator finding SOL-09).
  const sweepable = [...new Set(secrets.filter((s) => s.length >= MIN_SWEEP_LENGTH))].sort(
    (a, b) => b.length - a.length
  )
  const rendered = shown.map((arg) => {
    if (arg === null) return MASK
    let text = arg
    for (const secret of sweepable) text = text.split(secret).join(MASK)
    return quote(text)
  })

  return [quote(bin), ...rendered].join(' ')
}
