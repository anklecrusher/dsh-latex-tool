/**
 * Environment self-check: `latex_doctor`.
 *
 * This replaces the official plugin's doctor, which on this machine reports
 * "not ready" permanently because its smoke test builds inside an 8.3 short
 * path that latexmk refuses. The design rule here is the opposite one: **every
 * check reports the evidence it used**, so a "not ready" verdict is always
 * explainable and a "ready" verdict is never a guess.
 *
 * The checks, in the order they matter:
 *
 *   1. Is there a TeX bin directory that actually exists? (PATH membership is
 *      not evidence: this machine's Machine PATH still lists a deleted
 *      `D:\texlive\2024`.)
 *   2. Does latexmk answer, and what version? (Read by pattern, because the
 *      previous line is a Perl locale warning.)
 *   3. Which engines answer? Which packages exist — ctex, xeCJK, fontspec,
 *      biblatex, biblatex-gb7714-2015?
 *   4. Which bibliography backends (biber / bibtex) exist?
 *   5. Which PDF-text tier can the machine reach (PyMuPDF → pdftotext →
 *      structure only)?
 *   6. Is the temp directory's 8.3 short name fixed, and can a `ctex` document
 *      actually compile from it? (The optional smoke test — the only part that
 *      costs a real build, ~10 s.)
 *
 * @module @local/dsh-latex-tool/lib/doctor
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectBackends,
  detectEngines,
  detectLatexmk,
  detectPackages,
  detectPdftotext,
  detectPython,
  detectTexBin,
  exeName,
} from './detect.js'
import { isFile, longPath, safeTempRoot } from './paths.js'
import { COMPILE_TIMEOUT_MS, runProcess } from './run.js'

/** A minimal ctex document, used by the smoke test. */
const SMOKE_TEX = [
  '\\documentclass[UTF8]{ctexart}',
  '\\begin{document}',
  '中文冒烟测试 ABC',
  '\\end{document}',
  '',
].join('\n')

/**
 * Run the environment check.
 *
 * @param options - configured paths, whether to run the smoke test, abort signal.
 * @returns the doctor report.
 */
export async function diagnose(options = {}) {
  const {
    texBin: configuredTexBin = '',
    pythonPath = '',
    smoke = false,
    signal = undefined,
    logger = undefined,
    timeoutMs = COMPILE_TIMEOUT_MS,
  } = options

  const started = Date.now()
  const warnings = []
  const checks = []

  const tex = await detectTexBin({ configuredTexBin, signal })
  if (tex.error !== undefined) warnings.push(tex.error)

  const texPresent = tex.dir.length > 0
  checks.push({
    id: 'tex',
    ok: texPresent,
    detail: texPresent
      ? `TeX bin directory: ${tex.dir} (found via ${tex.source})`
      : 'No TeX installation was found. Install TeX Live or MiKTeX, or set texBin in the bundle patch.',
  })

  if (!texPresent) {
    return {
      status: 'missing',
      texRoot: '',
      texBin: '',
      texSource: tex.source,
      texVersion: '',
      latexmkVersion: '',
      latexmkDetail: '',
      engines: [],
      packages: [],
      backends: [],
      python: await detectPython({ configuredPath: pythonPath, signal, testImport: false }),
      pdfTextTier: 'minimal',
      pdftotext: detectPdftotext().executable,
      tempRaw: safeTempRoot('').raw,
      tempResolved: safeTempRoot('').resolved,
      shortNameFixed: safeTempRoot('').shortNameFixed,
      checks,
      smoke: { ran: false, ok: false, exitCode: null, durationMs: 0, detail: 'skipped: no TeX installation' },
      warnings,
      durationMs: Date.now() - started,
    }
  }

  const latexmk = await detectLatexmk(tex.dir, signal)
  const latexmkOk = latexmk.version.length > 0
  checks.push({
    id: 'latexmk',
    ok: latexmkOk,
    detail: latexmkOk
      ? `latexmk ${latexmk.version} (${latexmk.detail})`
      : `latexmk did not report a version: ${latexmk.detail || latexmk.executable}`,
  })

  const engines = await detectEngines(tex.dir, signal)
  const present = engines.filter((engine) => engine.present)
  checks.push({
    id: 'engines',
    ok: present.length > 0,
    detail: present.length > 0
      ? present.map((engine) => `${engine.name}: ${engine.version || 'present'}`).join(' · ')
      : 'No engine (xelatex / pdflatex / lualatex) is present next to latexmk.',
  })

  const packages = await detectPackages(tex.dir, signal)
  const ctex = packages.find((entry) => entry.name === 'ctex')
  const gb7714 = packages.find((entry) => entry.name === 'biblatex-gb7714-2015')
  checks.push({
    id: 'ctex',
    ok: ctex?.found === true,
    detail: ctex?.found === true
      ? `ctex found at ${ctex.path}`
      : 'ctex is not installed; Chinese classes (ctexart/ctexrep/ctexbook) will not compile. Run: tlmgr install ctex',
  })
  checks.push({
    id: 'gb7714',
    ok: gb7714?.found === true,
    detail: gb7714?.found === true
      ? `biblatex-gb7714-2015 found at ${gb7714.path}`
      : 'biblatex-gb7714-2015 is not installed; GB/T 7714 citation styles will not load. Run: tlmgr install biblatex-gb7714-2015',
  })
  if (!present.some((engine) => engine.name === 'xelatex')) {
    warnings.push('xelatex is missing. Chinese theses normally need it; ctex under pdflatex drops unmapped glyphs silently.')
  }

  const backends = detectBackends(tex.dir)
  const pdftotext = detectPdftotext()
  const python = await detectPython({ configuredPath: pythonPath, signal })

  const pdfTextTier = python.hasPyMuPDF ? 'full' : pdftotext.executable !== '' ? 'text' : 'minimal'
  checks.push({
    id: 'pdf-text',
    ok: pdfTextTier !== 'minimal',
    detail: pdfTextTier === 'full'
      ? `PyMuPDF available in ${python.executable} (Python ${python.version})`
      : pdfTextTier === 'text'
        ? `PyMuPDF unavailable; pdftotext at ${pdftotext.executable} will be used (missing glyphs are detected but not attributed)`
        : 'Neither PyMuPDF nor pdftotext is available: PDF verification can only check the file structure.',
  })
  if (python.error !== undefined) warnings.push(python.error)

  const temp = safeTempRoot('')
  checks.push({
    id: 'temp-shortname',
    ok: !temp.resolved.includes('~'),
    detail: temp.raw === temp.resolved
      ? `temp directory is already a long name: ${temp.resolved}`
      : `8.3 short name resolved: ${temp.raw} -> ${temp.resolved}`,
  })

  const smokeResult = smoke
    ? await runSmoke({ texBin: tex.dir, timeoutMs, signal, logger })
    : { ran: false, ok: false, exitCode: null, durationMs: 0, detail: 'not requested' }
  if (smokeResult.ran) checks.push({ id: 'smoke-compile', ok: smokeResult.ok, detail: smokeResult.detail })

  const root = tex.texmfRoot ?? ''
  const status = decideStatus({ latexmkOk, enginesPresent: present.length > 0, ctexFound: ctex?.found === true, smokeResult })

  return {
    status,
    texRoot: root,
    texBin: tex.dir,
    texSource: tex.source,
    texVersion: parseTexliveYear(root) || parseTexliveYear(tex.dir),
    latexmkVersion: latexmk.version,
    latexmkDetail: latexmk.detail,
    engines,
    packages,
    backends,
    python,
    pdfTextTier,
    pdftotext: pdftotext.executable,
    tempRaw: temp.raw,
    tempResolved: temp.resolved,
    shortNameFixed: temp.shortNameFixed,
    checks,
    smoke: smokeResult,
    warnings,
    durationMs: Date.now() - started,
  }
}

/**
 * Turn the individual results into one verdict.
 *
 * `ready` requires a working latexmk and at least one engine. `degraded` is a
 * usable installation with a real gap (no ctex, no PyMuPDF, or a failed smoke
 * test). `missing` means the toolchain cannot run at all.
 *
 * @param input - the check outcomes.
 * @returns the status string.
 */
function decideStatus(input) {
  const { latexmkOk, enginesPresent, ctexFound, smokeResult } = input
  if (!latexmkOk || !enginesPresent) return 'missing'
  if (!ctexFound) return 'degraded'
  if (smokeResult.ran && !smokeResult.ok) return 'degraded'
  return 'ready'
}

/**
 * Extract the TeX Live release year from a root directory such as
 * `D:/Program Files (x86)/texlive/2026`.
 *
 * @param value - the directory path.
 * @returns the year, or an empty string.
 */
function parseTexliveYear(value) {
  const match = String(value ?? '').match(/(20\d{2})/)
  return match?.[1] ?? ''
}

/**
 * Compile a minimal `ctexart` document in a resolved-long-name temp directory.
 *
 * This is the check the official plugin fails permanently. It is deliberately
 * the *last* thing the doctor does, because it costs a real build, and it
 * reports the exact directory and argv it used so a failure is diagnosable
 * without rerunning anything.
 *
 * @param options - TeX bin directory, deadline, abort signal.
 * @returns whether a PDF was produced, and the evidence.
 */
async function runSmoke(options) {
  const { texBin, timeoutMs, signal, logger = undefined } = options
  const started = Date.now()
  const root = safeTempRoot('')
  const dir = longPath(join(root.dir, `dsh-latex-smoke-${process.pid}-${Date.now().toString(36)}`))
  const latexmk = join(texBin, exeName('latexmk'))
  const texFile = join(dir, 'smoke.tex')
  const pdfFile = join(dir, 'smoke.pdf')

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(texFile, SMOKE_TEX, 'utf8')
  } catch (error) {
    return { ran: true, ok: false, exitCode: null, durationMs: Date.now() - started, detail: `could not create the smoke directory: ${error.message}` }
  }

  try {
    const result = await runProcess({
      executable: latexmk,
      argv: ['-norc', '-xelatex', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', 'smoke.tex'],
      cwd: dir,
      timeoutMs: Math.min(timeoutMs, 180_000),
      signal,
      env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
    })
    const ok = result.exitCode === 0 && isFile(pdfFile)
    logger?.info?.(`latex: smoke test ${ok ? 'passed' : 'failed'} in ${dir} (exit ${result.exitCode})`)
    return {
      ran: true,
      ok,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      detail: ok
        ? `a minimal ctexart document compiled to PDF in ${dir}`
        : `the smoke build failed (exit ${result.exitCode}) in ${dir}. `
          + (result.timedOut ? 'It timed out. ' : '')
          + `last stderr: ${lastLines(result.stderr, 3)}`,
    }
  } catch (error) {
    return { ran: true, ok: false, exitCode: null, durationMs: Date.now() - started, detail: `the smoke build could not start: ${error.message}` }
  } finally {
    // The directory exists only for this check; leaving it behind would be a
    // by-product the user has to clean up.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

/**
 * Keep the last few non-empty lines of a captured stream.
 * @param text - the captured text.
 * @param count - how many lines to keep.
 * @returns the retained lines.
 */
function lastLines(text, count) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.slice(Math.max(0, lines.length - count)).join(' | ') || '(no stderr output)'
}

