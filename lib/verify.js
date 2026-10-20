/**
 * PDF product verification — the capability the official plugin does not have.
 *
 * Its check stops at `pdfExists: True`. That is not evidence of anything: a
 * LaTeX build exits 0 and writes a PDF while glyphs are missing, pages are
 * blank, or Chinese silently degraded to tofu. Each of those was reproduced on
 * this machine, and each of the three checks below is what turns it into an
 * explicit finding.
 *
 * **Three tiers, and the result always says which one answered.** This is the
 * part a naive implementation gets wrong:
 *
 *   | Tier      | Tool                    | What it can see                                        |
 *   |-----------|-------------------------|--------------------------------------------------------|
 *   | `full`    | PyMuPDF via Python      | pages, per-page CJK, missing glyphs, blank pages, refs |
 *   | `text`    | `pdftotext -enc UTF-8`  | pages, per-page CJK, blank pages, literal cite keys     |
 *   | `minimal` | PDF structure only      | %PDF- signature, %%EOF, size, mtime                    |
 *
 * `capability` in the result is never upgraded to look better than it is. Two
 * measured reasons for the fallbacks existing at all:
 *
 *   - PyMuPDF is present in this machine's system Python 3.13 but **not** in
 *     the Python DSH ships (3.12). A plugin that hard-depends on `fitz` breaks
 *     on a clean install.
 *   - `pdftotext` without `-enc UTF-8` writes through the console code page and
 *     silently emits empty text for Chinese, which would read as "no findings".
 *     The flag is not optional.
 *
 * A third measured detail: XeTeX writes **U+FFFF** for a glyph its font lacks,
 * while `pdftotext` writes **U+FFFD**. Both must be treated as a failed glyph,
 * and a blank page carrying only its page number is still blank.
 *
 * @module @local/dsh-latex-tool/lib/verify
 */

import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectPython, detectPdftotext } from './detect.js'
import { isFile, longPath } from './paths.js'
import { runProcess } from './run.js'

/** Characters that mean "the glyph could not be drawn". */
const REPLACEMENT = '\uFFFD'
/** The noncharacter XeTeX emits for a glyph missing from the selected font. */
const NONCHARACTER = '\uFFFF'
/** Tofu boxes some fonts and readers emit. */
const TOFU = '\u25A1\u25A0'
/** CJK Unified Ideographs (the range a Chinese thesis body must contain). */
const CJK = /[\u4e00-\u9fff]/
/**
 * The same range with the global flag, for counting.
 *
 * `String.match` with a non-global regex returns only the FIRST match, so
 * counting with {@link CJK} directly would report every non-empty page as
 * carrying exactly one Chinese character — a silent undercount that makes a
 * page of Chinese look nearly empty.
 */
const CJK_ALL = /[\u4e00-\u9fff]/g
/** A page number alone is not content. */
const PAGE_NUMBER_ONLY = /^\s*\d+\s*$/
/** `[?]` is LaTeX's rendered form of an unresolved reference. */
const UNRESOLVED_REF = /\[\?\]/
/** A literal citation key in brackets means the key was not in the .bib. */
const LITERAL_CITE = /\[[a-zA-Z][A-Za-z0-9_:.-]{3,}\]/

/**
 * Resolve the PDF a caller named.
 *
 * @param target - the argument as given.
 * @param cwd - session working directory.
 * @returns the absolute path, or an empty string when it does not exist.
 */
export function resolvePdf(target, cwd) {
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  const absolute = isAbsolute(target) ? target : resolve(base, target)
  return isFile(absolute) ? longPath(absolute) : ''
}

/**
 * Parse a page specification such as `1-3`, `2`, or `1,4,7-9`.
 *
 * @param spec - the spec string.
 * @param total - total pages, used for clamping.
 * @returns ascending 1-based page numbers.
 */
export function parsePages(spec, total) {
  const out = new Set()
  for (const chunk of String(spec ?? '').split(',')) {
    const trimmed = chunk.trim()
    if (trimmed.length === 0) continue
    const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range !== null) {
      const low = Math.max(1, Number(range[1]))
      const high = Math.min(total, Number(range[2]))
      for (let page = low; page <= high; page += 1) out.add(page)
      continue
    }
    const single = trimmed.match(/^(\d+)$/)
    if (single !== null) {
      const page = Number(single[1])
      if (page >= 1 && page <= total) out.add(page)
    }
  }
  return [...out].sort((left, right) => left - right)
}

/**
 * Verify a PDF.
 *
 * @param options - pdf path, page spec, render request, dpi, python/pdftotext hints.
 * @returns the verification result with an explicit `capability`.
 */
export async function verifyPdf(options) {
  const {
    pdfPath,
    pages = '1-3',
    render = false,
    dpi = 110,
    expectCjk = true,
    pngDir = '',
    pythonPath = '',
    signal = undefined,
    logger = undefined,
  } = options

  const started = Date.now()
  if (pdfPath === '' || !isFile(pdfPath)) {
    return failed(pdfPath, `The PDF "${pdfPath}" does not exist.`, started)
  }

  const size = fileSize(pdfPath)
  const structure = checkStructure(pdfPath)
  if (!structure.ok) {
    return {
      ...failed(pdfPath, structure.detail, started),
      capability: 'minimal',
      verifyTool: 'structure',
      capabilityDetail: structure.detail,
      sizeBytes: size,
      findings: [structure.detail],
    }
  }

  // Tier 1: PyMuPDF. Full information, and the only tier that can locate a
  // missing glyph precisely (XeTeX writes U+FFFF, which a page-level count
  // cannot attribute).
  const python = await detectPython({ configuredPath: pythonPath, signal })
  if (python.hasPyMuPDF) {
    const full = await verifyWithPymupdf(python, { pdfPath, pages, render, dpi, expectCjk, pngDir }, signal)
    if (full !== null) {
      logger?.info?.(`latex: verified ${pdfPath} with PyMuPDF (${full.pages} pages)`)
      return { ...full, sizeBytes: size, durationMs: Date.now() - started, warnings: [] }
    }
  }

  // Tier 2: pdftotext -enc UTF-8. Everywhere, but cannot attribute a missing
  // glyph to a codepoint — only detect that the page contains one.
  const pdftotext = detectPdftotext()
  if (pdftotext.executable !== '') {
    const text = await verifyWithPdftotext(pdftotext, { pdfPath, pages, render, dpi, expectCjk, pngDir, python }, signal)
    if (text !== null) {
      logger?.info?.(`latex: verified ${pdfPath} with pdftotext (${text.pages} pages)`)
      // The text tier's own warnings (what this tier cannot see, why render was
      // skipped, why PyMuPDF was unavailable) must survive; overwriting them
      // with only the Python error would hide the degradation.
      const carried = Array.isArray(text.warnings) ? text.warnings : []
      const extra = python.error !== undefined && python.error.length > 0 ? [python.error] : []
      return {
        ...text,
        sizeBytes: size,
        durationMs: Date.now() - started,
        warnings: [...carried, ...extra],
      }
    }
  }

  // Tier 3: structure only.
  return {
    ...failed(pdfPath, '', started),
    capability: 'minimal',
    capabilityDetail: 'only the PDF structure could be checked: no PyMuPDF and no pdftotext were available',
    verifyTool: 'structure',
    sizeBytes: size,
    pages: 0,
    durationMs: Date.now() - started,
    findings: [],
    warnings: [
      'Verification ran at the minimal tier: pages, CJK counts, blank pages and missing glyphs were NOT checked.',
      'Install PyMuPDF (`pip install pymupdf`) for full verification, or put pdftotext on PATH for the text tier.',
    ],
  }
}

/**
 * The skeleton every tier returns, so a caller never has to branch on shape.
 *
 * @param pdfPath - the PDF inspected.
 * @param error - a failure detail, when the check could not run.
 * @param started - start timestamp, for the duration.
 * @returns an empty result.
 */
function failed(pdfPath, error, started) {
  return {
    capability: 'minimal',
    capabilityDetail: '',
    verifyTool: 'structure',
    pdf: pdfPath,
    sizeBytes: 0,
    pages: 0,
    perPageCjk: [],
    zeroCjkPages: [],
    blankPages: [],
    missingGlyphCount: 0,
    missingGlyphs: [],
    unresolvedRefPages: [],
    literalCitePages: [],
    findings: [],
    rendered: [],
    pagesRendered: [],
    durationMs: Date.now() - started,
    warnings: [],
    error: typeof error === 'string' ? error : '',
  }
}

/**
 * Check the PDF signature and trailer.
 *
 * @param pdfPath - the PDF.
 * @returns whether the file is structurally a PDF, and the detail.
 */
function checkStructure(pdfPath) {
  let buffer
  try {
    buffer = readFileSync(pdfPath)
  } catch (error) {
    return { ok: false, detail: `The PDF could not be read: ${error.message}` }
  }
  if (buffer.length < 32) return { ok: false, detail: `The file is only ${buffer.length} bytes; it is not a PDF.` }
  const head = buffer.subarray(0, 8).toString('latin1')
  if (!head.startsWith('%PDF-')) {
    return { ok: false, detail: `The file does not start with %PDF- (found "${head.replace(/[\r\n]/g, ' ')}").` }
  }
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString('latin1')
  if (!tail.includes('%%EOF')) {
    return { ok: false, detail: 'The file has no %%EOF trailer; the build was interrupted or the file is truncated.' }
  }
  return { ok: true, detail: `%PDF- header and %%EOF trailer present (${head.trim()})` }
}

/**
 * Tier 1: verify through the plugin's own Python helper.
 *
 * The helper lives in `scripts/verify_pdf.py` and is passed `--json`, so the
 * contract is a single JSON object on stdout. Exit code 1 means "findings" and
 * is not an error — the JSON is complete either way.
 *
 * @param python - the detected interpreter.
 * @param request - the verification request.
 * @param signal - abort signal.
 * @returns the result, or null when the tier could not run.
 */
async function verifyWithPymupdf(python, request, signal) {
  const { pdfPath, pages, render, dpi, expectCjk, pngDir } = request
  const script = helperScriptPath()
  if (script === '') return null

  const targetDir = pngDir.length > 0 ? longPath(pngDir) : join(dirname(pdfPath), '.latex-verify')
  try {
    mkdirSync(targetDir, { recursive: true })
  } catch {
    return null
  }

  const argv = [script, pdfPath, '--json', '--pages', String(pages), '--dpi', String(dpi), '--png-dir', targetDir]
  // The helper inspects every page and renders only `--pages`; verify without
  // `render` therefore adds nothing to render at all rather than writing PNGs
  // the caller did not ask for.
  if (!render) argv.push('--no-render')
  if (expectCjk) argv.push('--expect-cjk')

  let result
  try {
    result = await runProcess({
      executable: python.invocation,
      argv,
      timeoutMs: 120_000,
      signal,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
  } catch {
    return null
  }

  if (result.stdout.trim().length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return null
  }
  if (parsed?.error !== null && parsed?.error !== undefined) {
    return null
  }

  return {
    capability: 'full',
    capabilityDetail: `PyMuPDF via ${python.executable} (Python ${python.version})`,
    verifyTool: 'pymupdf',
    pdf: pdfPath,
    pages: Number(parsed.pages ?? 0),
    perPageCjk: Array.isArray(parsed.perPageCjk) ? parsed.perPageCjk.map((value) => Number(value)) : [],
    zeroCjkPages: Array.isArray(parsed.zeroCjkPages) ? parsed.zeroCjkPages : [],
    blankPages: Array.isArray(parsed.blankPages) ? parsed.blankPages : [],
    missingGlyphCount: Number(parsed?.missingGlyph?.total ?? 0),
    missingGlyphs: Array.isArray(parsed?.missingGlyph?.codepoints)
      ? parsed.missingGlyph.codepoints.map((entry) => ({
          char: String(entry.char ?? ''),
          code: String(entry.code ?? ''),
          count: Number(entry.count ?? 0),
        }))
      : [],
    unresolvedRefPages: Array.isArray(parsed.unresolvedRefPages) ? parsed.unresolvedRefPages : [],
    literalCitePages: Array.isArray(parsed.literalCitePages) ? parsed.literalCitePages : [],
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    rendered: Array.isArray(parsed.rendered) ? parsed.rendered : [],
    pagesRendered: Array.isArray(parsed.pagesRendered) ? parsed.pagesRendered : [],
    expectCjk: expectCjk === true,
    error: '',
  }
}

/**
 * Tier 2: verify through `pdftotext -enc UTF-8`.
 *
 * The `-enc UTF-8` flag is mandatory: without it the tool writes through the
 * console code page and a Chinese document extracts as empty text, which reads
 * as "clean" instead of "lost everything".
 *
 * @param pdftotext - the resolved executable.
 * @param request - the verification request.
 * @param signal - abort signal.
 * @returns the result, or null when the tier could not run.
 */
async function verifyWithPdftotext(pdftotext, request, signal) {
  const { pdfPath, render, dpi, expectCjk, pngDir, python } = request
  let result
  try {
    result = await runProcess({
      executable: pdftotext.executable,
      // No `-nopgbrk`: the form feed between pages is the only page boundary
      // this tier has, so suppressing it would collapse the whole document
      // into one page.
      argv: ['-enc', 'UTF-8', pdfPath, '-'],
      timeoutMs: 120_000,
      signal,
    })
  } catch {
    return null
  }
  if (result.exitCode !== 0 && result.stdout.trim().length === 0) return null

  // `pdftotext` separates pages with a form feed. A trailing empty segment is
  // the artefact of the final one and is not a page.
  const text = result.stdout
  const pageTexts = text.split('\f')
  if (pageTexts.length > 1 && pageTexts[pageTexts.length - 1].trim().length === 0) pageTexts.pop()

  const perPageCjk = pageTexts.map((pageText) => (pageText.match(CJK_ALL) ?? []).length)
  const blankPages = []
  const zeroCjkPages = []
  const unresolvedRefPages = []
  const literalCitePages = []
  const findings = []

  pageTexts.forEach((pageText, index) => {
    const pageNumber = index + 1
    const trimmed = pageText.trim()
    if (trimmed.length === 0 || PAGE_NUMBER_ONLY.test(trimmed)) {
      blankPages.push(pageNumber)
      findings.push(`page ${pageNumber}: effectively blank (no text beyond a page number)`)
    }
    if (expectCjk && perPageCjk[index] === 0 && trimmed.length > 0) {
      zeroCjkPages.push(pageNumber)
    }
    if (UNRESOLVED_REF.test(pageText)) {
      unresolvedRefPages.push(pageNumber)
      findings.push(`page ${pageNumber}: unresolved reference rendered as '[?]'`)
    }
    if (LITERAL_CITE.test(pageText)) {
      literalCitePages.push(pageNumber)
      findings.push(`page ${pageNumber}: looks like a literal citation key in brackets (missing bib entry)`)
    }
    const replacementCount = countChar(pageText, REPLACEMENT)
    const noncharacterCount = countChar(pageText, NONCHARACTER)
    const tofuCount = countChar(pageText, TOFU)
    const missing = replacementCount + noncharacterCount + tofuCount
    if (missing > 0) {
      findings.push(
        `page ${pageNumber}: ${missing} glyph(s) failed to render `
        + '(U+FFFD / U+FFFF / tofu box — check the log for "Missing character")',
      )
    }
  })

  if (expectCjk && zeroCjkPages.length === pageTexts.length && pageTexts.length > 0) {
    findings.push('the document is entirely non-CJK but expectCjk is true')
  } else if (expectCjk && zeroCjkPages.length > 0) {
    findings.push(`pages with zero CJK characters: ${zeroCjkPages.join(', ')}`)
  }

  const missingGlyphCount = countChar(text, REPLACEMENT) + countChar(text, NONCHARACTER) + countChar(text, TOFU)

  // Rendering needs a rasteriser, and the only one available is PyMuPDF. When
  // it is absent the caller is told rather than handed a silent empty list.
  const warnings = []
  let rendered = []
  let pagesRendered = []
  if (render) {
    const raster = await renderWithPymupdf(python, { pdfPath, pages: request.pages, dpi, pngDir })
    if (raster === null) {
      warnings.push('render was requested but no PyMuPDF-backed rasteriser is available; no PNG was written.')
    } else {
      rendered = raster.rendered
      pagesRendered = raster.pagesRendered
    }
  }

  // The tier is never silently weaker than reported: a `text` answer must say
  // what it could not see, or a caller reads "no findings" as "verified".
  warnings.unshift(
    'Verification ran at the text tier (pdftotext): page count, CJK counts and blank pages are real, '
    + 'but a missing glyph is only detected per page and not attributed to a codepoint, and encoding damage '
    + 'cannot be distinguished from a genuinely empty page.',
  )
  if (python?.error !== undefined && python.error.length > 0) warnings.push(python.error)

  return {
    capability: 'text',
    capabilityDetail: `pdftotext -enc UTF-8 at ${pdftotext.executable}; missing glyphs are detected per page but not attributed to a codepoint`,
    verifyTool: 'pdftotext',
    pdf: pdfPath,
    pages: pageTexts.length,
    perPageCjk,
    zeroCjkPages,
    blankPages,
    missingGlyphCount,
    missingGlyphs: [],
    unresolvedRefPages,
    literalCitePages,
    findings,
    rendered,
    pagesRendered,
    expectCjk: expectCjk === true,
    error: '',
    warnings,
  }
}

/**
 * Render pages to PNG through PyMuPDF when it exists (used by tier 2).
 *
 * @param python - the detected interpreter.
 * @param request - pdf path, page spec, dpi and target directory.
 * @returns the rendered paths, or null when PyMuPDF is unavailable.
 */
async function renderWithPymupdf(python, request) {
  if (!python?.hasPyMuPDF) return null
  const script = helperScriptPath()
  if (script === '') return null
  const { pdfPath, pages, dpi, pngDir } = request
  const targetDir = pngDir.length > 0 ? longPath(pngDir) : join(dirname(pdfPath), '.latex-verify')
  try {
    mkdirSync(targetDir, { recursive: true })
    const result = await runProcess({
      executable: python.invocation,
      argv: [script, pdfPath, '--json', '--pages', String(pages), '--dpi', String(dpi), '--png-dir', targetDir],
      timeoutMs: 120_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    if (result.exitCode === 0 || result.exitCode === 1) {
      const parsed = JSON.parse(result.stdout)
      return { rendered: parsed.rendered ?? [], pagesRendered: parsed.pagesRendered ?? [] }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Absolute path of the bundled Python helper.
 *
 * @returns the path, or an empty string when the file is missing.
 */
function helperScriptPath() {
  const candidate = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify_pdf.py')
  const resolved = longPath(candidate)
  return isFile(resolved) ? resolved : ''
}

/** Count non-overlapping occurrences of any character in a set. */
function countChar(text, characters) {
  let total = 0
  for (const character of characters) {
    let index = text.indexOf(character)
    while (index !== -1) {
      total += 1
      index = text.indexOf(character, index + 1)
    }
  }
  return total
}

/** File size in bytes, or 0. */
function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
