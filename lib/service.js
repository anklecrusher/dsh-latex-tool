/**
 * LaTeX service: one place that runs the toolchain and shapes the answers.
 *
 * Both the agent tools and the Web settings panel read through this module, so
 * a compile triggered from the panel and one triggered by the model go through
 * exactly the same path, engine inference and decoding. Keeping the process
 * handling here also keeps the `-norc` policy, the deadline and the output
 * directory choice in one auditable place instead of duplicated per caller.
 *
 * Configuration is resolved lazily on every call, not cached at activation: a
 * setting changed from the panel must take effect on the next compile, not on
 * the next harness restart. That is why `settings()` re-reads the state file.
 *
 * @module @local/dsh-latex-tool/lib/service
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { compileProject, resolveTexFile } from './compile.js'
import { readState, resolveSettings, stateFilePath, writeState } from './config.js'
import { diagnose } from './doctor.js'
import { detectTexBin, exeName } from './detect.js'
import { isFile, longPath } from './paths.js'
import { verifyPdf, resolvePdf } from './verify.js'

/** How many compile records the history keeps. */
const MAX_HISTORY = 20

/**
 * Build the service bound to one plugin configuration.
 *
 * @param config - validated patch-layer configuration.
 * @param logger - optional Cordis logger for diagnostics.
 * @returns the service consumed by tools and the panel route.
 */
export function createService(config, logger) {
  const patch = config ?? {}
  /** Resolved TeX bin directory, cached only for the process's lifetime. */
  let texCache = { bin: '', root: '', source: '', at: 0 }
  /** Recent compiles, newest first. */
  const history = []

  /**
   * Re-read the effective settings.
   *
   * The patch layer wins over the panel state file; `sources` says which layer
   * each value came from so the panel can explain a value that ignores its
   * toggle.
   *
   * @returns the settings plus their provenance.
   */
  function settings() {
    return resolveSettings(patch, readState(stateFilePath()))
  }

  /**
   * Find the TeX bin directory, reusing a recent answer.
   *
   * A discovery costs several `stat` calls plus one `latexmk -v`, so it is
   * cached for the life of the process. An install that changes mid-session is
   * not a case worth paying for on every compile.
   *
   * @param signal - optional abort signal.
   * @returns the resolved bin directory and its provenance.
   */
  async function texBin(signal) {
    const configured = typeof patch.texBin === 'string' ? patch.texBin : ''
    if (configured.length > 0) return { dir: longPath(configured), root: '', source: 'config.texBin' }
    if (texCache.bin.length > 0) return texCache
    const found = await detectTexBin({ signal })
    texCache = { bin: found.dir, root: found.texmfRoot ?? '', source: found.source, at: Date.now() }
    return texCache
  }

  /**
   * Remember one compile, for the panel's recent-builds card.
   *
   * @param record - the compile result summary.
   */
  function record(record) {
    history.unshift(record)
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY
  }

  return {
    /** Effective settings and their provenance. */
    settings,
    /** Recent compile summaries, newest first. */
    history: () => [...history],
    /** Where the panel's state file lives. */
    stateFile: () => stateFilePath(),
    /** The patch-layer configuration, for diagnostics. */
    config: patch,

    /**
     * Compile one project.
     *
     * @param request - file, engine override, output mode, deadline, cwd, signal.
     * @returns the compile result.
     */
    async compile(request) {
      const { file, engine = '', outDir = 'project', timeoutMs, cwd = '', signal = undefined } = request
      const resolved = resolveTexFile(file, cwd || process.cwd())
      const effective = settings()
      const tex = await texBin(signal)
      const result = await compileProject({
        texFile: resolved.file,
        cwd: dirname(resolved.file),
        texBin: tex.dir,
        settings: { ...effective.settings, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : effective.settings.timeoutMs },
        explicitEngine: typeof engine === 'string' ? engine : '',
        outDirMode: outDir === 'temp' ? 'temp' : 'project',
        signal,
        logger,
      })
      record({
        at: new Date().toISOString(),
        tex: result.texFile,
        name: basename(result.texFile),
        engine: result.engine,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ok: result.ok,
        pdfPath: result.pdfPath,
        errors: result.findings.errors.length,
        missingGlyphs: result.findings.missingGlyphs.length,
      })
      return result
    },

    /**
     * Verify one PDF.
     *
     * The settings are read per call so a `pythonPath` change from the panel is
     * honoured without a restart.
     *
     * @param request - pdf, pages, render, dpi, expectCjk, pngDir, cwd, signal.
     * @returns the verification result.
     */
    async verify(request) {
      const { pdf, cwd = '', signal = undefined, dpi } = request
      const resolved = resolvePdf(pdf, cwd || process.cwd())
      const effective = settings()
      if (resolved === '') {
        return {
          capability: 'minimal',
          capabilityDetail: '',
          verifyTool: 'structure',
          pdf: typeof pdf === 'string' ? pdf : '',
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
          durationMs: 0,
          warnings: [],
          error: `The PDF "${String(pdf)}" does not exist. Compile the project first, or pass the path the compile reported.`,
        }
      }
      return verifyPdf({
        pdfPath: resolved,
        pages: request.pages ?? '1-3',
        render: request.render === true,
        dpi: Number.isInteger(dpi) ? dpi : effective.settings.renderDpi,
        expectCjk: request.expectCjk !== false,
        pngDir: request.pngDir ?? '',
        pythonPath: typeof patch.pythonPath === 'string' ? patch.pythonPath : '',
        signal,
        logger,
      })
    },

    /**
     * Run the environment check.
     *
     * @param request - whether to run the smoke test, and an abort signal.
     * @returns the doctor report.
     */
    async doctor(request = {}) {
      const effective = settings()
      return diagnose({
        texBin: typeof patch.texBin === 'string' ? patch.texBin : '',
        pythonPath: typeof patch.pythonPath === 'string' ? patch.pythonPath : '',
        smoke: request.smoke === true,
        signal: request.signal,
        logger,
        timeoutMs: effective.settings.timeoutMs,
      })
    },

    /**
     * Build the settings payload the panel renders.
     *
     * @returns the effective values, their provenance, and the fixed paths.
     */
    async settingsPayload() {
      const effective = settings()
      const tex = await texBin(undefined)
      return {
        defaultEngine: effective.settings.defaultEngine,
        respectLatexmkrc: effective.settings.respectLatexmkrc,
        timeoutMs: effective.settings.timeoutMs,
        renderDpi: effective.settings.renderDpi,
        norc: effective.settings.respectLatexmkrc !== true,
        texBin: tex.dir ?? '',
        pythonPath: typeof patch.pythonPath === 'string' ? patch.pythonPath : '',
        stateFile: stateFilePath(),
        sources: effective.sources,
      }
    },

    /**
     * Apply a panel change.
     *
     * Fields the patch layer pins are not written to the state file: the patch
     * is the reviewed deployment decision, and silently shadowing it would make
     * the git diff a lie. The payload reports which fields were pinned so the
     * panel can say so instead of appearing broken.
     *
     * @param updates - the fields to change.
     * @returns the new settings payload and which updates were ignored.
     */
    async updateSettings(updates) {
      const effective = settings()
      const writable = {}
      const pinned = []
      if (updates.defaultEngine !== undefined) {
        if (effective.sources.defaultEngine === 'patch') pinned.push('defaultEngine')
        else writable.defaultEngine = updates.defaultEngine
      }
      if (updates.respectLatexmkrc !== undefined) {
        if (effective.sources.respectLatexmkrc === 'patch') pinned.push('respectLatexmkrc')
        else writable.respectLatexmkrc = updates.respectLatexmkrc
      }
      if (Object.keys(writable).length > 0) writeState(writable, stateFilePath())
      return { config: await this.settingsPayload(), pinned }
    },

    /**
     * Read the state file as JSON, for the panel's diagnostics row.
     * @returns the raw stored state.
     */
    rawState() {
      return readState(stateFilePath())
    },

    /**
     * Run one `latexmk -v`-free structural report of the build directory.
     *
     * Used by the panel's "recent builds" card to show whether the PDF each
     * record names still exists.
     *
     * @param pdfPath - an absolute PDF path.
     * @returns whether it still exists and its size.
     */
    statPdf(pdfPath) {
      if (typeof pdfPath !== 'string' || pdfPath.length === 0) return { exists: false, bytes: 0 }
      if (!isFile(pdfPath)) return { exists: false, bytes: 0 }
      const bytes = readFileSync(pdfPath).length
      return { exists: true, bytes }
    },

    /** Absolute path of the bundled Python helper, for diagnostics. */
    helperScript() {
      return join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'scripts', 'verify_pdf.py')
    },

    /** Ensure a directory exists (used by the panel before rendering). */
    ensureDir(dir) {
      mkdirSync(dir, { recursive: true })
    },

    /** Write a small text file (used by the panel's diagnostics export). */
    writeFile(file, text) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text, 'utf8')
    },

    /** Render an executable name for this platform, for the panel. */
    exeName,
  }
}
