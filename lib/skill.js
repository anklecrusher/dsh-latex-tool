/**
 * The bundled `latex-project-workflow` skill.
 *
 * This provider is the *only* source of the LaTeX workflow knowledge. The
 * standalone copies (`~/.agents/skills/latex-paper-workflow` and the
 * `codex-skills` source) were removed once this provider was verified, because
 * two copies drift: edit one, forget the other, and which one the model loads
 * depends on provider priority — unpredictable behaviour with no visible cause.
 *
 * Why a provider and not `ctx.skills.register()`: an in-memory skill cannot
 * supply `resourceBase`, so the `references/*.md` files the skill tells the
 * model to read would resolve against nothing. The provider form is the one
 * DSH's own bundled skills (office, ACL diagnosis) use.
 *
 * Contract details that are easy to get wrong, all verified against
 * `validateCandidate()` in the shipped runtime:
 *
 *   - `name` must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
 *   - `description` must be a non-empty string;
 *   - `invocation` must carry two strict booleans;
 *   - `rank` must be a finite number;
 *   - **`provider` must equal `provider.name` exactly**, or the registry throws
 *     `skill provider "X" returned skill ... for provider "Y"`;
 *   - `get()` must strip the YAML frontmatter from `content`, and must drop
 *     `rank`/`locator` from the returned summary (their semantics move at load
 *     time).
 *
 * The frontmatter is parsed for real rather than by regex. The previous copy of
 * this skill documented that `description: |` multi-line blocks are valid YAML;
 * a hand-rolled `description:\s*(.*)` reader returns the literal `"|"` for such
 * a file and the skill then fails validation with a useless message. The parser
 * below handles plain scalars, quoted scalars, and both block styles for the
 * four fields this skill actually uses.
 *
 * @module @local/dsh-latex-tool/lib/skill
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFile, longPath } from './paths.js'

/** Provider name. Must match every candidate's `provider` field exactly. */
const PROVIDER = 'dsh-latex-tool'
/** Skill name, in the kebab-case the registry requires. */
const SKILL_NAME = 'latex-project-workflow'
/**
 * Rank used by the shipped bundled skills (office, ACL diagnosis). Matching it
 * keeps this skill in the same priority band as skills DSH itself ships, so a
 * user-level skill directory cannot silently shadow it.
 */
const BUNDLED_SKILL_RANK = 600
/** Frontmatter delimiter. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/**
 * Absolute path of this plugin's `skill/` directory.
 *
 * @returns the resolved directory.
 */
export function skillDirectory() {
  return longPath(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'skill'))
}

/**
 * Parse the YAML frontmatter of a SKILL.md.
 *
 * Deliberately minimal and still a real parser for the subset involved:
 * `key: scalar`, `key: "quoted"`, `key: 'quoted'`, `key: |` / `key: >` block
 * scalars with indentation, and simple two-space maps (`invocation:` with
 * `modelInvocable` / `userInvocable` under it). Anything else is ignored rather
 * than mis-parsed — this file's own fields are the only contract.
 *
 * @param raw - the whole file content.
 * @param source - the file path, for error messages.
 * @returns the parsed metadata and the body with the frontmatter removed.
 */
export function parseSkill(raw, source) {
  const match = FRONTMATTER.exec(raw)
  if (match?.[1] === undefined) {
    throw new Error(`dsh-latex-tool: ${source} has no YAML frontmatter`)
  }
  const lines = match[1].split(/\r?\n/)
  const metadata = {}
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    // A top-level key starts at column 0.
    const keyMatch = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (keyMatch === null) {
      index += 1
      continue
    }
    const key = keyMatch[1]
    const rest = keyMatch[2]
    index += 1

    // Block scalar: gather the indented lines that follow.
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-' || rest === '|+' || rest === '>+') {
      const block = []
      while (index < lines.length && (lines[index].startsWith(' ') || lines[index].trim().length === 0)) {
        block.push(lines[index].replace(/^ {2}/, ''))
        index += 1
      }
      const joined = rest.startsWith('|') ? block.join('\n') : block.join(' ')
      metadata[key] = joined.replace(/\s+$/, '')
      continue
    }

    // Nested map (only `invocation` uses this shape here).
    if (rest.length === 0) {
      const nested = {}
      while (index < lines.length && /^\s+\S/.test(lines[index])) {
        const nestedMatch = /^\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[index])
        if (nestedMatch !== null) nested[nestedMatch[1]] = coerceScalar(nestedMatch[2])
        index += 1
      }
      metadata[key] = nested
      continue
    }

    metadata[key] = coerceScalar(rest)
  }

  const description = typeof metadata.description === 'string' ? metadata.description.trim() : ''
  if (description.length === 0) {
    throw new Error(`dsh-latex-tool: ${source} has no description`)
  }
  return {
    metadata,
    description,
    // DSH itself does `raw.slice(frontmatter[0].length).trim()`; the model must
    // not see the `---` block.
    content: raw.slice(match[0].length).trim(),
  }
}

/**
 * Interpret one YAML scalar as the value it denotes.
 *
 * @param value - the raw text after the colon.
 * @returns a boolean, number, or string.
 */
function coerceScalar(value) {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~' || trimmed.length === 0) return ''
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^-?\d*\.\d+$/.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  // A trailing inline comment is not part of the value. Only strip when the
  // comment is preceded by whitespace, so a URL fragment survives.
  return trimmed.replace(/\s+#.*$/, '')
}

/**
 * Register the skill provider.
 *
 * The candidate is built once, because `list()` is called on every catalog
 * refresh and re-reading the file there would make discovery depend on the
 * disk. `get()` re-reads the file so an edited SKILL.md takes effect without a
 * restart, and re-validates the name so a renamed file cannot serve a stale
 * catalog entry.
 *
 * @param ctx - the plugin context carrying the `skills` service.
 * @param logger - optional logger.
 * @returns the registered provider, for diagnostics.
 */
export function registerSkill(ctx, logger) {
  const directory = skillDirectory()
  const locator = join(directory, 'SKILL.md')
  if (!isAbsolute(directory) || !isFile(locator)) {
    throw new Error(`dsh-latex-tool: the bundled skill is missing at ${locator}`)
  }

  /** Read and parse the skill file. */
  const load = async (signal) => {
    const raw = await readFile(locator, { encoding: 'utf8', signal })
    return parseSkill(raw, locator)
  }

  const candidate = {
    name: SKILL_NAME,
    // Filled from the file on first list(); the registry validates it, so a
    // broken frontmatter fails loudly at discovery instead of silently
    // advertising an empty description.
    description: '',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'plugin',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory.split('\\').join('/') },
    locator,
  }

  /** @type {Promise<{description: string}> | null} */
  let priming = null
  const prime = () => {
    if (priming === null) {
      priming = load(undefined)
        .then((parsed) => {
          candidate.description = parsed.description
          return parsed
        })
        .catch((error) => {
          priming = null
          throw error
        })
    }
    return priming
  }

  const provider = {
    name: PROVIDER,
    async list() {
      await prime()
      return [candidate]
    },
    async get(entry, options) {
      const parsed = await load(options?.signal)
      // Drop the provider-only fields: `rank` is a discovery-time ordering
      // hint and `locator` is where this provider keeps the file. Letting
      // either through changes validateDefinition's semantics.
      const { rank: _rank, locator: _locator, ...summary } = entry
      return {
        ...summary,
        // Optional per the contract, but set because it is what lets a UI
        // preview the SKILL.md itself.
        path: locator,
        description: parsed.description,
        content: parsed.content,
      }
    },
  }

  // Return the disposer rather than wrapping it in an effect here: the plugin
  // entry owns the lifetime seam, so there is exactly one place to look for
  // "what did activating this plugin add, and what removes it". Registering the
  // effect inside this module as well would nest two lifetime seams around the
  // same registration.
  const dispose = ctx.skills.registerProvider(() => provider)
  logger?.info?.(`latex: skill provider registered (${SKILL_NAME} from ${directory})`)
  return { provider, candidate, directory, locator, dispose }
}
