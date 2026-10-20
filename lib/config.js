/**
 * Plugin configuration.
 *
 * Deliberately a plain validator rather than a schemastery schema: this bundle
 * is symlinked into the profile from `E:`, and Node resolves a symlinked module
 * to its real path, so a bare `@deepseek-ai/schemastery` import would be
 * resolved from `E:\GitHubWorkspace\...` and fail with ERR_MODULE_NOT_FOUND.
 * Both bundle-local reference implementations on this machine
 * (`dsh-gitbash-tool`, `dsh-mole-tool`) take the same approach.
 *
 * There are two layers of settings, and the distinction matters:
 *
 *   - **patch layer** — the `config:` block in `cordis.patch.yml`. It is the
 *     deployment's decision, reviewed in git, and it wins.
 *   - **state layer** — the `defaultEngine` / `respectLatexmkrc` values the
 *     settings panel writes. They live in a JSON file under the DSH storage
 *     directory so that a panel change survives a restart without editing the
 *     profile (which is version-controlled and must be reviewed).
 *
 * The panel shows which layer each value came from, so a value that ignores
 * the toggle is visibly explained rather than silently stuck.
 *
 * Unknown keys are reported rather than ignored: a typo in `cordis.patch.yml`
 * would otherwise look like the setting simply did not work.
 *
 * @module @local/dsh-latex-tool/lib/config
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Bounds for the compile deadline. */
const MIN_TIMEOUT_MS = 10_000
/** Hard ceiling for the compile deadline. */
const MAX_TIMEOUT_MS = 900_000
/** Supported default-engine values. `auto` means "infer from the source". */
export const ENGINE_VALUES = ['auto', 'pdflatex', 'xelatex', 'lualatex']
/** Resolution bounds for rendered verification pages. */
const MIN_DPI = 50
/** Upper DPI bound; above this the PNG is larger than it is useful. */
const MAX_DPI = 400

/**
 * Absolute path of the panel-maintained state file.
 *
 * `DSH_HOME` is set in every shell a profile-launched Harness starts; when it is
 * absent (a bare CLI run) the state simply lives next to the plugin's own
 * package directory instead, which keeps the plugin usable and testable without
 * a profile.
 *
 * @returns the absolute state file path.
 */
export function stateFilePath() {
  const home = process.env.DSH_HOME ?? ''
  if (home.length > 0) return join(home, 'storages', 'dsh-latex-tool', 'state.json')
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'storages', 'dsh-latex-tool', 'state.json')
}

/**
 * Read the panel-maintained state file.
 *
 * A corrupt or unreadable file is not an error: it is treated as empty, because
 * a settings file must never be able to stop a compile from running.
 *
 * @param file - absolute path.
 * @returns the stored object, or an empty object.
 */
export function readState(file = stateFilePath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Merge `patch` over `state` over `defaults`, recording where each value came from.
 *
 * @param patch - the relevant `config:` block fields.
 * @param state - the panel-maintained state.
 * @returns the effective configuration plus a per-field source map.
 */
export function resolveSettings(patch, state) {
  const sources = {}

  const pick = (key, fallback, validate) => {
    if (validate(patch?.[key])) {
      sources[key] = 'patch'
      return patch[key]
    }
    if (validate(state?.[key])) {
      sources[key] = 'state'
      return state[key]
    }
    sources[key] = 'default'
    return fallback
  }

  const settings = {
    defaultEngine: pick('defaultEngine', 'auto', (value) => typeof value === 'string' && ENGINE_VALUES.includes(value)),
    respectLatexmkrc: pick('respectLatexmkrc', false, (value) => typeof value === 'boolean'),
    timeoutMs: pick(
      'timeoutMs',
      180_000,
      (value) => Number.isFinite(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS,
    ),
    renderDpi: pick('renderDpi', 110, (value) => Number.isInteger(value) && value >= MIN_DPI && value <= MAX_DPI),
  }

  return { settings, sources }
}

/**
 * Persist panel-selected values.
 *
 * Only the fields the panel owns are written; a state file that also carried
 * something else would be overwritten with that content preserved.
 *
 * @param updates - the fields to change.
 * @param file - absolute path.
 * @returns the stored state.
 */
export function writeState(updates, file = stateFilePath()) {
  const current = readState(file)
  const next = { ...current }
  if (typeof updates.defaultEngine === 'string' && ENGINE_VALUES.includes(updates.defaultEngine)) {
    next.defaultEngine = updates.defaultEngine
  }
  if (typeof updates.respectLatexmkrc === 'boolean') next.respectLatexmkrc = updates.respectLatexmkrc
  next.updatedAt = new Date().toISOString()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * Normalise the raw `config:` block from the bundle patch.
 *
 * @param raw - the row's `config` object.
 * @param logger - logger used for diagnostics.
 * @returns the validated patch-layer configuration.
 */
export function normalizeConfig(raw, logger) {
  const source = raw ?? {}
  const known = new Set(['texBin', 'pythonPath', 'defaultEngine', 'respectLatexmkrc', 'timeoutMs', 'renderDpi'])
  for (const key of Object.keys(source)) {
    if (!known.has(key)) logger?.warn?.(`latex: unknown config key "${key}" ignored`)
  }

  const out = {}
  if (typeof source.texBin === 'string' && source.texBin.length > 0) out.texBin = source.texBin
  if (typeof source.pythonPath === 'string' && source.pythonPath.length > 0) out.pythonPath = source.pythonPath

  if (source.defaultEngine !== undefined) {
    if (typeof source.defaultEngine === 'string' && ENGINE_VALUES.includes(source.defaultEngine)) {
      out.defaultEngine = source.defaultEngine
    } else {
      logger?.warn?.(`latex: defaultEngine must be one of ${ENGINE_VALUES.join('|')}; ignoring "${String(source.defaultEngine)}"`)
    }
  }

  if (source.respectLatexmkrc !== undefined) {
    if (typeof source.respectLatexmkrc === 'boolean') out.respectLatexmkrc = source.respectLatexmkrc
    else logger?.warn?.('latex: respectLatexmkrc must be a boolean; ignoring it')
  }

  if (source.timeoutMs !== undefined) {
    if (Number.isFinite(source.timeoutMs) && source.timeoutMs >= MIN_TIMEOUT_MS && source.timeoutMs <= MAX_TIMEOUT_MS) {
      out.timeoutMs = source.timeoutMs
    } else {
      logger?.warn?.(`latex: timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}; ignoring it`)
    }
  }

  if (source.renderDpi !== undefined) {
    if (Number.isInteger(source.renderDpi) && source.renderDpi >= MIN_DPI && source.renderDpi <= MAX_DPI) {
      out.renderDpi = source.renderDpi
    } else {
      logger?.warn?.(`latex: renderDpi must be an integer between ${MIN_DPI} and ${MAX_DPI}; ignoring it`)
    }
  }

  return out
}
