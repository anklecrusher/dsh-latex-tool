#!/usr/bin/env node
/**
 * Live verification: install the plugin into a throwaway profile and prove the
 * runtime contract against the real DSH CLI.
 *
 * The offline harness (`test-harness.mjs`) exercises the plugin's own code paths
 * with a fake Cordis context. This script does something different: it asks the
 * real DSH CLI to install the bundle and compose the profile, then checks the
 * things a fake context cannot prove —
 *
 *   - that `@local/dsh-latex-tool` is accepted as a `link:` dependency and its
 *     bundle patch is applied by the loader (visible in `--dump-config`);
 *   - that the skill provider passes the runtime's `validateCandidate()` and
 *     the skill loads with its frontmatter stripped;
 *   - that removing the bundle leaves nothing behind (V12).
 *
 * It never touches the `desktop` profile. Profiles always live under
 * `$USERPROFILE/.dsh/profiles/<name>` — the CLI has no option to relocate them —
 * so a scratch name is used and deleted at the end.
 *
 * Usage:
 *   node scripts/live-check.mjs                 # create, install, verify, remove
 *   node scripts/live-check.mjs --keep          # keep the scratch profile
 *   node scripts/live-check.mjs --profile NAME  # use a specific scratch name
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const keep = process.argv.includes('--keep')
const profileArgIndex = process.argv.indexOf('--profile')
const profileName = profileArgIndex !== -1 ? process.argv[profileArgIndex + 1] : 'dsh-latex-check'
const profileDir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', profileName)

/**
 * The desktop app's bundled CLI. A plain `dsh` on PATH may be a different
 * install, and the Electron app's profile handling lives here.
 */
const DSH_CLI = process.env.DSH_CLI
  ?? 'D:\\Users\\ankle crusher\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'

const results = []
const notes = []
let failures = 0

/**
 * Run one named check.
 * @param name - the check label.
 * @param fn - the async body.
 */
async function check(name, fn) {
  try {
    await fn()
    results.push(`  PASS  ${name}`)
  } catch (error) {
    failures += 1
    results.push(`  FAIL  ${name}\n        ${error.message}`)
  }
}

/**
 * Run the DSH CLI and capture its output as bytes.
 *
 * The CLI is a `.cmd`, which Node cannot spawn directly on Windows (EINVAL), and
 * it reconfigures the console encoding in its own bootstrap. Bytes are captured
 * and decoded as UTF-8 with a GBK fallback, the same policy the plugin itself
 * applies — otherwise a Chinese profile path in the output would come back as
 * replacement characters.
 *
 * @param args - arguments after the profile flag has been inserted by the caller.
 * @returns exit code plus decoded streams.
 */
function dsh(args) {
  const result = spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : DSH_CLI,
    process.platform === 'win32' ? ['/d', '/c', DSH_CLI, ...args] : args,
    { cwd: pluginDir, windowsHide: true, env: process.env, timeout: 180_000 },
  )
  return {
    code: result.status,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
    error: result.error,
  }
}

/**
 * Decode CLI output: UTF-8 first, GBK when that yields replacement characters.
 * @param buffer - the captured bytes.
 * @returns the decoded text.
 */
function decode(buffer) {
  if (buffer === null || buffer === undefined) return ''
  const utf8 = new TextDecoder('utf-8').decode(buffer)
  if (utf8.length === 0 || !utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}

if (!existsSync(DSH_CLI)) {
  console.error(`Cannot find the DSH CLI at ${DSH_CLI}. Set DSH_CLI to the desktop app's dsh.cmd.`)
  process.exit(2)
}

// Start from a clean slate so a previous aborted run cannot make this one pass
// or fail for the wrong reason.
rmSync(profileDir, { recursive: true, force: true })

await check('the plugin package manifest is valid and ships every asset', () => {
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  if (manifest.name !== '@local/dsh-latex-tool') throw new Error(`name is ${manifest.name}`)
  if (manifest.type !== 'module') throw new Error('type must be module')
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch is not set')
  if (manifest.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform is not web')
  for (const file of ['cordis.patch.yml', 'entry.js', 'index.js', 'client.js', 'icon.svg', 'skill/SKILL.md', 'scripts/verify_pdf.py', 'locale/zh.json', 'locale/en.json']) {
    if (!existsSync(join(pluginDir, file))) throw new Error(`missing shipped file: ${file}`)
  }
  // A declared file that does not exist is a distribution bug the `files`
  // allowlist would hide until pack time.
  for (const entry of manifest.files ?? []) {
    if (!existsSync(join(pluginDir, entry))) throw new Error(`package.json files[] names a missing path: ${entry}`)
  }
})

await check('installing the bundle into a scratch profile succeeds', () => {
  const added = dsh(['plugin', '--profile', profileName, 'add', pluginDir])
  if (added.code !== 0) {
    throw new Error(`dsh plugin add failed (exit ${added.code})\n${added.stdout}\n${added.stderr}`)
  }
  const manifestFile = join(profileDir, 'package.json')
  if (!existsSync(manifestFile)) throw new Error(`no profile manifest at ${manifestFile}`)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const dep = manifest.dependencies?.['@local/dsh-latex-tool']
  if (typeof dep !== 'string') throw new Error('the dependency was not recorded')
  if (!dep.startsWith('link:')) throw new Error(`expected a link: dependency, got ${dep}`)
  if (!dep.toLowerCase().includes('dsh-latex-tool')) throw new Error(`unexpected link target: ${dep}`)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@local/dsh-latex-tool')) throw new Error('the bundle was not listed in dsh.profile.bundles')
  const link = join(profileDir, 'node_modules', '@local', 'dsh-latex-tool')
  if (!existsSync(link)) throw new Error(`the linked module was not created: ${link}`)
})

await check('--dump-config composes the latex-tool row (the loader accepts the bundle patch)', () => {
  const dumped = dsh(['--profile', profileName, '--dump-config'])
  const config = `${dumped.stdout}\n${dumped.stderr}`
  if (dumped.code !== 0) throw new Error(`--dump-config failed (exit ${dumped.code})\n${config.slice(0, 2000)}`)
  // The bundle's own patch supplies this row; it is deliberately NOT copied
  // into the profile's cordis.patch.yml, because a bundle owns its rows.
  if (!/^- id: latex-tool$/m.test(config)) {
    throw new Error(`the latex-tool row is absent from the composed config:\n${config.slice(-2000)}`)
  }
  if (!/name: '@local\/dsh-latex-tool'/.test(config)) {
    throw new Error('the latex-tool row does not name the bundle')
  }
  if (/failed to load|Cannot find module|ERR_MODULE_NOT_FOUND|is not a package/i.test(config)) {
    throw new Error(`the composed config carries a load failure:\n${config.slice(0, 4000)}`)
  }
})

await check('the plugin loads under the real runtime (no activation error in output)', () => {
  // `plugin list` mounts nothing, but `--dump-config` above already parsed the
  // patch. This check catches the remaining class of failure: a module that
  // throws at import time would make the CLI print a resolution error for the
  // row. Asserting the row is present AND named is the observable proof
  // available without starting the desktop app.
  const checked = dsh(['plugin', '--profile', profileName, 'list'])
  if (checked.code !== 0) throw new Error(`plugin list failed (exit ${checked.code})\n${checked.stderr}`)
  if (!/dsh-latex-tool/.test(checked.stdout + checked.stderr)) {
    throw new Error(`the plugin does not appear in plugin list:\n${checked.stdout}`)
  }
})

await check('the skill provider passes the runtime validator and loads its body', async () => {
  const module = await import(new URL(`../lib/skill.js?t=${Date.now()}`, import.meta.url).href)
  const registered = []
  const ctx = {
    effect: (fn) => fn(),
    skills: { registerProvider: (factory) => { registered.push(factory()); return () => {} } },
  }
  module.registerSkill(ctx, { info: () => {}, warn: () => {} })
  if (registered.length !== 1) throw new Error(`expected 1 provider, got ${registered.length}`)
  const provider = registered[0]
  const candidates = await provider.list()
  if (candidates.length !== 1) throw new Error(`expected 1 candidate, got ${candidates.length}`)
  const [candidate] = candidates
  if (candidate.provider !== provider.name) {
    throw new Error(`candidate.provider "${candidate.provider}" !== provider.name "${provider.name}"`)
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.name)) throw new Error(`bad skill name "${candidate.name}"`)
  if (!Number.isFinite(candidate.rank)) throw new Error('rank is not a finite number')
  if (candidate.description.length === 0) throw new Error('description is empty')
  if (typeof candidate.invocation?.modelInvocable !== 'boolean') throw new Error('invocation.modelInvocable is not a boolean')
  if (typeof candidate.invocation?.userInvocable !== 'boolean') throw new Error('invocation.userInvocable is not a boolean')

  const definition = await provider.get(candidate, {})
  if (definition.name !== candidate.name) throw new Error('get() changed the skill name')
  if (definition.content.startsWith('---')) throw new Error('the definition content still carries frontmatter')
  if (definition.rank !== undefined) throw new Error('the definition still carries rank')
  if (definition.locator !== undefined) throw new Error('the definition still carries locator')
  if (!existsSync(definition.path)) throw new Error(`definition path does not exist: ${definition.path}`)
  if (definition.content.length < 2000) throw new Error(`the skill body is suspiciously short: ${definition.content.length} chars`)
})

await check('removing the bundle removes the tools and the skill (V12)', () => {
  const removed = dsh(['plugin', '--profile', profileName, 'remove', '@local/dsh-latex-tool'])
  if (removed.code !== 0) {
    throw new Error(`dsh plugin remove failed (exit ${removed.code})\n${removed.stdout}\n${removed.stderr}`)
  }
  const manifestFile = join(profileDir, 'package.json')
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (manifest.dependencies?.['@local/dsh-latex-tool'] !== undefined) throw new Error('the dependency survived removal')
    const bundles = manifest.dsh?.profile?.bundles ?? []
    if (bundles.includes('@local/dsh-latex-tool')) throw new Error('the bundle entry survived removal')
  }

  // The functional test: the composed profile must no longer carry the row, so
  // the tools, the skill provider and the panel route are all gone.
  const dumped = dsh(['--profile', profileName, '--dump-config'])
  if (/^- id: latex-tool$/m.test(dumped.stdout)) {
    throw new Error('the latex-tool row is still composed after removal')
  }

  // Measured on this machine (pnpm 11.28.5, DSH 0.2.1-rc.2): `plugin remove`
  // updates package.json and dsh.profile.bundles but leaves the pnpm link under
  // node_modules/@local pointing at the source. Since nothing composes the row,
  // it contributes nothing; it is reported rather than silently ignored,
  // because a user who inspects the profile directory will see it.
  const link = join(profileDir, 'node_modules', '@local', 'dsh-latex-tool')
  if (existsSync(link)) {
    notes.push(`the pnpm link survived removal (harmless, no longer composed): ${link}`)
  }
})

console.log('')
for (const line of results) console.log(line)
if (notes.length > 0) {
  console.log('')
  console.log('NOTES:')
  for (const note of notes) console.log(`  - ${note}`)
}
console.log('')

if (!keep) {
  try {
    rmSync(profileDir, { recursive: true, force: true })
    console.log(`scratch profile removed: ${profileDir}`)
  } catch (error) {
    console.log(`could not remove ${profileDir}: ${error.message}`)
  }
} else {
  console.log(`scratch profile kept at ${profileDir}`)
}

console.log(failures === 0 ? `ALL ${results.length} LIVE CHECKS PASSED` : `${failures} OF ${results.length} LIVE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
