/**
 * Web settings panel for the LaTeX integration.
 *
 * Registers one localized `settings.plugins.tab` contribution that renders the
 * TeX toolchain status, the Windows 8.3 short-name fix, the editable plugin
 * configuration and the recent compile history — all read from the Host
 * through the plugin's own same-origin route.
 *
 * Constraints this file respects, from the Harness plugin guidance:
 *   - No Harness Client package is imported (`@deepseek-ai/dsh-client-*`):
 *     those change without notice and a throwing component blanks the slot.
 *     React comes from the browser module table instead.
 *   - Styling uses only `--dsw-alias-*` theme tokens plus the host's radius and
 *     code-font tokens, so light/dark and theme changes follow the host.
 *     Literal colours are reserved for the icon.
 *   - Every registration goes through `ctx.slots.inject(...)`, so it follows
 *     late slot declaration and teardown.
 *
 * The route answers a flat report (`texRoot`, `tempRaw`, `pdfTextTier`, …); the
 * `normalize*` functions below are the single place that knows that shape, so a
 * renamed field costs one adapter edit instead of a hunt through the render
 * tree. They also accept the older nested spelling (`texLive.root`,
 * `tempDir.raw`, `pdfText.tier`) so this panel keeps working either way.
 *
 * @module @local/dsh-latex-tool/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-latex-tool',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Same-origin route registered by the Host half. */
    const RPC = '/plugins/dsh-latex-tool/rpc'
    /** Namespace for the settings contribution. */
    const NS = 'dsh-latex-tool'

    /** Class prefix, so these rules cannot collide with host styles. */
    const P = 'dsh-latex'

    /** Engines the Host accepts for `config.defaultEngine`. */
    const ENGINES = ['auto', 'pdflatex', 'xelatex', 'lualatex']

    /** Packages that get their own row even when the Host did not probe them. */
    const EXPECTED_PACKAGES = ['ctex', 'gb7714', 'biber']

    /**
     * Call the Host route.
     *
     * The Host answers failures with `{ error, detail?, action? }` and a non-2xx
     * status, so they arrive here as a rejected promise; the caller turns that
     * into the error bar rather than letting it escape a component.
     *
     * @param action - the action name (`doctor`, `config`, `history`, `set`,
     *   `smoke`).
     * @param extra - additional body fields (the `set` patch).
     * @returns the parsed response body.
     */
    async function rpc(action, extra = {}) {
      const response = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body === null || body.ok === false || body.error !== undefined) {
        const detail = body?.detail ?? body?.error ?? `HTTP ${response.status}`
        const text = typeof detail === 'string' ? detail : safeJson(detail)
        throw new Error(`${action}: ${text}`)
      }
      return body
    }

    /**
     * Serialise a value without ever throwing (Error/cycle safe).
     * @param value - anything.
     * @returns a display string.
     */
    function safeJson(value) {
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }

    /**
     * Pick the first present value, so one adapter reads both spellings.
     * @param values - candidates, most specific first.
     * @param fallback - returned when every candidate is `undefined`/`null`.
     * @returns the chosen value.
     */
    function first(values, fallback = undefined) {
      for (const value of values) {
        if (value !== undefined && value !== null) return value
      }
      return fallback
    }

    /**
     * Render any partial Host value as display text.
     * @param value - the value to show.
     * @param fallback - text used for `undefined`, `null` and `''`.
     * @returns the display string.
     */
    function valueOr(value, fallback = '—') {
      if (value === undefined || value === null || value === '') return fallback
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      return String(value)
    }

    /**
     * Turn a tri-state probe result into its mark.
     * @param flag - `true`, `false`, or unknown (`null`/`undefined`).
     * @returns the mark character.
     */
    function marks(value) {
      if (value === true) return '✓'
      if (value === false) return '✗'
      return '—'
    }

    /**
     * Class for a tri-state mark, so it is coloured by state.
     * @param value - `true`, `false`, or unknown.
     * @returns the class name.
     */
    function markClass(value) {
      if (value === true) return `${P}-ok`
      if (value === false) return `${P}-bad`
      return `${P}-mute`
    }

    /**
     * Last path segment of a Windows or POSIX path.
     * @param file - the path to shorten.
     * @returns the base name, or `—`.
     */
    function basename(file) {
      if (typeof file !== 'string' || file.length === 0) return '—'
      const parts = file.split(/[\\/]/)
      const last = parts[parts.length - 1]
      return last.length > 0 ? last : file
    }

    /**
     * Format an ISO timestamp in the viewer's local time.
     * @param at - the timestamp from `history`.
     * @returns `YYYY-MM-DD HH:mm`, the raw string when unparsable, or `—`.
     */
    function formatTime(at) {
      if (typeof at !== 'string' || at.length === 0) return '—'
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return at
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * Format a millisecond duration.
     * @param durationMs - the duration from Host data.
     * @param fallback - text used when the value is not a finite number.
     * @returns the display string, always in milliseconds.
     */
    function formatDuration(durationMs, fallback = '—') {
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return fallback
      return `${Math.round(durationMs)} ms`
    }

    /**
     * Format a byte count.
     * @param bytes - the size from `history[].pdfOnDisk`.
     * @returns the display string.
     */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
    }

    /**
     * Render a warning entry, which is normally a string.
     * @param warning - one `doctor.warnings` entry.
     * @returns display text.
     */
    function warningText(warning) {
      return typeof warning === 'string' ? warning : safeJson(warning)
    }

    /**
     * Normalize one smoke result.
     *
     * The Host returns the same record from `doctor.smoke` and from the
     * `smoke` action: `{ ran, ok, exitCode, durationMs, detail }`.
     *
     * @param raw - `body.smoke` or `doctor.smoke`.
     * @returns a view model, or `null`.
     */
    function normalizeSmoke(raw) {
      if (raw === null || typeof raw !== 'object') return null
      return {
        ran: raw.ran === true,
        ok: raw.ok === true,
        exitCode: raw.exitCode,
        durationMs: raw.durationMs,
        detail: valueOr(raw.detail, ''),
      }
    }

    /**
     * Normalize the Host's doctor report.
     *
     * Accepts the flat report the Host writes today and the nested one
     * (`texLive.*`, `tempDir.*`, `pdfText.*`) the panel was first specified
     * against, so neither side of that change breaks the panel.
     *
     * @param raw - `body.doctor`.
     * @returns a view model, or `null` when nothing usable arrived.
     */
    function normalizeDoctor(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const texLive = raw.texLive ?? {}
      const tempDir = raw.tempDir ?? {}
      const pdfText = raw.pdfText ?? {}

      const engines = (Array.isArray(raw.engines) ? raw.engines : [])
        .filter((engine) => engine && typeof engine === 'object')
        .map((engine) => ({
          name: valueOr(engine.name, '?'),
          version: valueOr(engine.version, ''),
          // A probed-but-absent engine is not an available engine: the Host
          // lists all three candidates and marks the missing ones.
          present: engine.present === false ? false
            : engine.present === true ? true
              : typeof engine.version === 'string' && engine.version.length > 0,
        }))

      const packages = (Array.isArray(raw.packages) ? raw.packages : [])
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          name: valueOr(item.name, '?'),
          file: valueOr(item.file, ''),
          found: item.found === true ? true : item.found === false ? false : null,
          path: valueOr(item.path, ''),
        }))

      // biber is a backend, not a TeX package, so it arrives in its own array.
      const backends = (Array.isArray(raw.backends) ? raw.backends : [])
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          name: valueOr(item.name, '?'),
          file: '',
          found: item.found === true ? true : item.found === false ? false : null,
          path: '',
        }))

      const python = raw.python && typeof raw.python === 'object' ? raw.python : null

      return {
        status: typeof raw.status === 'string' ? raw.status : 'unknown',
        texRoot: valueOr(first([texLive.root, raw.texRoot], ''), ''),
        texBin: valueOr(first([texLive.binDir, raw.texBin], ''), ''),
        texSource: valueOr(first([texLive.source, raw.texSource], ''), ''),
        texVersion: valueOr(first([texLive.version, raw.texVersion], ''), ''),
        latexmkVersion: valueOr(raw.latexmkVersion, ''),
        latexmkDetail: valueOr(raw.latexmkDetail, ''),
        engines,
        packages,
        backends,
        python: python === null ? null : {
          executable: valueOr(python.executable, ''),
          version: valueOr(python.version, ''),
          hasPyMuPDF: python.hasPyMuPDF === true ? true : python.hasPyMuPDF === false ? false : null,
          source: valueOr(python.source, ''),
          error: valueOr(python.error, ''),
        },
        pdfTier: valueOr(first([raw.pdfTextTier, pdfText.tier], ''), ''),
        pdfDetail: valueOr(pdfText.detail, ''),
        pdftotext: valueOr(raw.pdftotext, ''),
        temp: {
          raw: valueOr(first([tempDir.raw, raw.tempRaw], ''), ''),
          resolved: valueOr(first([tempDir.resolved, raw.tempResolved], ''), ''),
          shortNameFixed: first([tempDir.shortNameFixed, raw.shortNameFixed], null),
        },
        checks: (Array.isArray(raw.checks) ? raw.checks : [])
          .filter((check) => check && typeof check === 'object')
          .map((check) => ({
            id: valueOr(check.id, '?'),
            ok: check.ok === true ? true : check.ok === false ? false : null,
            detail: valueOr(check.detail, ''),
          })),
        smoke: normalizeSmoke(raw.smoke),
        warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).map(warningText),
      }
    }

    /**
     * Normalize the Host's settings payload.
     * @param raw - `body.config`.
     * @returns a view model, or `null`.
     */
    function normalizeConfig(raw) {
      if (raw === null || typeof raw !== 'object') return null
      const sources = raw.sources && typeof raw.sources === 'object' ? raw.sources : {}
      return {
        defaultEngine: ENGINES.includes(raw.defaultEngine) ? raw.defaultEngine : 'auto',
        respectLatexmkrc: raw.respectLatexmkrc === true,
        timeoutMs: raw.timeoutMs,
        norc: raw.norc,
        texBin: valueOr(raw.texBin, ''),
        pythonPath: valueOr(raw.pythonPath, ''),
        // The shipped Host calls it `renderDpi`; the first draft of this panel
        // spelled it `verifyRenderDpi`.
        renderDpi: first([raw.verifyRenderDpi, raw.renderDpi], undefined),
        stateFile: valueOr(raw.stateFile, ''),
        sources,
      }
    }

    /**
     * Project package rows onto the three packages this panel promises to
     * report, followed by anything else the Host probed.
     *
     * A package the Host did not probe renders as `—` (unknown) rather than a
     * false `✗`.
     *
     * @param doctor - the normalized doctor report.
     * @returns rows of `{ key, name, file, path, found }`.
     */
    function packageRows(doctor) {
      const list = [...doctor.packages, ...doctor.backends]
      const claimed = new Set()
      const rows = []
      for (const expected of EXPECTED_PACKAGES) {
        const needle = expected.toLowerCase()
        let index = -1
        for (let i = 0; i < list.length; i += 1) {
          if (claimed.has(i)) continue
          const haystack = `${list[i].name} ${list[i].file}`.toLowerCase()
          if (haystack.includes(needle)) {
            index = i
            break
          }
        }
        if (index === -1) {
          rows.push({ key: expected, name: expected, file: '', path: '', found: null })
          continue
        }
        claimed.add(index)
        rows.push({ key: expected, ...list[index] })
      }
      list.forEach((item, index) => {
        if (claimed.has(index)) return
        rows.push({ key: `${item.name}-${index}`, ...item })
      })
      return rows
    }

    /**
     * Give a card-body section a position-stable key.
     *
     * Card bodies are a fixed sequence of sections, so the position is a
     * legitimate identity. Keys are not required here (the sections are
     * variadic children, which React reconciles by position), but they let
     * React reuse a row when a conditional section — a warning, a bin path —
     * appears or disappears above it.
     *
     * @param node - one pushed element.
     * @param index - its position in the body.
     * @returns the same element, keyed.
     */
    function keyed(node, index) {
      if (node === null || typeof node !== 'object' || node.type === undefined) return node
      const key = node.props?.key ?? index
      return h(node.type, { ...node.props, key })
    }

    /**
     * Read the active language id out of the Client locale service.
     * @param locale - the `locale` service, or `undefined` when absent.
     * @returns `en` or `zh`.
     */
    function readLanguage(locale) {
      try {
        const active = locale?.getSnapshot?.()?.active
        return typeof active === 'string' && active.startsWith('en') ? 'en' : 'zh'
      } catch {
        return 'zh'
      }
    }

    /**
     * Human text for a `sources` origin.
     * @param source - `patch`, `state`, `default`, or absent.
     * @param t - the inline translator.
     * @returns the note, or `''` when the origin is unknown.
     */
    function sourceText(source, t) {
      if (source === 'patch') return t('from cordis.patch.yml', '来自 cordis.patch.yml')
      if (source === 'state') return t('from this panel', '来自面板设置')
      if (source === 'default') return t('default value', '默认值')
      return ''
    }

    /** Stylesheet, rendered as an element so unmounting removes it. */
    function Styles() {
      return h('style', null, `
.${P}-root { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 8px; font-size: 13px; }
.${P}-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.${P}-topTitle { font-weight: 600; font-size: 14px; color: var(--dsw-alias-label-primary); }
.${P}-topSub { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.${P}-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.${P}-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.${P}-title { font-weight: 600; color: var(--dsw-alias-label-primary); }
.${P}-sub { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.${P}-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; }
.${P}-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; }
.${P}-rowStart { display: flex; align-items: baseline; justify-content: flex-start; gap: 8px; min-width: 0; }
.${P}-label { flex: none; color: var(--dsw-alias-label-secondary); }
.${P}-value { min-width: 0; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; text-align: right; }
.${P}-mono { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
.${P}-trunc { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${P}-note { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.${P}-src { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.${P}-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; }
.${P}-badgeReady { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.${P}-badgeDegraded { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.${P}-badgeMissing { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.${P}-badgeUnknown { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-tertiary); }
.${P}-ok { color: var(--dsw-alias-state-success-primary); }
.${P}-bad { color: var(--dsw-alias-state-error-primary); }
.${P}-warn { color: var(--dsw-alias-state-warn-label); }
.${P}-mute { color: var(--dsw-alias-label-tertiary); }
.${P}-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
.${P}-kv { min-width: 0; }
.${P}-kvLabel { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.${P}-kvValue { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.${P}-select { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 8px; font-size: 13px; cursor: pointer; }
.${P}-select:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.${P}-select:disabled { opacity: .55; cursor: default; }
.${P}-switch { position: relative; flex: none; width: 38px; height: 22px; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-3); cursor: pointer; transition: background .15s, border-color .15s; }
.${P}-switchOn { background: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }
.${P}-switch:disabled { opacity: .55; cursor: default; }
.${P}-switch i { position: absolute; top: 2px; left: 2px; display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-bg-layer-1); transition: left .15s; }
.${P}-switchOn i { left: 18px; }
.${P}-switch:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.${P}-btn { appearance: none; padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
.${P}-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3); }
.${P}-btn:disabled { opacity: .55; cursor: default; }
.${P}-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.${P}-btnPrimary { background: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-1); }
.${P}-btnPrimary:hover:not(:disabled) { background: var(--dsw-alias-label-primary); opacity: .86; }
.${P}-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.${P}-err { padding: 8px 10px; border-left: 3px solid var(--dsw-alias-state-error-primary); border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.${P}-okLine { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.${P}-list { display: flex; flex-direction: column; }
.${P}-item { display: flex; flex-direction: column; gap: 2px; padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.${P}-item:last-child { border-bottom: none; }
.${P}-itemTop { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
.${P}-itemName { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.${P}-itemMeta { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.${P}-tag { flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; white-space: nowrap; }
.${P}-tagOk { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.${P}-tagBad { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.${P}-path { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
`)
    }

    /**
     * Status pill for `doctor.status`.
     * @param props - `{ status, t }`.
     */
    function StatusBadge({ status, t }) {
      const variant = status === 'ready' ? 'Ready' : status === 'degraded' ? 'Degraded' : status === 'missing' ? 'Missing' : 'Unknown'
      const label = status === 'ready' ? t('Ready', '就绪')
        : status === 'degraded' ? t('Degraded', '部分可用')
          : status === 'missing' ? t('Missing', '未就绪')
            : t('Unknown', '未知')
      const known = variant !== 'Unknown'
      return h('span', { className: `${P}-badge ${P}-badge${variant}` },
        known ? label : `${label}${status && status !== 'unknown' ? ` (${status})` : ''}`)
    }

    /**
     * Human text for the PDF-text capability tier.
     * @param tier - `full` / `text` / `minimal`, or a legacy `pymupdf` /
     *   `pdftotext` / `none` value.
     * @param t - the inline translator.
     * @returns `{ label, tone }` where tone is one of `ok` / `warn` / `bad`.
     */
    function pdfTierText(tier, t) {
      if (tier === 'full' || tier === 'pymupdf') {
        return { label: t('PyMuPDF (full)', 'PyMuPDF（完整）'), tone: 'ok' }
      }
      if (tier === 'text' || tier === 'pdftotext') {
        return { label: t('pdftotext (partial)', 'pdftotext（部分）'), tone: 'warn' }
      }
      if (tier === 'minimal' || tier === 'none') {
        return { label: t('structure only', '仅结构检查'), tone: 'bad' }
      }
      return { label: valueOr(tier), tone: 'mute' }
    }

    /**
     * TeX toolchain card: TeX Live, latexmk, engines, packages, Python and the
     * PDF text tier.
     * @param props - `{ doctor, t }`.
     */
    function StatusCard({ doctor, t }) {
      const body = []
      if (doctor === null) {
        body.push(h('div', { className: `${P}-note` },
          t('Not loaded yet. Press Refresh to read the toolchain status.',
            '尚未读取。点「刷新」读取工具链状态。')))
      } else {
        body.push(h('div', { className: `${P}-row` },
          h('span', { className: `${P}-label` }, t('Status', '状态')),
          h(StatusBadge, { status: doctor.status, t }),
        ))
        if (doctor.texRoot || doctor.texVersion) {
          body.push(h('div', { className: `${P}-row` },
            h('span', { className: `${P}-label` }, t('TeX Live', 'TeX Live')),
            h('span', { className: `${P}-value` },
              `${valueOr(doctor.texVersion)} · ${valueOr(doctor.texRoot)}`),
          ))
        }
        if (doctor.texBin) {
          body.push(h('div', { className: `${P}-rowStart`, title: `source: ${valueOr(doctor.texSource)}` },
            h('span', { className: `${P}-note` }, t('bin dir', 'bin 目录')),
            h('span', { className: `${P}-value ${P}-mono ${P}-trunc`, title: doctor.texBin }, doctor.texBin),
          ))
        }
        body.push(h('div', { className: `${P}-row`, title: doctor.latexmkDetail },
          h('span', { className: `${P}-label` }, 'latexmk'),
          h('span', { className: `${P}-value` }, valueOr(doctor.latexmkVersion, t('not found', '未找到'))),
        ))

        body.push(h('div', { className: `${P}-kvLabel` }, t('Engines', '引擎')))
        if (doctor.engines.length === 0) {
          body.push(h('div', { className: `${P}-note` }, t('No engine answered.', '没有引擎应答。')))
        } else {
          for (const engine of doctor.engines) {
            body.push(h('div', { className: `${P}-row`, key: `engine-${engine.name}` },
              h('span', { className: `${P}-label ${P}-mono` }, engine.name),
              h('span', {
                className: `${P}-value ${P}-mono ${P}-trunc`,
                title: engine.version,
              }, engine.present ? valueOr(engine.version, t('present', '已安装')) : '✗'),
            ))
          }
        }

        body.push(h('div', { className: `${P}-kvLabel` }, t('Packages', '宏包')))
        for (const row of packageRows(doctor)) {
          body.push(h('div', { className: `${P}-row`, key: `package-${row.key}`, title: row.path },
            h('span', { className: `${P}-label` }, row.file ? `${row.name} (${row.file})` : row.name),
            h('span', {
              className: `${markClass(row.found)} ${P}-value`,
              title: row.found === null ? t('The Host did not probe this package.', 'Host 未探测该宏包。') : row.path,
            }, marks(row.found)),
          ))
        }

        body.push(h('div', { className: `${P}-row` },
          h('span', { className: `${P}-label` }, 'Python'),
          h('span', { className: `${P}-value` },
            doctor.python === null || doctor.python.version === ''
              ? t('not found', '未找到')
              : doctor.python.version),
        ))
        if (doctor.python?.executable) {
          body.push(h('div', { className: `${P}-rowStart`, title: `source: ${valueOr(doctor.python.source)}` },
            h('span', { className: `${P}-note` }, t('executable', '可执行文件')),
            h('span', { className: `${P}-value ${P}-mono ${P}-trunc`, title: doctor.python.executable },
              doctor.python.executable),
          ))
        }
        body.push(h('div', { className: `${P}-row` },
          h('span', { className: `${P}-label` }, 'PyMuPDF'),
          h('span', { className: `${markClass(doctor.python?.hasPyMuPDF ?? null)} ${P}-value` },
            `${marks(doctor.python?.hasPyMuPDF ?? null)} `
            + (doctor.python?.hasPyMuPDF === true
              ? t('installed', '已安装')
              : t('not installed', '未安装'))),
        ))

        const tier = pdfTierText(doctor.pdfTier, t)
        body.push(h('div', { className: `${P}-row` },
          h('span', { className: `${P}-label` }, t('PDF text tier', 'PDF 文本层')),
          h('span', { className: `${P}-value ${tier.tone === 'ok' ? `${P}-ok` : tier.tone === 'bad' ? `${P}-bad` : tier.tone === 'warn' ? `${P}-warn` : `${P}-mute`}` },
            doctor.pdfTier && doctor.pdfTier !== tier.label ? `${tier.label} · ${doctor.pdfTier}` : tier.label),
        ))
        if (doctor.pdfDetail) {
          body.push(h('div', { className: `${P}-note` }, doctor.pdfDetail))
        }
        if (doctor.pdftotext) {
          body.push(h('div', { className: `${P}-note ${P}-mono ${P}-trunc`, title: doctor.pdftotext },
            `pdftotext: ${doctor.pdftotext}`))
        }

        if (doctor.checks.length > 0) {
          const parts = []
          doctor.checks.forEach((check, index) => {
            if (index > 0) parts.push(' · ')
            parts.push(h('span', {
              key: `check-${check.id}`,
              className: markClass(check.ok),
              title: check.detail,
            }, `${check.id} ${marks(check.ok)}`))
          })
          body.push(h('div', { className: `${P}-note` }, h('span', null, t('Checks: ', '检查：')), ...parts))
        }
        for (const [index, warning] of doctor.warnings.entries()) {
          body.push(h('div', { className: `${P}-warn ${P}-note`, key: `warning-${index}` }, warning))
        }
      }

      return h('div', { className: `${P}-card` },
        h('div', { className: `${P}-head` },
          h('div', null,
            h('div', { className: `${P}-title` }, t('TeX toolchain', 'TeX 工具链')),
            h('div', { className: `${P}-sub` },
              doctor
                ? `${valueOr(doctor.status)} · TeX Live ${valueOr(doctor.texVersion)} · latexmk ${valueOr(doctor.latexmkVersion)}`
                : t('Not loaded yet', '尚未加载')),
          ),
        ),
        h('div', { className: `${P}-body` }, ...body.map(keyed)),
      )
    }

    /**
     * Windows 8.3 short-name card: the raw temporary directory, the restored
     * long name, and the smoke test that proves the fix.
     * @param props - `{ doctor, smoke, busy, onSmoke, t }`.
     */
    function TempDirCard({ doctor, smoke, busy, onSmoke, t }) {
      const body = []
      if (doctor === null) {
        body.push(h('div', { className: `${P}-note` },
          t('Not loaded yet. Press Refresh to read the temporary directory.',
            '尚未读取。点「刷新」读取临时目录。')))
      } else if (doctor.temp.raw === '' && doctor.temp.resolved === '') {
        body.push(h('div', { className: `${P}-note` },
          t('The Host did not report a temporary directory.', 'Host 未返回临时目录。')))
      } else {
        body.push(h('div', { className: `${P}-row` },
          h('span', { className: `${P}-label` }, t('raw (8.3)', '原始（8.3）')),
          h('span', { className: `${P}-value ${P}-mono ${P}-trunc`, title: doctor.temp.raw },
            valueOr(doctor.temp.raw)),
        ))
        body.push(h('div', { className: `${P}-row` },
          h('span', { className: `${P}-label` }, t('restored', '还原后')),
          h('span', { className: `${P}-value ${P}-mono ${P}-trunc`, title: doctor.temp.resolved },
            `→ ${valueOr(doctor.temp.resolved)}`),
        ))
        if (doctor.temp.shortNameFixed === true) {
          body.push(h('div', { className: `${P}-note ${P}-ok` },
            t('Long name restored: latexmk no longer rejects paths containing `~`.',
              '已还原长名，latexmk 不再拒绝 `~` 路径')))
        } else if (doctor.temp.shortNameFixed === false) {
          body.push(h('div', { className: `${P}-note` },
            t('No 8.3 short name was present, so nothing needed restoring.',
              '未出现 8.3 短名，无需还原。')))
        }
      }

      body.push(h('div', { className: `${P}-actions` },
        h('button', {
          type: 'button',
          className: `${P}-btn`,
          disabled: busy === 'smoke',
          onClick: onSmoke,
        }, busy === 'smoke'
          ? t('Running… (~10 s)', '运行中…（约 10 秒）')
          : t('Run smoke test', '运行冒烟测试')),
      ))

      // Prefer the inline smoke result from `doctor` until the button is used:
      // a doctor read may already carry a smoke run.
      const result = smoke ?? doctor?.smoke ?? null
      if (result === null) {
        body.push(h('div', { className: `${P}-note` },
          t('Compiles a tiny document through the same latexmk call, which is what proves the short-name fix.',
            '用同一条 latexmk 调用编译一份极小文档，这正是验证短名修复的方式。')))
      } else if (result.ran === false) {
        body.push(h('div', { className: `${P}-note` },
          `${t('Not run', '未运行')} · ${valueOr(result.detail)}`))
      } else {
        body.push(h('div', { className: `${P}-row` },
          h('span', { className: `${P}-label` }, t('Smoke test', '冒烟测试')),
          h('span', { className: `${P}-value ${result.ok === true ? `${P}-ok` : `${P}-bad`}` },
            `${result.ok === true ? t('passed', '通过') : t('failed', '失败')}`
            + ` · exit ${valueOr(result.exitCode)} · ${formatDuration(result.durationMs)}`),
        ))
        if (result.detail) {
          body.push(h('div', { className: `${P}-note` }, result.detail))
        }
      }

      return h('div', { className: `${P}-card` },
        h('div', { className: `${P}-head` },
          h('div', null,
            h('div', { className: `${P}-title` }, t('8.3 short names and temporary directory', '8.3 短名与临时目录')),
            h('div', { className: `${P}-sub` },
              t('latexmk refuses a `~` in the temp path; the Host expands it first.',
                'latexmk 会拒绝含 `~` 的临时路径，Host 会先把它还原。')),
          ),
        ),
        h('div', { className: `${P}-body` }, ...body.map(keyed)),
      )
    }

    /**
     * Editable configuration card plus the read-only resolved values.
     * @param props - `{ config, busy, pinned, onSet, t }`.
     */
    function ConfigCard({ config, busy, pinned, onSet, t }) {
      const saving = busy === 'save'
      const body = []
      if (config === null) {
        body.push(h('div', { className: `${P}-note` },
          t('Not loaded yet. Press Refresh to read the configuration.',
            '尚未读取。点「刷新」读取配置。')))
      } else {
        const enginePinned = pinned.includes('defaultEngine') || config.sources.defaultEngine === 'patch'
        const engineSource = sourceText(config.sources.defaultEngine, t)
        body.push(h('div', { className: `${P}-row` },
          h('span', { className: `${P}-label` },
            t('Default engine', '默认引擎'),
            engineSource ? h('span', { className: `${P}-src` }, engineSource) : null,
          ),
          h('select', {
            className: `${P}-select`,
            value: config.defaultEngine,
            disabled: saving || enginePinned,
            title: enginePinned
              ? t('Pinned by cordis.patch.yml; edit the patch to change it.',
                '被 cordis.patch.yml 固定，需改 patch 才能生效。')
              : '',
            onChange: (event) => {
              const value = event.target.value
              if (value !== config.defaultEngine) onSet({ defaultEngine: value })
            },
          }, ...ENGINES.map((engine) => h('option', { key: engine, value: engine }, engine))),
        ))

        const rcPinned = pinned.includes('respectLatexmkrc') || config.sources.respectLatexmkrc === 'patch'
        const rcSource = sourceText(config.sources.respectLatexmkrc, t)
        body.push(h('div', { className: `${P}-row` },
          h('span', { className: `${P}-label` },
            t('Honour the project latexmkrc', '遵循项目 latexmkrc'),
            rcSource ? h('span', { className: `${P}-src` }, rcSource) : null,
          ),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': config.respectLatexmkrc,
            'aria-label': t('Honour the project latexmkrc', '遵循项目 latexmkrc'),
            className: config.respectLatexmkrc ? `${P}-switch ${P}-switchOn}` : `${P}-switch`,
            disabled: saving || rcPinned,
            title: rcPinned
              ? t('Pinned by cordis.patch.yml; edit the patch to change it.',
                '被 cordis.patch.yml 固定，需改 patch 才能生效。')
              : '',
            onClick: () => onSet({ respectLatexmkrc: !config.respectLatexmkrc }),
          }, h('i')),
        ))
        if (enginePinned || rcPinned) {
          body.push(h('div', { className: `${P}-note ${P}-warn` },
            t('A pinned field ignores panel changes: cordis.patch.yml wins over this state file.',
              '被固定的字段会忽略面板改动：cordis.patch.yml 优先于 state 文件。')))
        }

        body.push(h('div', { className: `${P}-grid` },
          h('div', { className: `${P}-kv` },
            h('div', { className: `${P}-kvLabel` }, t('Timeout', '超时')),
            h('div', { className: `${P}-kvValue` }, formatDuration(config.timeoutMs)),
          ),
          h('div', { className: `${P}-kv` },
            h('div', { className: `${P}-kvLabel` }, 'norc'),
            h('div', { className: `${P}-kvValue` },
              `${valueOr(config.norc)}${config.norc === true ? t(' (-norc)', '（-norc）') : ''}`),
          ),
          h('div', { className: `${P}-kv` },
            h('div', { className: `${P}-kvLabel` }, t('TeX bin dir', 'TeX bin 目录')),
            h('div', { className: `${P}-kvValue ${P}-mono ${P}-trunc`, title: config.texBin },
              config.texBin || t('auto-probed', '自动探测')),
          ),
          h('div', { className: `${P}-kv` },
            h('div', { className: `${P}-kvLabel` }, 'pythonPath'),
            h('div', { className: `${P}-kvValue ${P}-mono ${P}-trunc`, title: config.pythonPath },
              config.pythonPath || t('auto-probed', '自动探测')),
          ),
          h('div', { className: `${P}-kv` },
            h('div', { className: `${P}-kvLabel` }, t('Verification render DPI', '验证渲染 DPI')),
            h('div', { className: `${P}-kvValue` }, valueOr(config.renderDpi)),
          ),
          h('div', { className: `${P}-kv` },
            h('div', { className: `${P}-kvLabel` }, t('State file', 'state 文件')),
            h('div', { className: `${P}-kvValue ${P}-mono ${P}-trunc`, title: config.stateFile },
              valueOr(config.stateFile)),
          ),
        ))
        body.push(h('div', { className: `${P}-note` },
          t('The two controls above write to the plugin state file; the rest comes from cordis.patch.yml or the defaults.',
            '上面两个控件会写入插件 state 文件；其余来自 cordis.patch.yml 或默认值。')))
      }

      return h('div', { className: `${P}-card` },
        h('div', { className: `${P}-head` },
          h('div', null,
            h('div', { className: `${P}-title` }, t('Configuration', '配置')),
            h('div', { className: `${P}-sub` },
              saving ? t('Saving…', '保存中…') : t('Changes are applied immediately.', '改动即时生效。')),
          ),
        ),
        h('div', { className: `${P}-body` }, ...body.map(keyed)),
      )
    }

    /**
     * The five most recent compiles.
     * @param props - `{ history, t }`.
     */
    function HistoryCard({ history, t }) {
      const list = Array.isArray(history) ? history.filter(Boolean).slice(0, 5) : []
      const body = []
      if (history === null) {
        body.push(h('div', { className: `${P}-note` },
          t('Not loaded yet. Press Refresh to read the history.',
            '尚未读取。点「刷新」读取编译历史。')))
      } else if (list.length === 0) {
        body.push(h('div', { className: `${P}-note` },
          t('No compile has been recorded yet. Run `latex_compile` once and it will show up here.',
            '还没有编译记录。用 `latex_compile` 跑一次，这里就会出现记录。')))
      } else {
        body.push(h('div', { className: `${P}-list` },
          ...list.map((entry, index) => {
            const meta = []
            meta.push(formatTime(entry?.at))
            meta.push(valueOr(entry?.engine))
            meta.push(formatDuration(entry?.durationMs))
            meta.push(`exit ${valueOr(entry?.exitCode)}`)
            const disk = entry?.pdfOnDisk
            let pdfLine = null
            if (typeof entry?.pdfPath === 'string' && entry.pdfPath.length > 0) {
              const missing = disk !== undefined && disk !== null && disk.exists === false
              pdfLine = h('div', {
                className: `${P}-path ${P}-mono ${P}-trunc ${missing ? `${P}-mute` : ''}`,
                title: entry.pdfPath,
              }, missing ? `${entry.pdfPath} ${t('(deleted)', '（已删除）')}` : entry.pdfPath)
            }
            const extras = []
            if (typeof entry?.errors === 'number' && entry.errors > 0) {
              extras.push(`${entry.errors} ${t('errors', '个错误')}`)
            }
            if (typeof entry?.missingGlyphs === 'number' && entry.missingGlyphs > 0) {
              extras.push(`${entry.missingGlyphs} ${t('missing glyphs', '个缺字')}`)
            }
            if (disk?.exists === true) extras.push(formatBytes(disk.bytes))
            return h('div', { className: `${P}-item`, key: `${entry?.at ?? 'row'}-${index}` },
              h('div', { className: `${P}-itemTop` },
                h('span', {
                  className: `${P}-itemName`,
                  title: valueOr(entry?.tex, ''),
                }, valueOr(entry?.name, basename(entry?.tex))),
                h('span', { className: `${P}-tag ${entry?.ok === true ? `${P}-tagOk` : `${P}-tagBad`}` },
                  entry?.ok === true ? '✓ ok' : `✗ ${t('failed', '失败')}`),
              ),
              h('div', { className: `${P}-itemTop` },
                h('span', { className: `${P}-itemMeta` }, meta.join(' · ')),
              ),
              pdfLine,
              extras.length > 0
                ? h('div', { className: `${P}-note` }, extras.join(' · '))
                : null,
            )
          }),
        ))
        body.push(h('div', { className: `${P}-note` },
          t('Five most recent compiles, newest first.', '最近 5 条编译记录，最新在前。')))
      }

      return h('div', { className: `${P}-card` },
        h('div', { className: `${P}-head` },
          h('div', null,
            h('div', { className: `${P}-title` }, t('Recent compiles', '最近编译')),
            h('div', { className: `${P}-sub` },
              history === null
                ? t('Not loaded yet', '尚未加载')
                : `${list.length} ${t('rows', '条')}`),
          ),
        ),
        h('div', { className: `${P}-body` }, ...body.map(keyed)),
      )
    }

    /**
     * The settings tab component.
     * @param props - slot props; `locale` is supplied by the registration
     *   wrapper in `apply`.
     */
    function LaTeXSettingsPanel(props) {
      const locale = props?.locale
      const [lang, setLang] = React.useState(() => readLanguage(locale))
      const [doctor, setDoctor] = React.useState(null)
      const [config, setConfig] = React.useState(null)
      const [history, setHistory] = React.useState(null)
      const [smoke, setSmoke] = React.useState(null)
      const [pinned, setPinned] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [message, setMessage] = React.useState('')

      React.useEffect(() => {
        if (typeof locale?.subscribe !== 'function') return undefined
        return locale.subscribe(() => setLang(readLanguage(locale)))
      }, [locale])

      const zh = lang === 'zh'
      const t = (en, cn) => (zh ? cn : en)

      /**
       * Run one panel action with the shared error bar.
       *
       * A plain function rather than `useCallback`: `t` is rebuilt every
       * render, so a memo keyed on it would never be reused anyway, and the
       * panel's own re-renders are cheap.
       */
      const run = async (key, fn) => {
        setBusy(key)
        setError('')
        setMessage('')
        try {
          return await fn()
        } catch (cause) {
          setError(cause instanceof Error && cause.message ? cause.message : String(cause))
          return undefined
        } finally {
          setBusy('')
        }
      }

      /** Re-read doctor, config and history. */
      const refresh = () => run('refresh', async () => {
        const results = await Promise.allSettled([
          rpc('doctor').then((body) => normalizeDoctor(body.doctor)),
          rpc('config').then((body) => normalizeConfig(body.config)),
          rpc('history').then((body) => (Array.isArray(body.history) ? body.history : [])),
        ])
        const failures = []
        if (results[0].status === 'fulfilled') setDoctor(results[0].value)
        else failures.push(results[0].reason)
        if (results[1].status === 'fulfilled') setConfig(results[1].value)
        else failures.push(results[1].reason)
        if (results[2].status === 'fulfilled') setHistory(results[2].value)
        else failures.push(results[2].reason)
        if (failures.length > 0) throw failures[0]
      })

      /**
       * Write one configuration field and adopt the Host's canonical answer.
       *
       * The Host reports `pinned` for fields the patch layer owns; those writes
       * are deliberately ignored there, so the panel says so instead of leaving
       * a control that appears broken.
       */
      const save = async (patch) => {
        setError('')
        setMessage('')
        setBusy('save')
        try {
          const body = await rpc('set', patch)
          const next = normalizeConfig(body.config)
          setConfig(next)
          const ignored = Array.isArray(body.pinned) ? body.pinned.filter((key) => key in patch) : []
          setPinned(Array.isArray(body.pinned) ? body.pinned : [])
          if (ignored.length > 0) {
            setError(t(
              `cordis.patch.yml pins ${ignored.join(', ')}, so the panel change was not written.`,
              `cordis.patch.yml 固定了 ${ignored.join(', ')}，面板改动未写入。`,
            ))
          } else {
            setMessage(t('Saved.', '已保存。'))
          }
        } catch (cause) {
          setError(cause instanceof Error && cause.message ? cause.message : String(cause))
          // Re-read the Host's truth so the controls do not keep a rejected value.
          try {
            const body = await rpc('config')
            setConfig(normalizeConfig(body.config))
          } catch {
            /* the error bar already carries the first failure */
          }
        } finally {
          setBusy('')
        }
      }

      /** Run the ~10 s compilation smoke test. */
      const runSmoke = () => run('smoke', async () => {
        const body = await rpc('smoke')
        const result = normalizeSmoke(body.smoke)
        setSmoke(result)
        if (result?.ok === true) {
          setMessage(t('Smoke test passed.', '冒烟测试通过。'))
        } else {
          setError(t('Smoke test failed — see the result below.', '冒烟测试失败，见下方结果。'))
        }
      })

      React.useEffect(() => {
        refresh()
      }, [])

      return h(React.Fragment, null,
        h(Styles),
        h('div', { className: `${P}-root` },
          h('div', { className: `${P}-top` },
            h('div', null,
              h('div', { className: `${P}-topTitle` }, t('LaTeX', 'LaTeX 排版')),
              h('div', { className: `${P}-topSub` },
                t('Compile, diagnose and verify LaTeX projects: latex_compile / latex_verify / latex_doctor.',
                  '编译、诊断与验证 LaTeX 项目：latex_compile / latex_verify / latex_doctor。')),
            ),
            h('button', {
              type: 'button',
              className: `${P}-btn ${P}-btnPrimary`,
              disabled: busy === 'refresh',
              onClick: refresh,
            }, busy === 'refresh' ? t('Refreshing…', '刷新中…') : t('Refresh', '刷新')),
          ),
          error ? h('div', { className: `${P}-err`, role: 'alert' }, error) : null,
          message ? h('div', { className: `${P}-okLine` }, message) : null,
          h(StatusCard, { doctor, t }),
          h(TempDirCard, { doctor, smoke, busy, onSmoke: runSmoke, t }),
          h(ConfigCard, { config, busy, pinned, onSet: save, t }),
          h(HistoryCard, { history, t }),
        ),
      )
    }

    /**
     * Wrap the panel so it receives the locale service directly.
     *
     * The slot hands a component its standard props, and the locale face is not
     * among them; capturing the service here keeps the panel following language
     * switches without importing a Client package.
     *
     * @param locale - the `locale` service, or `undefined` when absent.
     * @returns the slot component.
     */
    function panelWithLocale(locale) {
      return function LaTeXSettingsPanelAtSlot(props) {
        return h(LaTeXSettingsPanel, { ...props, locale })
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale')
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: NS,
          order: 41,
          label: () => (readLanguage(locale) === 'en' ? 'LaTeX' : 'LaTeX 排版'),
          locale: NS,
        }, panelWithLocale(locale)))
      },
    }
  },
})
