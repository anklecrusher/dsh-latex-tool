/**
 * TeX installation discovery.
 *
 * What this has to get right, and why each rule exists:
 *
 * 1. **Do not trust PATH membership.** This machine's Machine PATH still
 *    contains `D:\texlive\2024\bin\windows`, a directory that has been deleted.
 *    A string test on PATH therefore reports a working TeX Live that is not
 *    there. Every candidate is verified with `stat`, and reported with the
 *    evidence used to accept it.
 *
 * 2. **`kpsewhich -var-value=TEXMFROOT` is the authoritative answer** when a
 *    kpsewhich is already reachable, because it reflects the *active* tree
 *    rather than a guess.
 *
 * 3. **Version lines are found by pattern, not position.** TeX Live's
 *    `latexmk` is a Perl wrapper: `latexmk -v` writes
 *    `perl: warning: Setting locale failed ...` to stderr before the version
 *    line on stdout. Taking the first non-empty line — the official plugin's
 *    F4 — reports the Perl warning as the version. The pattern
 *    `/Latexmk.*?Version\s+([\d.]+)/` is what actually identifies it.
 *
 * 4. **Python is resolved to a real executable before it is spawned.** Node
 *    cannot spawn a `.cmd` shim on Windows (`EINVAL`), and this machine's
 *    `python3` on PATH is exactly such a shim. The resolver reads the shim when
 *    it is one, and probes well-known absolute locations otherwise.
 *
 * @module @local/dsh-latex-tool/lib/detect
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { isDirectory, isFile, longPath } from './paths.js'
import { PROBE_TIMEOUT_MS, runProcess } from './run.js'

/** Environment variables that locate a TeX installation. */
const TEX_ENV_VARS = ['TEXMFROOT', 'TEXLIVE_ROOT', 'TEXLIVE_WINDOWS_ROOT', 'MIKTEX_ROOT']

/** Packages whose presence decides whether Chinese thesis work is possible. */
const PACKAGE_PROBES = [
  { name: 'ctex', file: 'ctexart.cls', why: 'Chinese classes: ctexart / ctexrep / ctexbook' },
  { name: 'xeCJK', file: 'xeCJK.sty', why: 'CJK font handling under XeLaTeX' },
  { name: 'fontspec', file: 'fontspec.sty', why: 'OpenType font selection; forces XeLaTeX/LuaLaTeX' },
  { name: 'biblatex', file: 'biblatex.sty', why: 'Bibliography engine' },
  { name: 'biblatex-gb7714-2015', file: 'gb7714-2015.bbx', why: 'GB/T 7714 citation style for Chinese theses' },
  { name: 'geometry', file: 'geometry.sty', why: 'Page layout' },
  { name: 'booktabs', file: 'booktabs.sty', why: 'Rules in tables' },
  { name: 'graphicx', file: 'graphicx.sty', why: 'Figures' },
]

/** Engines this plugin can drive, in the order a doctor reports them. */
const ENGINE_PROBES = [
  { name: 'xelatex', why: 'Chinese / fontspec projects' },
  { name: 'pdflatex', why: 'Plain Latin projects' },
  { name: 'lualatex', why: 'Lua projects' },
]

/**
 * Candidate TeX bin directories to probe when nothing authoritative is known.
 *
 * @returns absolute candidate directories, most specific first.
 */
function candidateTexRoots() {
  const out = []
  const env = process.env
  for (const key of TEX_ENV_VARS) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) out.push({ dir: value, source: `env:${key}` })
  }

  // Known TeX Live layouts. The 2026 tree on this machine lives under a
  // "Program Files (x86)" path, which is why the version glob is enumerated
  // rather than assumed.
  const roots = []
  if (env.ProgramFiles) roots.push(join(env.ProgramFiles, 'texlive'), 'C:\\texlive', 'D:\\texlive', 'E:\\texlive')
  if (env['ProgramFiles(x86)']) roots.push(join(env['ProgramFiles(x86)'], 'texlive'))
  roots.push('D:\\Program Files (x86)\\texlive', 'C:\\Program Files (x86)\\texlive')

  for (const root of roots) {
    for (const year of yearCandidates()) {
      out.push({ dir: join(root, year, 'bin', 'windows'), source: 'probe' })
      out.push({ dir: join(root, year, 'bin', 'win32'), source: 'probe' })
      out.push({ dir: join(root, year, 'bin', 'x86_64-linux'), source: 'probe' })
    }
    out.push({ dir: join(root, 'bin', 'windows'), source: 'probe' })
  }

  // MiKTeX.
  if (env.LOCALAPPDATA) out.push({ dir: join(env.LOCALAPPDATA, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'), source: 'probe' })
  if (env.ProgramFiles) out.push({ dir: join(env.ProgramFiles, 'MiKTeX', 'miktex', 'bin', 'x64'), source: 'probe' })

  // macOS / Linux layouts, so the plugin is not silently Windows-only.
  out.push({ dir: '/Library/TeX/texbin', source: 'probe' })
  out.push({ dir: '/usr/local/texlive/current/bin/x86_64-linux', source: 'probe' })

  // PATH, but every entry is verified to exist before it is accepted.
  for (const entry of (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (entry.length > 0) out.push({ dir: entry, source: 'PATH' })
  }
  return out
}

/**
 * Year directories worth trying when enumerating TeX Live trees.
 *
 * The set is small and bounded on purpose: probing a directory listing for
 * every possible year costs a stat per entry, and a TeX Live tree is named
 * after its release year.
 *
 * @returns year strings, newest first.
 */
function yearCandidates() {
  const out = []
  const current = new Date().getFullYear()
  for (let year = current + 1; year >= current - 4; year -= 1) out.push(String(year))
  return out
}

/**
 * Verify that a directory really holds a TeX toolchain.
 *
 * @param dir - the candidate bin directory.
 * @returns the directory and whether latexmk/engines are present.
 */
function inspectTexBin(dir) {
  const resolved = longPath(dir)
  if (!isDirectory(resolved)) return null
  const hasLatexmk = isFile(join(resolved, exeName('latexmk')))
  const engines = ENGINE_PROBES.filter((engine) => isFile(join(resolved, exeName(engine.name)))).map((engine) => engine.name)
  if (!hasLatexmk && engines.length === 0) return null
  return { dir: resolved, hasLatexmk, engines }
}

/**
 * Render an executable name for the current platform.
 * @param name - the bare name, e.g. `latexmk`.
 * @returns the platform-specific file name.
 */
export function exeName(name) {
  return process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name
}

/**
 * Find the TeX bin directory.
 *
 * @param options - optional configured bin directory, cwd for PATH-based kpsewhich.
 * @returns the resolved bin directory, root, and how it was found.
 */
export async function detectTexBin(options = {}) {
  const { configuredTexBin = '', signal = undefined } = options

  if (typeof configuredTexBin === 'string' && configuredTexBin.length > 0) {
    const inspected = inspectTexBin(configuredTexBin)
    if (inspected !== null) {
      return { ...inspected, source: 'config.texBin', texmfRoot: await texmfRoot(inspected.dir, signal) }
    }
    return {
      dir: '',
      source: 'config.texBin',
      hasLatexmk: false,
      engines: [],
      texmfRoot: '',
      error: `config.texBin points at "${configuredTexBin}", which does not hold latexmk or an engine.`,
    }
  }

  // Authoritative path first: a kpsewhich already on PATH knows the active tree.
  const viaPath = await kpsewhichRoot(signal)
  if (viaPath.dir.length > 0) {
    const inspected = inspectTexBin(viaPath.dir)
    if (inspected !== null) {
      return { ...inspected, source: viaPath.source, texmfRoot: viaPath.texmfRoot }
    }
  }

  for (const candidate of candidateTexRoots()) {
    const inspected = inspectTexBin(candidate.dir)
    if (inspected !== null) {
      return { ...inspected, source: candidate.source, texmfRoot: await texmfRoot(inspected.dir, signal) }
    }
  }

  return { dir: '', source: 'none', hasLatexmk: false, engines: [], texmfRoot: '' }
}

/**
 * Ask a PATH-reachable `kpsewhich` for TEXMFROOT and derive the bin directory.
 *
 * @param signal - optional abort signal.
 * @returns the bin directory, the TeX MF root, and the source label.
 */
async function kpsewhichRoot(signal) {
  try {
    const result = await runProcess({
      executable: exeName('kpsewhich'),
      argv: ['-var-value=TEXMFROOT'],
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
    })
    const root = result.stdout.trim().split(/\r?\n/).pop() ?? ''
    if (result.exitCode !== 0 || root.length === 0) return { dir: '', texmfRoot: '', source: 'kpsewhich' }
    const binDir = join(root, 'bin', process.platform === 'win32' ? 'windows' : 'x86_64-linux')
    return { dir: binDir, texmfRoot: root, source: 'kpsewhich' }
  } catch {
    return { dir: '', texmfRoot: '', source: 'kpsewhich' }
  }
}

/**
 * Read TEXMFROOT from a specific kpsewhich, when one exists in the bin dir.
 * @param binDir - the TeX bin directory.
 * @param signal - optional abort signal.
 * @returns the TeX MF root, or an empty string.
 */
async function texmfRoot(binDir, signal) {
  const kpsewhich = join(binDir, exeName('kpsewhich'))
  if (!isFile(kpsewhich)) return ''
  try {
    const result = await runProcess({ executable: kpsewhich, argv: ['-var-value=TEXMFROOT'], timeoutMs: PROBE_TIMEOUT_MS, signal })
    if (result.exitCode !== 0) return ''
    return result.stdout.trim().split(/\r?\n/).pop() ?? ''
  } catch {
    return ''
  }
}

/**
 * Read the latexmk version, skipping the Perl locale warning.
 *
 * @param binDir - the TeX bin directory.
 * @param signal - optional abort signal.
 * @returns the version string, or an empty string.
 */
export async function detectLatexmk(binDir, signal) {
  const executable = join(binDir, exeName('latexmk'))
  if (!isFile(executable)) return { version: '', executable, detail: 'latexmk is not present in the TeX bin directory.' }
  try {
    const result = await runProcess({ executable, argv: ['-v'], timeoutMs: PROBE_TIMEOUT_MS, signal })
    const text = `${result.stdout}\n${result.stderr}`
    const match = text.match(/Latexmk[^\r\n]*?Version\s+([\d.]+)/i)
    return {
      version: match?.[1] ?? '',
      executable,
      detail: match?.[0] ?? text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '',
    }
  } catch (error) {
    return { version: '', executable, detail: `latexmk -v failed: ${error.message}` }
  }
}

/**
 * Read the version of each engine present in the bin directory.
 *
 * @param binDir - the TeX bin directory.
 * @param signal - optional abort signal.
 * @returns one entry per engine.
 */
export async function detectEngines(binDir, signal) {
  const out = []
  for (const engine of ENGINE_PROBES) {
    const executable = join(binDir, exeName(engine.name))
    if (!isFile(executable)) {
      out.push({ name: engine.name, version: '', present: false, executable, why: engine.why })
      continue
    }
    try {
      const result = await runProcess({ executable, argv: ['--version'], timeoutMs: PROBE_TIMEOUT_MS, signal })
      const line = result.stdout.split(/\r?\n/).find((value) => value.trim().length > 0)?.trim() ?? ''
      out.push({ name: engine.name, version: line, present: true, executable, why: engine.why })
    } catch (error) {
      out.push({ name: engine.name, version: '', present: true, executable, why: engine.why, error: error.message })
    }
  }
  return out
}

/**
 * Ask kpsewhich where each package file lives.
 *
 * @param binDir - the TeX bin directory.
 * @param signal - optional abort signal.
 * @returns one entry per probed package.
 */
export async function detectPackages(binDir, signal) {
  const kpsewhich = join(binDir, exeName('kpsewhich'))
  const out = []
  for (const probe of PACKAGE_PROBES) {
    if (!isFile(kpsewhich)) {
      out.push({ name: probe.name, file: probe.file, found: false, path: '', why: probe.why })
      continue
    }
    try {
      const result = await runProcess({ executable: kpsewhich, argv: [probe.file], timeoutMs: PROBE_TIMEOUT_MS, signal })
      const found = result.exitCode === 0 && result.stdout.trim().length > 0
      out.push({ name: probe.name, file: probe.file, found, path: found ? result.stdout.trim().split(/\r?\n/)[0] : '', why: probe.why })
    } catch {
      out.push({ name: probe.name, file: probe.file, found: false, path: '', why: probe.why })
    }
  }
  return out
}

/**
 * Report the bibliography backends available next to the engines.
 *
 * @param binDir - the TeX bin directory.
 * @returns which backend executables exist.
 */
export function detectBackends(binDir) {
  return ['biber', 'bibtex', 'pdftotext'].map((name) => ({
    name,
    found: name === 'pdftotext' ? false : isFile(join(binDir, exeName(name))),
  }))
}

/** Python interpreters to probe, in priority order, when none is configured. */
function candidatePythons() {
  const env = process.env
  const out = []
  if (env.DSH_PYTHON && isFile(env.DSH_PYTHON)) out.push({ path: env.DSH_PYTHON, source: 'env:DSH_PYTHON' })
  // This machine's real Python 3.13, which is not in a standard directory but
  // is where the user's `python3` shim points.
  out.push({ path: 'D:\\Program Files\\python.exe', source: 'probe' })
  if (env.LOCALAPPDATA) out.push({ path: join(env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'), source: 'probe' })
  if (env.ProgramFiles) out.push({ path: join(env.ProgramFiles, 'Python313', 'python.exe'), source: 'probe' })
  out.push({ path: 'C:\\Python313\\python.exe', source: 'probe' })
  // Node cannot spawn a `.cmd` shim (EINVAL on Windows), so a shim is read and
  // the real interpreter it launches is used instead.
  for (const shim of ['python3.cmd', 'python.cmd']) {
    const fromShim = pythonFromShim(shim)
    if (fromShim !== '') out.push({ path: fromShim, source: `shim:${shim}` })
  }
  // A bare name works only for a real .exe; the spawn below reports ENOENT
  // cleanly for a missing `python.exe` on PATH.
  out.push({ path: 'python.exe', source: 'PATH' })
  out.push({ path: 'python3', source: 'PATH' })
  return out
}

/**
 * Read a `.cmd`/`.bat` shim and extract the interpreter it runs.
 *
 * @param shimName - the shim file name, looked up in the user's local bin.
 * @returns the interpreter path, or an empty string.
 */
function pythonFromShim(shimName) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (home.length === 0) return ''
  const shim = join(home, '.local', 'bin', shimName)
  if (!isFile(shim)) return ''
  try {
    const text = readFileSync(shim, 'utf8')
    const match = text.match(/"([A-Za-z]:\\[^"]*python[^"]*\.exe)"/i)
    if (match?.[1] !== undefined && isFile(match[1])) return match[1]
  } catch {
    /* unreadable shim: fall through to the next candidate */
  }
  return ''
}

/**
 * Find a Python interpreter and report whether it has PyMuPDF.
 *
 * A Python without PyMuPDF is not a failure: PDF verification degrades to
 * `pdftotext`, and then to a structural check. Saying which tier answered is
 * the whole point — the plugin must not pretend a weaker check is a full one.
 *
 * @param options - optional configured interpreter path and abort signal.
 * @returns the interpreter, its version, and whether `import fitz` works.
 */
export async function detectPython(options = {}) {
  const { configuredPath = '', signal = undefined, testImport = true } = options

  const candidates = []
  if (typeof configuredPath === 'string' && configuredPath.length > 0) {
    candidates.push({ path: configuredPath, source: 'config.pythonPath' })
  }
  candidates.push(...candidatePythons())

  const seen = new Set()
  for (const candidate of candidates) {
    const key = candidate.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (candidate.source !== 'PATH' && !isFile(candidate.path)) continue

    try {
      const probe = await runProcess({
        executable: candidate.path,
        argv: ['-c', 'import sys; print(sys.version.split()[0]); print(sys.executable)'],
        timeoutMs: PROBE_TIMEOUT_MS,
        signal,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      if (probe.exitCode !== 0) continue
      const lines = probe.stdout.trim().split(/\r?\n/)
      const version = lines[0]?.trim() ?? ''
      const executable = lines[1]?.trim() ?? candidate.path
      let hasPyMuPDF = false
      if (testImport) {
        const importProbe = await runProcess({
          executable: candidate.path,
          argv: ['-c', 'import fitz'],
          timeoutMs: PROBE_TIMEOUT_MS,
          signal,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        })
        hasPyMuPDF = importProbe.exitCode === 0
      }
      return { executable, invocation: candidate.path, version, hasPyMuPDF, source: candidate.source }
    } catch {
      continue
    }
  }

  return {
    executable: '',
    invocation: '',
    version: '',
    hasPyMuPDF: false,
    source: 'none',
    error:
      'No working Python interpreter was found. Configure pythonPath in the bundle patch to enable the full-fidelity PDF check; '
      + 'verification degrades to pdftotext, then to a structure-only check.',
  }
}

/**
 * Locate `pdftotext`, the fallback PDF text extractor.
 *
 * It is not part of TeX Live; on this machine it ships with the Scoop Git for
 * Windows installation under `ucrt64\bin`. A plain PATH search therefore finds
 * it, but the Windows form of the path must be reported — a POSIX `/ucrt64/...`
 * path is not spawnable.
 *
 * @returns the executable path, or an empty string when absent.
 */
export function detectPdftotext() {
  const env = process.env
  const candidates = []
  const home = env.USERPROFILE ?? env.HOME ?? ''
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'ucrt64', 'bin', 'pdftotext.exe'))
  if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, 'Git', 'ucrt64', 'bin', 'pdftotext.exe'))
  if (home.length > 0) {
    candidates.push(join(home, 'scoop', 'apps', 'git', 'current', 'ucrt64', 'bin', 'pdftotext.exe'))
    candidates.push(join(home, 'scoop', 'shims', 'pdftotext.exe'))
  }
  for (const entry of (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (entry.length === 0) continue
    candidates.push(join(entry, process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext'))
  }
  for (const candidate of candidates) {
    if (isFile(candidate)) return { executable: longPath(candidate), source: candidate.includes('PATH') ? 'PATH' : 'probe' }
  }
  return { executable: '', source: 'none' }
}

