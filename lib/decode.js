/**
 * Output decoding for LaTeX tooling on a zh-CN Windows machine.
 *
 * The measurement that dictates this design (2026-10-20, TeX Live 2026):
 *
 *   - latexmk's **stdout** and the `.log` file it writes are UTF-8.
 *   - latexmk's **stderr**, specifically the summary lines it echoes back from
 *     the log, is written by Perl in the *console code page* (GBK / 936 here).
 *
 * So decoding cannot be a per-process choice: the two streams of the *same*
 * process need different answers. Measured proof — a project with a missing
 * input file whose name is Chinese:
 *
 *   stdout: "不存在\ufffd\ufffd\ufffd.tex' not found."      (clean UTF-8)
 *   stderr: "Latexmk: Missing input file '\xb2\xbb\xb4\xe6...'"   (GBK bytes)
 *
 * Decoding stderr as UTF-8 yields U+FFFD and loses the filename entirely. That
 * is the same class of bug as the official plugin's F2 (`UnicodeDecodeError`
 * on `subprocess.run(text=True)`), one layer down.
 *
 * The strategy is therefore per-stream: try UTF-8 first, and only when it
 * produces replacement characters fall back to the legacy code page. The
 * reverse order would be wrong — GBK decodes almost any byte sequence without
 * complaint, so it would silently "succeed" on valid UTF-8 bytes.
 *
 * @module @local/dsh-latex-tool/lib/decode
 */

/** The legacy code page to fall back to on Windows. */
const LEGACY_ENCODING = 'gbk'

/** The replacement character both decoders emit for undecodable bytes. */
const REPLACEMENT = '\uFFFD'

/**
 * Decode one captured byte buffer.
 *
 * @param buffer - raw bytes from a child process or a file.
 * @param preferred - force one encoding ('utf-8' or 'gbk') instead of sniffing.
 * @returns the decoded text plus which encoding actually produced it.
 */
export function decodeOutput(buffer, preferred) {
  if (!Buffer.isBuffer(buffer)) return { text: String(buffer ?? ''), encoding: 'utf-8' }

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (preferred === 'utf-8') return { text: utf8, encoding: 'utf-8' }
  if (utf8.length === 0 || !utf8.includes(REPLACEMENT)) {
    return { text: utf8, encoding: 'utf-8' }
  }

  let legacy
  try {
    legacy = new TextDecoder(LEGACY_ENCODING, { fatal: false }).decode(buffer)
  } catch {
    // Unknown/unsupported encoding label (a Node build without full ICU).
    // UTF-8 with replacement characters is the only remaining interpretation,
    // and saying so is better than throwing inside a compile.
    return { text: utf8, encoding: 'utf-8' }
  }
  // If both decodes produce replacement characters, the legacy one is still
  // the better guess on a machine whose console code page is not UTF-8.
  const legacyClean = !legacy.includes(REPLACEMENT)
  if (legacyClean) return { text: legacy, encoding: preferred ?? LEGACY_ENCODING }
  return { text: utf8, encoding: 'utf-8' }
}

/**
 * Decode a buffer whose encoding is already known (a `.log` file, which the
 * engine always writes as UTF-8 when the source is UTF-8).
 *
 * @param buffer - raw file bytes.
 * @returns the decoded text.
 */
export function decodeUtf8(buffer) {
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
}

/**
 * Report whether a decoded string lost bytes.
 *
 * Callers use this to warn that a log excerpt may be incomplete, rather than
 * presenting damaged text as the real error message.
 *
 * @param text - decoded text.
 * @returns true when replacement characters are present.
 */
export function looksDamaged(text) {
  return typeof text === 'string' && text.includes(REPLACEMENT)
}

/**
 * Strip ANSI SGR sequences and OSC hyperlinks.
 *
 * TeX Live's colourised tools emit these when TERM says so. The plugin spawns
 * with a plain environment, but `latexmk` can still inherit `TERM` from the
 * desktop app, and a stray escape sequence inside a parsed filename would
 * corrupt the structured result.
 *
 * @param text - the raw decoded text.
 * @returns text without escape sequences.
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '')
}
