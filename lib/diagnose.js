/**
 * LaTeX log parser: turn a `.log` file into structured findings.
 *
 * This is the line between "mechanism" and "knowledge" in the design: the
 * `references/log-errors.md` table explains *why* each message happens, but the
 * model must not have to grep for them. The patterns below are implemented
 * here, and each is grounded in a log this machine actually produced
 * (2026-10-20, TeX Live 2026, `-file-line-error`):
 *
 *   ./bad.tex:4: Undefined control sequence.
 *   ! LaTeX Error: File `notapackagexyz.sty' not found.
 *   Missing character: There is no 𠀀 (U+20000) in font SimSun/OT:script=hani;langua
 *   ge=dflt;!                                    ← the font descriptor wraps
 *   LaTeX Warning: Citation 'nokey' on page 1 undefined on input line 7.
 *   LaTeX Warning: Reference `nolabel' on page 1 undefined on input line 7.
 *   Overfull \hbox (690.0pt too wide) in paragraph at lines 3--4
 *
 * Two details drive the implementation:
 *
 *   - **`Missing character` messages wrap.** The line is truncated at ~79
 *     columns and continues without an indent, so the following line must be
 *     appended before the font name is parsed.
 *   - **Read the FIRST error, not the last.** Everything after the first hard
 *     error is usually cascade, so `errors` is ordered and the renderer says
 *     which one to fix.
 *
 * @module @local/dsh-latex-tool/lib/diagnose
 */

/**
 * `file:line: message` produced by `-file-line-error`.
 *
 * The leading `./` of a relative path belongs to the reported location, so it
 * is captured rather than stripped: reporting `/bad.tex` for a file that TeX
 * called `./bad.tex` loses the fact that it is relative.
 */
const FILE_LINE_ERROR = /^((?:\.{1,2}\/)?[^\r\n:]+?):(\d+):\s*(.*)$/
/** `! message` — the non-file-line form, and the one LaTeX uses for class errors. */
const BANG_ERROR = /^!\s*(.*)$/
/** `Missing character: There is no X (U+NNNN) in font F` */
const MISSING_CHARACTER = /^Missing character: There is no (.+?) \((U\+[0-9A-Fa-f]+|[^)]*)\) in font (.+)$/
/** `LaTeX Warning: Citation 'k' on page N undefined on input line M.` */
const UNDEFINED_CITATION = /LaTeX Warning: Citation '([^']+)' on page \d+ undefined on input line (\d+)/
/** `LaTeX Warning: Reference \`r' on page N undefined on input line M.` */
const UNDEFINED_REFERENCE = /LaTeX Warning: Reference `([^']+)' on page \d+ undefined on input line (\d+)/
/** `Overfull \hbox (Npt too wide) ...` */
const OVERFULL = /^Overfull \\([hv])box \(([\d.]+)pt too (?:wide|high)\)(.*)$/
/** `Package biblatex Warning: Please (re)run Biber on the file: …` */
const RERUN_BIBER = /Please \(re\)run Biber/i
/** `Package biblatex Warning: Please (re)run BibTeX on the file: …` */
const RERUN_BIBTEX = /Please \(re\)run BibTeX/i
/** `LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.` */
const RERUN_LABELS = /Label\(s\) may have changed\. Rerun/i
/** `File `x.sty' not found.` */
const FILE_NOT_FOUND = /File `([^']+)' not found/
/** `Emergency stop` / `Fatal error occurred` */
const FATAL = /Emergency stop|Fatal error occurred|no output PDF file produced/

/** Cap the number of raw warnings kept, to protect the model's context. */
const MAX_WARNINGS = 40
/** Cap the number of overfull boxes kept. */
const MAX_OVERFULL = 30

/**
 * Join continuation lines that TeX wrapped at the console width.
 *
 * A wrapped line continues at column 0 with no marker. Only `Missing character`
 * is rejoined, and only until its `;!` terminator appears — joining every line
 * would destroy the structure the other patterns depend on. Measured example:
 *
 *   Missing character: There is no 𠀀 (U+20000) in font SimSun/OT:script=hani;langua
 *   ge=dflt;!
 *
 * @param lines - the raw log lines.
 * @returns lines with `Missing character` continuations merged.
 */
function joinWrappedLines(lines) {
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]
    if (/^Missing character:/.test(line)) {
      let joined = 0
      while (index + 1 < lines.length && joined < 4 && !/;!$/.test(line)) {
        const next = lines[index + 1]
        // A page marker, a file open/close, or a new record ends the wrap.
        if (!/^\S/.test(next) || /^[[(!]/.test(next)) break
        index += 1
        joined += 1
        line += next
      }
    }
    out.push(line)
  }
  return out
}

/**
 * Parse a LaTeX log.
 *
 * @param logText - the decoded log content.
 * @param options - engine used, and whether the run reached its final pass.
 * @returns the structured findings.
 */
export function parseLog(logText, options = {}) {
  const { engine = '', exitCode = null, stdout = '', stderr = '' } = options
  const raw = typeof logText === 'string' ? logText : ''
  const combined = `${raw}\n${stdout}\n${stderr}`
  const lines = joinWrappedLines(raw.split(/\r?\n/))

  const errors = []
  const missingGlyphs = new Map()
  const missingCitations = []
  const missingReferences = []
  const overfull = []
  const warnings = []
  let sawFatal = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.length === 0) continue

    const missing = line.match(MISSING_CHARACTER)
    if (missing !== null) {
      const char = missing[1].trim()
      const code = missing[2].trim()
      // The font descriptor is followed by XeTeX's `;!` record terminator,
      // which is part of the log format rather than the font name.
      const font = missing[3].trim().replace(/;!$/, '')
      const key = `${code}|${font}`
      const existing = missingGlyphs.get(key)
      if (existing === undefined) missingGlyphs.set(key, { char, code, font, count: 1 })
      else existing.count += 1
      continue
    }

    const citation = line.match(UNDEFINED_CITATION)
    if (citation !== null) {
      missingCitations.push({ key: citation[1], line: Number(citation[2]) })
      continue
    }

    const reference = line.match(UNDEFINED_REFERENCE)
    if (reference !== null) {
      missingReferences.push({ label: reference[1], line: Number(reference[2]) })
      continue
    }

    const over = line.match(OVERFULL)
    if (over !== null && overfull.length < MAX_OVERFULL) {
      const context = over[3].trim()
      const lineRange = context.match(/at lines? (\d+)(?:--(\d+))?/)
      overfull.push({
        kind: over[1] === 'h' ? 'hbox' : 'vbox',
        amountPt: Number(over[2]),
        line: lineRange?.[1] !== undefined ? Number(lineRange[1]) : null,
        endLine: lineRange?.[2] !== undefined ? Number(lineRange[2]) : null,
        context: context.slice(0, 160),
      })
      continue
    }

    const fileLine = line.match(FILE_LINE_ERROR)
    if (fileLine !== null && !/^LaTeX Warning|^Package |^Overfull|^Underfull/.test(line)) {
      const message = collectErrorDetail(lines, index, fileLine[3])
      errors.push({
        file: fileLine[1].trim(),
        line: Number(fileLine[2]),
        message: message.headline,
        detail: message.detail,
        kind: 'file-line',
      })
      continue
    }

    const bang = line.match(BANG_ERROR)
    if (bang !== null) {
      const message = collectErrorDetail(lines, index, bang[1])
      if (FATAL.test(bang[1])) sawFatal = true
      errors.push({
        file: '',
        line: null,
        message: message.headline,
        detail: message.detail,
        kind: 'bang',
      })
      continue
    }

    if (FATAL.test(line)) sawFatal = true

    if (/^(LaTeX|Package|Class) (Warning|Info):/.test(line) && warnings.length < MAX_WARNINGS) {
      // Info lines are not warnings; only keep them when they carry a problem
      // marker, otherwise a biblatex-heavy run floods the list.
      if (/Warning:|Overfull|Underfull|undefined|not found|Error/.test(line)) {
        warnings.push(line.trim().slice(0, 240))
      }
    }
  }

  const notFound = dedupeFiles(combined)
  const rerunBiber = RERUN_BIBER.test(combined)
  const rerunBibtex = RERUN_BIBTEX.test(combined)
  const rerunLabels = RERUN_LABELS.test(combined)

  return {
    errors,
    missingGlyphs: [...missingGlyphs.values()].sort((left, right) => right.count - left.count),
    missingCitations: dedupeByKey(missingCitations, 'key'),
    missingReferences: dedupeByKey(missingReferences, 'label'),
    missingPackages: notFound,
    overfull,
    warnings,
    rerunRequested: { biber: rerunBiber, bibtex: rerunBibtex, labels: rerunLabels },
    backendRan: detectBackendRan(combined, options),
    engineUsed: detectEngineUsed(combined, engine),
    failed: (exitCode !== null && exitCode !== 0) || errors.length > 0 || sawFatal,
    fatal: sawFatal,
  }
}

/**
 * Collect the indented explanation that follows an error headline.
 *
 * @param lines - the log lines.
 * @param index - the index of the headline.
 * @param headline - the headline text.
 * @returns the headline plus up to 8 lines of following context.
 */
function collectErrorDetail(lines, index, headline) {
  const detail = []
  for (let offset = 1; offset <= 8 && index + offset < lines.length; offset += 1) {
    const line = lines[index + offset]
    if (line.length === 0) break
    // A new error, warning, or file open/close ends the explanation.
    if (/^(\.\/|[^ ]*\.tex:\d+:)|^!|^LaTeX Warning|^Package |^Class |^\(|^\)/.test(line)) break
    detail.push(line.trimEnd())
  }
  return { headline: headline.trim(), detail: detail.join('\n').trim() }
}

/**
 * Deduplicate entries by one field, keeping the first line number seen.
 * @param items - the entries.
 * @param field - the field to deduplicate on.
 * @returns unique entries.
 */
function dedupeByKey(items, field) {
  const seen = new Map()
  for (const item of items) {
    const key = String(item[field])
    if (!seen.has(key)) seen.set(key, item)
  }
  return [...seen.values()]
}

/**
 * Extract package files reported missing.
 * @param text - the combined output.
 * @returns unique missing file names.
 */
function dedupeFiles(text) {
  const found = new Set()
  const pattern = new RegExp(FILE_NOT_FOUND.source, 'g')
  let match
  while ((match = pattern.exec(text)) !== null) found.add(match[1])
  return [...found]
}

/**
 * Decide whether the bibliography backend actually ran.
 *
 * The `Please (re)run Biber` warning appears on the first pass of a normal
 * latexmk build, so its mere presence proves nothing. The run itself is proven
 * by latexmk's own rule line (`Running 'biber "x.bcf"'`) or by biber's banner.
 *
 * @param text - the combined output.
 * @param options - reserved.
 * @returns true when a backend run is evidenced.
 */
function detectBackendRan(text, _options = {}) {
  return (
    /Running '(?:biber|bibtex)[^']*'/i.test(text)
    || /Latexmk: applying rule '(?:biber|bibtex)/i.test(text)
    || /INFO - This is Biber [\d.]+/i.test(text)
    || /This is BibTeX, Version/i.test(text)
  )
}

/**
 * Identify the engine that actually ran, from the engine banner.
 *
 * Reported separately from the inferred engine because a mis-set engine is
 * exactly the failure mode worth catching (`xelatex` requested, `pdflatex`
 * banner in the log).
 *
 * @param text - the combined output.
 * @param fallback - the engine the caller requested.
 * @returns the observed engine name.
 */
function detectEngineUsed(text, fallback) {
  if (/^This is XeTeX/m.test(text)) return 'xelatex'
  if (/^This is LuaTeX/m.test(text)) return 'lualatex'
  if (/^This is pdfTeX/m.test(text)) return 'pdflatex'
  return typeof fallback === 'string' ? fallback : ''
}

/**
 * Summarise findings as one line of human-facing advice.
 *
 * @param findings - the parsed log.
 * @returns a short sentence naming the first thing to fix.
 */
export function headline(findings) {
  const first = findings.errors[0]
  if (first !== undefined) {
    const where = first.line === null ? first.file : `${first.file}:${first.line}`
    return `${findings.errors.length} error(s); fix the first: ${where} — ${first.message}`
  }
  if (findings.missingPackages.length > 0) {
    return `Missing package file(s): ${findings.missingPackages.join(', ')}`
  }
  if (findings.missingGlyphs.length > 0) {
    const worst = findings.missingGlyphs[0]
    return `${findings.missingGlyphs.length} glyph(s) missing from the chosen font (e.g. ${worst.char} ${worst.code}); the PDF will show tofu`
  }
  if (findings.missingCitations.length > 0) {
    return `${findings.missingCitations.length} undefined citation key(s): ${findings.missingCitations.map((c) => c.key).join(', ')}`
  }
  if (findings.missingReferences.length > 0) {
    return `${findings.missingReferences.length} undefined reference(s): ${findings.missingReferences.map((r) => r.label).join(', ')}`
  }
  if (findings.failed) return 'the build failed without a parsed error; see the log'
  return 'no errors'
}
