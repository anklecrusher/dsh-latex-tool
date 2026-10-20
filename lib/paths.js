/**
 * Path handling for LaTeX tooling on Windows.
 *
 * Two host facts drive everything here, both measured on this machine
 * (2026-10-20):
 *
 * 1. **`os.tmpdir()` returns the 8.3 short name.** It reports
 *    `C:\Users\ANKLEC~1\AppData\Local\Temp`, and `latexmk` rejects that
 *    outright:
 *
 *      Latexmk: Filename 'C:/Users/ANKLEC~1/AppData/Local/Temp/probe/main.tex'
 *                contains character not allowed for TeX file.
 *      Latexmk: Stopping because of bad filename(s).
 *      exit 255
 *
 *    The same project at the resolved long name compiles with exit 0. This is
 *    the official plugin's F1: it calls `tempfile.mkdtemp()`, inherits the
 *    short name, and its smoke test therefore fails permanently on any machine
 *    whose TEMP is a short path — the plugin then reports "LaTeX is not
 *    installed" forever.
 *
 * 2. **`fs.realpathSync()` does not fix it; `fs.realpathSync.native()` does.**
 *    Measured: the JS implementation returns the short name unchanged, the
 *    native one returns `C:\Users\ankle crusher\AppData\Local\Temp`. So every
 *    path that reaches a TeX process goes through the native call.
 *
 * A non-ASCII (Chinese) project directory is *not* a problem by itself —
 * measured: `latexmk -xelatex` under `E:\研究生\论文\大论文\` exits 0. What
 * breaks non-ASCII paths is decoding the output, not passing the path.
 *
 * @module @local/dsh-latex-tool/lib/paths
 */

import { readdirSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/**
 * Characters latexmk refuses in a TeX filename.
 *
 * Transcribed from latexmk's own `$illegal_in_texname`:
 *
 *     $illegal_in_texname = "\x00\t\f\n\r\$%\\~\x7F"
 *
 * Two details matter here:
 *
 *   - the backslash itself is in the list (Perl's `\\` is one literal `\`), but
 *     it only applies to the *TeX* form of a path, which always uses forward
 *     slashes. Testing a raw Windows path would flag every separator, so
 *     {@link illegalTexNameChars} normalises first;
 *   - `%` is in the list too, which surprises people: a directory named
 *     `50%_draft` cannot reach TeX at all.
 */
const ILLEGAL_IN_TEXNAME = /[\x00\t\f\n\r$%\\~\x7F]/

/**
 * Resolve a path to its long (non-8.3) form.
 *
 * Falls back to `path.resolve` when the target does not exist yet, because
 * `realpath` on a missing path throws and every caller here is resolving a
 * path it is about to create.
 *
 * @param value - path to resolve.
 * @returns the resolved path, or the input unchanged when it cannot be resolved.
 */
export function longPath(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  const absolute = isAbsolute(value) ? value : resolve(value)
  try {
    return realpathSync.native(absolute)
  } catch {
    try {
      // The leaf may be missing while its parent exists; resolving the parent
      // is still what keeps an 8.3 ancestor out of the final path.
      return join(realpathSync.native(dirname(absolute)), relative(dirname(absolute), absolute))
    } catch {
      return normalize(absolute)
    }
  }
}

/**
 * Report which characters in a path latexmk rejects.
 *
 * The path is normalised to TeX form (forward slashes) before the test: on
 * Windows the separator is `\`, which is itself on latexmk's illegal list, so an
 * unnormalised check would reject every Windows path.
 *
 * @param value - the path to test.
 * @returns the offending characters, or an empty array when the path is usable.
 */
export function illegalTexNameChars(value) {
  if (typeof value !== 'string') return []
  const texForm = value.split(sep).join('/')
  const match = texForm.match(ILLEGAL_IN_TEXNAME)
  if (match === null) return []
  return [...new Set(match)]
}

/**
 * Choose a working directory that is safe to hand to latexmk.
 *
 * The system temp directory is the normal answer, but only in its long form.
 * When even the resolved form is unusable (the short name is the only name —
 * rare, but it is exactly the case the official plugin dies on), a directory
 * inside the project is used instead so a compile is still possible.
 *
 * @param projectDir - the project directory, used as the fallback.
 * @returns the usable directory plus a diagnostic of what was rejected.
 */
export function safeTempRoot(projectDir) {
  const raw = tmpdir()
  const resolved = longPath(raw)
  const candidates = [{ raw, resolved }]
  if (typeof projectDir === 'string' && projectDir.length > 0) {
    const fallback = longPath(join(projectDir, '.latex-build'))
    candidates.push({ raw: fallback, resolved: fallback })
  }

  const usable = candidates.find((candidate) => illegalTexNameChars(candidate.resolved).length === 0)
  if (usable !== undefined) {
    return {
      dir: usable.resolved,
      raw,
      resolved,
      shortNameFixed: raw !== resolved,
      rejected: candidates
        .filter((candidate) => candidate !== usable)
        .map((candidate) => ({ path: candidate.resolved, illegalChars: illegalTexNameChars(candidate.resolved) })),
    }
  }

  // Nothing was usable; report the long form of temp so the caller can surface
  // the real reason instead of a mysterious exit 255.
  return {
    dir: resolved,
    raw,
    resolved,
    shortNameFixed: raw !== resolved,
    rejected: candidates.map((candidate) => ({
      path: candidate.resolved,
      illegalChars: illegalTexNameChars(candidate.resolved),
    })),
  }
}

/**
 * Render a path for a TeX command line.
 *
 * TeX accepts forward slashes on every platform, and they avoid the backslash
 * escaping question entirely.
 *
 * @param value - an absolute path.
 * @returns the path with forward slashes.
 */
export function toTexPath(value) {
  return String(value).split(sep).join('/')
}

/**
 * Report whether a path exists and is a directory.
 * @param value - the path to test.
 * @returns true when it is an existing directory.
 */
export function isDirectory(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

/**
 * Report whether a path exists and is a regular file.
 * @param value - the path to test.
 * @returns true when it is an existing file.
 */
export function isFile(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    return statSync(value).isFile()
  } catch {
    return false
  }
}

/**
 * List the file names in a directory, tolerating a missing directory.
 * @param value - the directory path.
 * @returns entry names, or an empty array.
 */
export function listDirNames(value) {
  if (!isDirectory(value)) return []
  try {
    return readdirSync(value)
  } catch {
    return []
  }
}
