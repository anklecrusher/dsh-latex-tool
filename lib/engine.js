/**
 * Engine inference for a LaTeX project.
 *
 * The official plugin defaults to `pdflatex` and does not read
 * `\documentclass{ctexart}` — which is why it picks the wrong engine for a
 * Chinese thesis. Two things make that worse than a failed build:
 *
 *   - `ctexart` under `pdflatex` *does* compile and *does* render Chinese on
 *     this machine (the class falls back to the `CJK` package with
 *     `ctex-zhmaps-windows` and `simsun.ttc`), so a green exit code proves
 *     nothing.
 *   - Characters without a mapping are dropped silently, with only a
 *     `Missing character` line in the log.
 *
 * The inference order below is therefore deliberate, and `ctex*` is caught at
 * step 4 rather than left to the default. The decision is always reported with
 * the evidence that produced it, so a wrong guess is diagnosable from the tool
 * result instead of requiring a reread of the source.
 *
 * @module @local/dsh-latex-tool/lib/engine
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isFile } from './paths.js'

/** Engines this plugin can drive. */
export const ENGINES = ['pdflatex', 'xelatex', 'lualatex']

/** `% !TEX program = xelatex` — the TeXworks / VS Code magic comment. */
const MAGIC_PROGRAM = /^\s*%\s*!TEX\s+program\s*=\s*(\S+)/im
/** `% !TEX root = ../main.tex` — the document root for a chapter file. */
const MAGIC_ROOT = /^\s*%\s*!TEX\s+root\s*=\s*(\S+)/im
/** `\documentclass[opts]{klass}` — options may contain braces (e.g. `{}`), rare. */
const DOCUMENT_CLASS = /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{\s*([^}\s]+)\s*\}/
/** `\usepackage[opts]{a,b,c}` */
const USE_PACKAGE = /\\usepackage\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g

/** Classes that mean "Chinese document, use XeLaTeX". */
const CTEX_CLASSES = new Set(['ctexart', 'ctexrep', 'ctexbook', 'ctexbeamer', 'ctexart-zh', 'ctex'])

/** Packages that require XeLaTeX or LuaLaTeX, and cannot work under pdflatex. */
const XETEX_PACKAGES = new Set([
  'fontspec',
  'xeCJK',
  'polyglossia',
  'unicode-math',
  'ctex',
  'xeCJKfntef',
  'ucharclasses',
])

/** Packages that force LuaLaTeX. */
const LUATEX_PACKAGES = new Set(['luacode', 'luatexbase', 'luaotfload'])

/** Macros in the preamble that only make sense under XeLaTeX. */
const XETEX_MACROS = [
  /\\setCJKmainfont/,
  /\\setCJKsansfont/,
  /\\setCJKmonofont/,
  /\\setmainfont/,
  /\\setsansfont/,
  /\\setmonofont/,
  /\\newfontfamily/,
  /\\setmathfont/,
]
/** Macros that only make sense under LuaLaTeX. */
const LUATEX_MACROS = [/\\directlua/, /\\luadirect/]

/**
 * Read at most `limit` bytes of a UTF-8 file.
 *
 * Engine signals live in the preamble, which is small; reading the whole of a
 * 2 MB chapter file to find it would be wasteful and can fail on a file that is
 * not valid UTF-8.
 *
 * @param file - the absolute path.
 * @param limit - byte cap.
 * @returns the decoded text, or an empty string when unreadable.
 */
function readHead(file, limit = 64 * 1024) {
  try {
    const buffer = readFileSync(file)
    return buffer.subarray(0, Math.min(buffer.length, limit)).toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Resolve the actual root document from a `% !TEX root` magic comment.
 *
 * @param texFile - the absolute path of the file the caller asked about.
 * @param head - the file's decoded head.
 * @param depth - recursion guard.
 * @returns the root path plus the chain walked to reach it.
 */
function resolveMagicRoot(texFile, head, depth = 0) {
  if (depth > 4) return { root: texFile, chain: [texFile] }
  const match = head.match(MAGIC_ROOT)
  if (match?.[1] === undefined) return { root: texFile, chain: [texFile] }
  const candidate = resolve(dirname(texFile), match[1].trim())
  if (!isFile(candidate)) return { root: texFile, chain: [texFile] }
  const candidateHead = readHead(candidate)
  const parent = resolveMagicRoot(candidate, candidateHead, depth + 1)
  return { root: parent.root, chain: [texFile, ...parent.chain] }
}

/**
 * Collect the preamble signals from one file.
 *
 * @param text - the file's decoded text.
 * @returns the class name, the packages used, and which macros appear.
 */
function scanSignals(text) {
  const classMatch = text.match(DOCUMENT_CLASS)
  const packages = []
  USE_PACKAGE.lastIndex = 0
  let packageMatch
  while ((packageMatch = USE_PACKAGE.exec(text)) !== null) {
    for (const raw of packageMatch[1].split(',')) {
      const name = raw.trim()
      if (name.length > 0) packages.push(name)
    }
  }
  const macros = {
    xetex: XETEX_MACROS.some((pattern) => pattern.test(text)),
    luatex: LUATEX_MACROS.some((pattern) => pattern.test(text)),
  }
  return {
    documentClass: classMatch?.[1]?.trim() ?? '',
    packages,
    macros,
  }
}

/**
 * Read `$pdf_mode` out of a latexmkrc, for the respectLatexmkrc path.
 *
 * `$pdf_mode = 1` → pdflatex, `4` → lualatex, `5` → xelatex. Any other value
 * is left to latexmk itself.
 *
 * @param projectDir - the project directory.
 * @returns the engine the project's own configuration asks for, or ''.
 */
export function engineFromLatexmkrc(projectDir) {
  for (const name of ['latexmkrc', '.latexmkrc', 'LatexMkrc']) {
    const file = join(projectDir, name)
    if (!isFile(file)) continue
    const text = readHead(file, 32 * 1024)
    const match = text.match(/\$pdf_mode\s*=\s*(\d+)/)
    if (match?.[1] === undefined) continue
    switch (match[1]) {
      case '1':
        return { engine: 'pdflatex', file }
      case '4':
        return { engine: 'lualatex', file }
      case '5':
        return { engine: 'xelatex', file }
      default:
        return { engine: '', file }
    }
  }
  return { engine: '', file: '' }
}

/**
 * Infer the engine for a project.
 *
 * Priority, highest first, each step reported with its evidence:
 *   1. an explicit `engine` argument;
 *   2. `% !TEX program = …` in the file, or in its `% !TEX root` target;
 *   3. the project's latexmkrc `$pdf_mode`, only when the caller asked to
 *      respect it (the plugin runs `-norc` by default for safety);
 *   4. a `ctex*` document class;
 *   5. a package that requires XeLaTeX / LuaLaTeX;
 *   6. a macro that only exists under XeLaTeX / LuaLaTeX;
 *   7. `pdflatex`.
 *
 * @param texFile - the absolute path of the requested .tex file.
 * @param options - explicit engine and whether latexmkrc may be consulted.
 * @returns the engine plus the full decision trail.
 */
export function inferEngine(texFile, options = {}) {
  const { explicit = '', respectLatexmkrc = false, projectDir = dirname(texFile) } = options
  const trail = []

  const record = (engine, source, detail) => {
    trail.push({ source, engine, detail })
    return { engine, source, detail, trail }
  }

  if (typeof explicit === 'string' && explicit.length > 0) {
    if (!ENGINES.includes(explicit)) {
      return {
        engine: 'pdflatex',
        source: 'explicit',
        detail: `engine "${explicit}" is not one of ${ENGINES.join(', ')}; falling back to pdflatex.`,
        trail,
        invalid: true,
      }
    }
    return record(explicit, 'explicit', `caller requested ${explicit}`)
  }

  const head = readHead(texFile)
  if (head.length === 0) {
    return record('pdflatex', 'default', 'the requested file could not be read; defaulting to pdflatex')
  }

  const { root, chain } = resolveMagicRoot(texFile, head)
  const rootHead = root === texFile ? head : readHead(root)
  if (root !== texFile) trail.push({ source: 'magic-root', engine: '', detail: `% !TEX root → ${root}` })

  const magicRoot = rootHead.match(MAGIC_PROGRAM)
  if (magicRoot?.[1] !== undefined) {
    const requested = magicRoot[1].trim().replace(/\.exe$/i, '').replace(/^(lua|xe|pdf)tex$/i, (m) => m.toLowerCase())
    const normalised = normaliseEngineName(requested)
    if (normalised !== '') {
      return record(normalised, 'magic-program', `% !TEX program = ${magicRoot[1].trim()}`)
    }
    trail.push({ source: 'magic-program', engine: '', detail: `% !TEX program = ${magicRoot[1].trim()} is not a supported engine` })
  }

  if (respectLatexmkrc) {
    const fromRc = engineFromLatexmkrc(projectDir)
    if (fromRc.engine !== '') {
      return record(fromRc.engine, 'latexmkrc', `$pdf_mode in ${fromRc.file}`)
    }
  }

  // The class of the ROOT file decides; a chapter file has no preamble.
  const rootSignals = scanSignals(rootHead)
  const fileSignals = root === texFile ? rootSignals : scanSignals(head)
  const documentClass = rootSignals.documentClass !== '' ? rootSignals.documentClass : fileSignals.documentClass

  if (documentClass.length > 0) {
    const base = documentClass.split('/').pop()?.replace(/\.cls$/i, '') ?? documentClass
    if (CTEX_CLASSES.has(base.toLowerCase())) {
      return record('xelatex', 'documentclass', `\\documentclass{${documentClass}} is a ctex class; pdflatex would silently drop unmapped characters`)
    }
  }

  const packages = [...new Set([...rootSignals.packages, ...fileSignals.packages])]
  const luaPackage = packages.find((name) => LUATEX_PACKAGES.has(name))
  if (luaPackage !== undefined) {
    return record('lualatex', 'package', `\\usepackage{${luaPackage}}`)
  }
  const xePackage = packages.find((name) => XETEX_PACKAGES.has(name))
  if (xePackage !== undefined) {
    return record('xelatex', 'package', `\\usepackage{${xePackage}} needs XeLaTeX or LuaLaTeX, and pdflatex cannot load it`)
  }

  if (rootSignals.macros.luatex || fileSignals.macros.luatex) {
    return record('lualatex', 'macro', '\\directlua is present')
  }
  if (rootSignals.macros.xetex || fileSignals.macros.xetex) {
    return record('xelatex', 'macro', 'a CJK/OpenType font macro (\\setCJKmainfont / \\setmainfont / …) is present')
  }

  const detail =
    documentClass.length > 0
      ? `\\documentclass{${documentClass}} with no CJK or fontspec signal`
      : 'no document class or engine signal was found'
  return record('pdflatex', 'default', `${detail}; pdflatex is the safe default for plain Latin documents`)
}

/**
 * Map a magic-comment program name onto a supported engine.
 *
 * @param value - the raw value, e.g. `xelatex`, `XeLaTeX`, `pdftex`.
 * @returns the engine name, or an empty string when unsupported.
 */
function normaliseEngineName(value) {
  const lower = value.toLowerCase()
  if (lower === 'xelatex' || lower === 'xetex') return 'xelatex'
  if (lower === 'lualatex' || lower === 'luatex') return 'lualatex'
  if (lower === 'pdflatex' || lower === 'pdftex' || lower === 'latex') return 'pdflatex'
  return ''
}

/**
 * The latexmk flag that selects an engine.
 *
 * The flag is mandatory, not cosmetic: measured on this machine, `latexmk`
 * with no engine flag on a `ctexart` project builds **DVI, not PDF**, and
 * exits 0. A missing PDF after a green build is almost always this.
 *
 * @param engine - one of {@link ENGINES}.
 * @returns the argv flag.
 */
export function engineFlag(engine) {
  switch (engine) {
    case 'xelatex':
      return '-xelatex'
    case 'lualatex':
      return '-lualatex'
    default:
      return '-pdf'
  }
}

/**
 * Report which bibliography backend the source asks for.
 *
 * `\bibliography{…}` + `\bibliographystyle{…}` ⇒ bibtex;
 * `\addbibresource{…}` + `\printbibliography` ⇒ biber, unless biblatex is
 * loaded with `backend=bibtex`.
 *
 * @param texText - the root file's text.
 * @returns the backend name and the evidence.
 */
export function inferBibliographyBackend(texText) {
  const text = typeof texText === 'string' ? texText : ''
  const biblatex = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{[^}]*biblatex[^}]*\}/.exec(text)
  if (biblatex !== null) {
    const options = biblatex[1] ?? ''
    if (/backend\s*=\s*bibtex/i.test(options)) return { backend: 'bibtex', detail: 'biblatex with backend=bibtex' }
    if (/\\addbibresource/.test(text)) return { backend: 'biber', detail: 'biblatex + \\addbibresource' }
    return { backend: 'biber', detail: 'biblatex is loaded; biber is its default backend' }
  }
  if (/\\bibliography\s*\{/.test(text)) return { backend: 'bibtex', detail: '\\bibliography + \\bibliographystyle' }
  return { backend: '', detail: 'no bibliography backend signal' }
}
