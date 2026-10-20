/**
 * The latexmk driver: one structured compile.
 *
 * Every rule in here exists because the official plugin breaks on it, or
 * because a measured `latexmk` behaviour needs encoding:
 *
 *   - **Paths are resolved with `realpathSync.native` first.** The 8.3 short
 *     name in `TEMP` makes latexmk exit 255 with "contains character not
 *     allowed". See `lib/paths.js` for the measured transcript.
 *   - **The engine flag is mandatory.** With no flag, `latexmk` on a `ctexart`
 *     project builds DVI, not PDF, and exits 0 — a green build with no PDF.
 *   - **`-norc` by default.** A latexmkrc is Perl that would execute on a
 *     project the user only asked to preview. The tool says `norc: true` in its
 *     result, and warns when the project actually has one that was ignored.
 *   - **stdout and stderr are decoded separately.** latexmk writes UTF-8 to
 *     stdout and GBK to stderr (measured); one decoder for both loses the
 *     Chinese filename in the error summary. See `lib/decode.js`.
 *   - **The tree is killed on the deadline.** latexmk is a Perl wrapper; the
 *     real engine is a grandchild that keeps the pipe open after a bare kill.
 *
 * @module @local/dsh-latex-tool/lib/compile
 */

import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { decodeUtf8, looksDamaged } from './decode.js'
import { headline, parseLog } from './diagnose.js'
import { engineFlag, inferBibliographyBackend, inferEngine } from './engine.js'
import { isDirectory, isFile, listDirNames, longPath, safeTempRoot, toTexPath } from './paths.js'
import { COMPILE_TIMEOUT_MS, runProcess } from './run.js'

/** Files a build leaves behind that count as auxiliary output. */
const AUX_EXTENSIONS = ['.aux', '.log', '.out', '.toc', '.bbl', '.blg', '.bcf', '.run.xml', '.fls', '.fdb_latexmk', '.xdv', '.synctex.gz']

/**
 * Resolve the .tex file the caller named.
 *
 * Accepts a file or a directory (in which case a conventional root name is
 * looked for). `main.tex` is a candidate, not proof — the caller is expected to
 * know which file it means, and the result reports what was chosen.
 *
 * @param target - the argument as given.
 * @param cwd - the session working directory, for relative paths.
 * @returns the absolute path plus the candidates that were considered.
 */
export function resolveTexFile(target, cwd) {
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  const absolute = isAbsolute(target) ? target : resolve(base, target)
  const considered = [absolute]

  if (isFile(absolute)) return { file: longPath(absolute), considered, existed: true }
  if (isDirectory(absolute)) {
    const names = listDirNames(absolute)
    const preferred = ['main.tex', 'thesis.tex', 'paper.tex', 'document.tex', 'root.tex', 'ms.tex']
    const hit = preferred.find((name) => names.includes(name))
    if (hit !== undefined) {
      const file = join(absolute, hit)
      return { file: longPath(file), considered: [file], existed: true }
    }
    const texFiles = names.filter((name) => extname(name).toLowerCase() === '.tex')
    if (texFiles.length === 1) {
      const file = join(absolute, texFiles[0])
      return { file: longPath(file), considered: [file], existed: true }
    }
  }

  return { file: longPath(absolute), considered, existed: false }
}

/**
 * Count the 8.3 short-name problem in a working directory, for reporting.
 *
 * @param dir - a resolved directory.
 * @returns whether a `~` remains in the path.
 */
function hasShortName(dir) {
  return typeof dir === 'string' && dir.includes('~')
}

/**
 * Run one compile.
 *
 * @param options - resolved file, engine choice, paths, settings and abort signal.
 * @returns the structured compile result.
 */
export async function compileProject(options) {
  const {
    texFile,
    cwd = dirname(texFile),
    texBin = '',
    settings = {},
    explicitEngine = '',
    signal = undefined,
    logger = undefined,
    outDirMode = 'project',
  } = options

  const started = Date.now()
  const projectDir = longPath(cwd)
  const resolvedTex = longPath(texFile)
  const fileName = basename(resolvedTex)
  const notes = []
  const warnings = []

  if (!isFile(resolvedTex)) {
    // Every field the tool contract declares must be present. Returning a
    // partial object here once made the harness reject the whole result with
    // "value is not lossless JSON", because the missing fields came back as
    // `undefined` and an undefined property has no JSON representation — the
    // caller then saw a tool error instead of the actionable "file not found".
    return {
      ...emptyResult({ started, engine: '', texFile: resolvedTex }),
      norc: settings.respectLatexmkrc !== true,
      warnings: [`The file "${resolvedTex}" does not exist.`],
      error: 'tex-file-not-found',
    }
  }

  // The engine decision. `defaultEngine` in the patch can pin one; `auto` is
  // the inference chain in lib/engine.js.
  const pinned = typeof settings.defaultEngine === 'string' && settings.defaultEngine !== 'auto' ? settings.defaultEngine : ''
  const engineChoice = inferEngine(resolvedTex, {
    explicit: explicitEngine !== '' ? explicitEngine : pinned,
    respectLatexmkrc: settings.respectLatexmkrc === true,
    projectDir,
  })
  const engine = engineChoice.engine
  if (engineChoice.invalid === true) warnings.push(engineChoice.detail)

  const rootText = readTextHead(resolvedTex)
  const bibliography = inferBibliographyBackend(rootText)

  // Output goes to a dedicated directory so a build cannot be confused with a
  // stale PDF sitting next to the source.
  const outputDir = outDirMode === 'temp'
    ? await makeTempOutDir(projectDir)
    : join(projectDir, '.latex-build')
  try {
    mkdirSync(outputDir, { recursive: true })
  } catch (error) {
    return {
      ...emptyResult({ started, engine, texFile: resolvedTex, engineSource: engineChoice.source }),
      norc: settings.respectLatexmkrc !== true,
      warnings,
      error: `could not create the output directory: ${error.message}`,
    }
  }

  const latexmk = texBin.length > 0 ? join(texBin, process.platform === 'win32' ? 'latexmk.exe' : 'latexmk') : 'latexmk'
  const norc = settings.respectLatexmkrc !== true
  const argv = []
  if (norc) argv.push('-norc')
  argv.push(engineFlag(engine), '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1')
  argv.push(`-outdir=${toTexPath(outputDir)}`)
  // The file is passed as a bare name with cwd set to the project directory:
  // that keeps a Chinese directory out of the command line entirely, which is
  // the form measured to work.
  argv.push(fileName)

  // The project's own latexmkrc is ignored unless the caller opted in; say so,
  // because a project that builds via its rc will behave differently.
  const rcFile = ['latexmkrc', '.latexmkrc', 'LatexmkRc'].find((name) => isFile(join(projectDir, name)))
  if (rcFile !== undefined && norc) {
    warnings.push(
      `The project has a ${rcFile}, but it was ignored because latexmk runs with -norc. `
      + 'Set respectLatexmkrc: true in the bundle patch (or the settings panel) to honour it.',
    )
  }

  const timeoutMs = Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : COMPILE_TIMEOUT_MS

  logger?.info?.(`latex: compiling ${resolvedTex} with ${engine} (${engineChoice.source})${norc ? ' -norc' : ''}`)

  const result = await runProcess({
    executable: latexmk,
    argv,
    cwd: projectDir,
    timeoutMs,
    signal,
    // A UTF-8 locale keeps TeX Live's own tooling from writing GBK into places
    // that cannot be re-decoded, and silences the Perl locale warning.
    env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
  })

  const logPath = join(outputDir, `${basename(fileName, extname(fileName))}.log`)
  const logText = readIfPresent(logPath)
  const findings = parseLog(logText, { engine, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr })

  const pdfPath = findProduct(outputDir, fileName)
  const summary = headline(findings)

  if (result.timedOut) warnings.push(`The build exceeded ${timeoutMs} ms and was killed.`)
  if (result.aborted) warnings.push('The build was cancelled.')
  if (result.truncated) warnings.push('Captured output hit the byte cap; the tail shown is incomplete.')
  if (result.damaged && !findings.errors.length) {
    warnings.push('Some captured text could not be decoded cleanly; the excerpts may be incomplete.')
  }
  if (pdfPath === '' && result.exitCode === 0) {
    warnings.push(
      'The build reported success but produced no PDF. On a ctex project without an explicit engine flag '
      + 'latexmk builds DVI instead; the engine flag is set here, so check the log for what the engine wrote.',
    )
  }
  if (hasShortName(outputDir)) {
    warnings.push(`The output directory still contains a "~": ${outputDir}`)
  }
  if (findings.rerunRequested.biber && result.exitCode === 0) {
    notes.push('A biblatex warning asked to rerun Biber; latexmk normally handles this, but the final pass still asked for it.')
  }

  return {
    ok: result.exitCode === 0 && pdfPath !== '',
    texFile: resolvedTex,
    engine,
    engineSource: engineChoice.source,
    engineTrail: engineChoice.trail,
    engineObserved: findings.engineUsed,
    bibliography: bibliography.backend,
    bibliographyDetail: bibliography.detail,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    timedOut: result.timedOut,
    aborted: result.aborted,
    truncated: result.truncated,
    norc,
    argv,
    outputDir,
    logPath: isFile(logPath) ? logPath : '',
    pdfPath,
    pdfBytes: pdfPath !== '' ? fileSize(pdfPath) : 0,
    pdfAgeSeconds: pdfPath !== '' ? fileAgeSeconds(pdfPath) : null,
    findings,
    headline: summary,
    stdoutTail: tail(result.stdout, 4000),
    stderrTail: tail(result.stderr, 2000),
    encoding: result.encoding,
    damagedText: result.damaged,
    auxFiles: collectAux(outputDir, fileName),
    warnings,
    notes,
    error: '',
  }
}

/**
 * Build an output directory under the system temp, resolved to its long name.
 *
 * @param projectDir - the project directory, used as a fallback root.
 * @returns the absolute output directory.
 */
async function makeTempOutDir(projectDir) {
  const root = safeTempRoot(projectDir)
  const name = `dsh-latex-${process.pid}-${Date.now().toString(36)}`
  const dir = join(root.dir, name)
  mkdirSync(dir, { recursive: true })
  return longPath(dir)
}

/**
 * Find the PDF the build produced.
 *
 * latexmk writes `<jobname>.pdf` into the output directory. A project with a
 * `jobname` option writes a different name, so the directory is inspected
 * rather than assuming.
 *
 * @param outputDir - the output directory.
 * @param texFileName - the .tex file name.
 * @returns the absolute PDF path, or an empty string.
 */
function findProduct(outputDir, texFileName) {
  const stem = basename(texFileName, extname(texFileName))
  const direct = join(outputDir, `${stem}.pdf`)
  if (isFile(direct)) return longPath(direct)
  const pdfs = listDirNames(outputDir).filter((name) => name.toLowerCase().endsWith('.pdf'))
  if (pdfs.length > 0) return longPath(join(outputDir, pdfs[0]))
  return ''
}

/**
 * Collect the auxiliary files a build left in the output directory.
 *
 * @param outputDir - the output directory.
 * @param texFileName - the .tex file name.
 * @returns the auxiliary file paths.
 */
function collectAux(outputDir, texFileName) {
  const stem = basename(texFileName, extname(texFileName))
  return listDirNames(outputDir)
    .filter((name) => name.startsWith(stem) && AUX_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)))
    .map((name) => join(outputDir, name))
}

/** Read a file as UTF-8, tolerating a missing or unreadable file. */
function readIfPresent(file) {
  try {
    return decodeUtf8(readFileSync(file))
  } catch {
    return ''
  }
}

/** Read at most 64 KB of a UTF-8 text file. */
function readTextHead(file) {
  try {
    const buffer = readFileSync(file)
    return buffer.subarray(0, Math.min(buffer.length, 64 * 1024)).toString('utf8')
  } catch {
    return ''
  }
}

/** File size in bytes, or 0. */
function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** Age of a file in seconds, or null. */
function fileAgeSeconds(file) {
  try {
    return Math.round((Date.now() - statSync(file).mtimeMs) / 1000)
  } catch {
    return null
  }
}

/** Keep the last `max` characters of a string. */
function tail(text, max) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= max ? value : value.slice(value.length - max)
}

/**
 * A complete, schema-shaped result for a compile that never ran.
 *
 * Centralised so a new field added to the success result cannot be forgotten in
 * the failure paths — which is exactly how `pdfBytes` ended up `undefined` and
 * made the harness reject the entire tool result as non-JSON.
 *
 * @param options - start time plus whatever identifies the attempted build.
 * @returns every field the tool output schema declares, in its empty form.
 */
function emptyResult(options) {
  const { started, engine = '', texFile = '', engineSource = '' } = options
  return {
    ok: false,
    texFile,
    engine,
    engineSource,
    engineObserved: '',
    bibliography: '',
    bibliographyDetail: '',
    exitCode: null,
    durationMs: Date.now() - started,
    timedOut: false,
    aborted: false,
    truncated: false,
    norc: true,
    argv: [],
    outputDir: '',
    logPath: '',
    pdfPath: '',
    pdfBytes: 0,
    pdfAgeSeconds: null,
    findings: emptyFindings(),
    headline: '',
    stdoutTail: '',
    stderrTail: '',
    encoding: { stdout: 'utf-8', stderr: 'utf-8' },
    damagedText: false,
    auxFiles: [],
    warnings: [],
    notes: [],
    error: '',
  }
}

/** The shape of an empty findings object, so a failed compile still matches the schema. */
function emptyFindings() {
  return {
    errors: [],
    missingGlyphs: [],
    missingCitations: [],
    missingReferences: [],
    missingPackages: [],
    overfull: [],
    warnings: [],
    rerunRequested: { biber: false, bibtex: false, labels: false },
    backendRan: false,
    engineUsed: '',
    failed: false,
    fatal: false,
  }
}

/** Whether a decoded buffer shows damage; re-exported for the tool layer. */
export { looksDamaged }
