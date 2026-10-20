/**
 * Offline test harness for @local/dsh-latex-tool.
 *
 * Runs the plugin's real code paths against the real TeX installation and a
 * fake Cordis context, so a regression is caught before it reaches the live
 * profile. This mirrors `dsh-gitbash-tool`'s harness in shape and
 * `dsh-mole-tool`'s in depth.
 *
 * Every check here corresponds to an acceptance criterion in the design
 * document (§8). The three that decide whether the plugin has a reason to exist
 * are called out by name:
 *
 *   - V2: an 8.3 short-name temp path must not reach latexmk;
 *   - V3: a project under a non-ASCII path must compile without a decode error;
 *   - V8: a Python without PyMuPDF must degrade to the text tier, not throw.
 *
 * Usage: node test-harness.mjs [--verbose]
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'
import { createService } from './lib/service.js'
import { createTools } from './lib/tools.js'
import { decodeOutput } from './lib/decode.js'
import { illegalTexNameChars, longPath, safeTempRoot } from './lib/paths.js'
import { inferEngine, engineFlag } from './lib/engine.js'
import { parseLog } from './lib/diagnose.js'
import { parsePages } from './lib/verify.js'
import { parseSkill } from './lib/skill.js'

const verbose = process.argv.includes('--verbose')
const results = []
let failures = 0

/**
 * Run one named check.
 * @param name - the check's label.
 * @param fn - the async body; throwing fails the check.
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
 * Build a minimal Cordis-like context that records registrations.
 *
 * `inject` is modelled faithfully: the callback runs only when every declared
 * service is present, and never runs when one is missing. That exact behaviour
 * is what keeps the plugin loadable in a composition without a skill registry.
 *
 * @param options - which optional services exist.
 * @returns the fake context plus its captured registrations.
 */
function fakeContext(options = {}) {
  const captured = { tools: [], routes: [], effects: [], logs: [], injected: [], skills: [], cwdRequests: [] }
  const hasSkills = options.skills !== false
  const hasWebServer = options.webServer !== false
  const ctx = {
    logger: {
      info: (message) => captured.logs.push(['info', message]),
      warn: (message) => captured.logs.push(['warn', message]),
    },
    tools: { register: (tool) => captured.tools.push(tool) },
    effect: (fn) => {
      captured.effects.push(fn)
      return fn()
    },
    get: (name) => {
      if (name === 'skills') return hasSkills ? services.skills : undefined
      if (name === 'workingDirectory') return services.workingDirectory
      return undefined
    },
    inject: (names, callback) => {
      captured.injected.push(names)
      const available = names.every((name) => {
        if (name === 'skills') return hasSkills
        if (name === 'webServer') return hasWebServer
        return false
      })
      if (!available) return undefined
      const child = {
        ...ctx,
        skills: services.skills,
        webServer: services.webServer,
        effect: (fn, label) => {
          captured.effects.push([label, fn])
          return fn()
        },
      }
      return callback(child)
    },
  }

  const services = {
    // Modelled on the real seam: the harness resolves the session cwd through a
    // service keyed by the calling agent, not through a field on the execution
    // context. `ensure` records the call so the test can prove the tool asked
    // for it rather than silently falling back to the process directory.
    workingDirectory: {
      defaultDirectory: options.defaultDirectory ?? process.cwd(),
      async ensure(agent, signal) {
        captured.cwdRequests.push({ agent, aborted: signal?.aborted === true })
        return options.sessionDirectory ?? process.cwd()
      },
    },
    skills: hasSkills
      ? {
          registerProvider: (factory) => {
            captured.skills.push(factory())
            return () => {}
          },
        }
      : undefined,
    webServer: hasWebServer
      ? {
          register: (route) => {
            captured.routes.push(route)
            return () => {}
          },
        }
      : undefined,
  }

  return { ctx, captured }
}

/**
 * Create a scratch project directory under the resolved temp root.
 * @param label - a short label used in the directory name.
 * @returns the absolute directory.
 */
function scratchProject(label) {
  const root = safeTempRoot('')
  const dir = mkdtempSync(join(root.dir, `dsh-latex-test-${label}-`))
  return dir
}

/** Write a .tex file with the given body. */
function writeTex(dir, name, body) {
  const file = join(dir, name)
  writeFileSync(file, body, 'utf8')
  return file
}

const CTEX_DOC = [
  '\\documentclass[UTF8]{ctexart}',
  '\\begin{document}',
  '这是一个中文段落，用于验证编码与字体。ABC 123。',
  '\\end{document}',
  '',
].join('\n')

const created = []

/** Remove every scratch directory this run created. */
function cleanup() {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

process.on('exit', cleanup)

// ---------------------------------------------------------------------------
// Registration (V1 preamble: the plugin must load at all)
// ---------------------------------------------------------------------------

{
  const { ctx, captured } = fakeContext()
  apply(ctx, {})

  await check('plugin registers exactly 3 tools', () => {
    assert.equal(captured.tools.length, 3)
    const names = captured.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['latex_compile', 'latex_doctor', 'latex_verify'])
  })

  await check('every tool has a JSON schema with one scalar type per node', () => {
    for (const tool of captured.tools) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 80, `${tool.name}: description is too short to be useful`)
      assert.equal(tool.parameters.type, 'object')
      assert.deepEqual(tool.parameters.additionalProperties, false)
      assert.ok(Array.isArray(tool.parameters.required))
      assert.equal(tool.output.schema.type, 'object')
      assert.ok(Array.isArray(tool.output.schema.required))
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(typeof tool.presentCall, 'function')
      assert.equal(typeof tool.execute, 'function')
      walkSchema(tool.output.schema, tool.name)
      walkSchema(tool.parameters, tool.name)
    }
  })

  await check('the bundled skill provider is registered and its candidate is valid', async () => {
    assert.equal(captured.skills.length, 1)
    const provider = captured.skills[0]
    assert.equal(provider.name, 'dsh-latex-tool')
    const candidates = await provider.list()
    assert.equal(candidates.length, 1)
    const candidate = candidates[0]
    assert.equal(candidate.name, 'latex-project-workflow')
    assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(candidate.description.length > 100, `description is only ${candidate.description.length} chars`)
    assert.equal(candidate.provider, provider.name, 'candidate.provider must equal provider.name exactly')
    assert.equal(typeof candidate.rank, 'number')
    assert.ok(Number.isFinite(candidate.rank))
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(candidate.resourceBase.kind, 'directory')

    const definition = await provider.get(candidate, {})
    assert.equal(definition.name, 'latex-project-workflow')
    assert.equal(definition.rank, undefined, 'get() must drop rank')
    assert.equal(definition.locator, undefined, 'get() must drop locator')
    assert.ok(!definition.content.startsWith('---'), 'get() must strip the YAML frontmatter')
    assert.ok(definition.content.includes('latex-project-workflow') || definition.content.length > 500)
    assert.equal(typeof definition.path, 'string')
    assert.ok(existsSync(definition.path), `the definition path must exist: ${definition.path}`)
  })

  await check('the skill provider resolves its reference files through resourceBase', async () => {
    const provider = captured.skills[0]
    const [candidate] = await provider.list()
    const base = candidate.resourceBase.path
    assert.ok(existsSync(base), `resourceBase does not exist: ${base}`)
    for (const name of ['compile-recipes.md', 'log-errors.md', 'cjk-and-fonts.md', 'edit-safety.md', 'official-plugin-pitfalls.md']) {
      const file = join(base, 'references', name)
      assert.ok(existsSync(file), `missing reference: ${file}`)
      assert.ok(readFileSync(file, 'utf8').length > 500, `${name} looks empty`)
    }
  })

  await check('the panel route is registered when a web server exists', () => {
    assert.equal(captured.routes.length, 1)
    const route = captured.routes[0]
    assert.equal(route.kind, 'exact')
    assert.equal(route.path, '/plugins/dsh-latex-tool/rpc')
    assert.equal(typeof route.handler, 'function')
  })
}

{
  const { ctx, captured } = fakeContext({ skills: false, webServer: false })
  apply(ctx, {})
  await check('plugin still activates without the skills and webServer services', () => {
    assert.equal(captured.tools.length, 3, 'tools must register even without skills/webServer')
    assert.equal(captured.skills.length, 0)
    assert.equal(captured.routes.length, 0)
  })
}

{
  const { ctx, captured } = fakeContext()
  apply(ctx, { unknownKey: 1, defaultEngine: 'bogus' })
  await check('unknown config keys and bad enum values are warned, not silently applied', () => {
    const warnings = captured.logs.filter(([level]) => level === 'warn').map(([, message]) => message)
    assert.ok(warnings.some((message) => message.includes('unknownKey')), JSON.stringify(warnings))
    assert.ok(warnings.some((message) => message.includes('defaultEngine')), JSON.stringify(warnings))
  })
}

/**
 * Assert the strict schema subset the harness accepts: exactly one scalar
 * `type` per node, `oneOf` for nullability, no `type: [...]` arrays.
 * @param node - the schema node.
 * @param label - the tool name, for messages.
 */
function walkSchema(node, label) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node.oneOf)) {
    assert.ok(node.type === undefined, `${label}: a node with oneOf must not also carry type`)
    for (const branch of node.oneOf) walkSchema(branch, label)
  }
  if (node.type !== undefined) {
    assert.equal(typeof node.type, 'string', `${label}: type must be a single string, not ${JSON.stringify(node.type)}`)
  }
  if (node.properties !== undefined) {
    assert.equal(typeof node.properties, 'object')
    for (const child of Object.values(node.properties)) walkSchema(child, label)
  }
  if (node.items !== undefined) walkSchema(node.items, label)
}

// ---------------------------------------------------------------------------
// Decoding (F2 / V3)
// ---------------------------------------------------------------------------

await check('decodeOutput picks GBK when the bytes are GBK', () => {
  // "不存在的章节" encoded as GBK — what latexmk writes to stderr on this machine.
  const gbk = Buffer.from([0xb2, 0xbb, 0xb4, 0xe6, 0xd4, 0xda, 0xb5, 0xc4, 0xd5, 0xc2, 0xbd, 0xda])
  const decoded = decodeOutput(gbk)
  assert.equal(decoded.encoding, 'gbk')
  assert.equal(decoded.text, '不存在的章节')
})

await check('decodeOutput keeps UTF-8 when the bytes are UTF-8', () => {
  const decoded = decodeOutput(Buffer.from('不存在的章节', 'utf8'))
  assert.equal(decoded.encoding, 'utf-8')
  assert.equal(decoded.text, '不存在的章节')
})

await check('decodeOutput honours an explicit utf-8 preference', () => {
  const decoded = decodeOutput(Buffer.from('中文', 'utf8'), 'utf-8')
  assert.equal(decoded.text, '中文')
})

// ---------------------------------------------------------------------------
// Paths (F1 / V2)
// ---------------------------------------------------------------------------

await check('longPath resolves the 8.3 short name in TEMP', () => {
  const raw = tmpdir()
  const resolved = longPath(raw)
  assert.ok(!resolved.includes('~'), `longPath left a "~" in ${resolved}`)
  assert.ok(existsSync(resolved), `${resolved} does not exist`)
  if (verbose) console.log(`        raw=${raw}\n        resolved=${resolved}`)
})

await check('safeTempRoot reports whether the short name was fixed', () => {
  const root = safeTempRoot('')
  assert.ok(!illegalTexNameChars(root.dir).length, `unsafe temp dir: ${root.dir}`)
  if (root.raw !== root.resolved) assert.equal(root.shortNameFixed, true)
})

await check('the short-name rule catches "~" exactly like latexmk does', () => {
  assert.deepEqual(illegalTexNameChars('C:/Users/ANKLEC~1/AppData/Local/Temp'), ['~'])
  assert.deepEqual(illegalTexNameChars('C:/Users/ankle crusher/AppData/Local/Temp'), [])
  assert.deepEqual(illegalTexNameChars('E:/研究生/论文/大论文'), [])
})

// ---------------------------------------------------------------------------
// Engine inference (V4 / V5)
// ---------------------------------------------------------------------------

{
  const dir = scratchProject('engine')
  created.push(dir)

  const ctex = writeTex(dir, 'ctex.tex', '\\documentclass[UTF8]{ctexart}\n\\begin{document}\nx\n\\end{document}\n')
  const english = writeTex(dir, 'en.tex', '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n')
  const fontspec = writeTex(
    dir,
    'fs.tex',
    '\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nx\n\\end{document}\n',
  )
  const lua = writeTex(dir, 'lua.tex', '\\documentclass{article}\n\\usepackage{luacode}\n\\begin{document}\nx\n\\end{document}\n')
  const magic = writeTex(
    dir,
    'magic.tex',
    '% !TEX program = lualatex\n\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n',
  )
  const cjkMacro = writeTex(
    dir,
    'macro.tex',
    '\\documentclass{book}\n\\setCJKmainfont{SimSun}\n\\begin{document}\nx\n\\end{document}\n',
  )

  await check('ctexart infers xelatex (the official plugin gets this wrong)', () => {
    const choice = inferEngine(ctex)
    assert.equal(choice.engine, 'xelatex')
    assert.equal(choice.source, 'documentclass')
  })

  await check('plain article infers pdflatex', () => {
    assert.equal(inferEngine(english).engine, 'pdflatex')
  })

  await check('fontspec infers xelatex', () => {
    assert.equal(inferEngine(fontspec).engine, 'xelatex')
    assert.equal(inferEngine(fontspec).source, 'package')
  })

  await check('luacode infers lualatex', () => {
    assert.equal(inferEngine(lua).engine, 'lualatex')
  })

  await check('% !TEX program beats everything else', () => {
    assert.equal(inferEngine(magic).engine, 'lualatex')
    assert.equal(inferEngine(magic).source, 'magic-program')
  })

  await check('an explicit engine argument wins', () => {
    assert.equal(inferEngine(ctex, { explicit: 'pdflatex' }).engine, 'pdflatex')
    assert.equal(inferEngine(ctex, { explicit: 'pdflatex' }).source, 'explicit')
  })

  await check('a CJK font macro infers xelatex', () => {
    assert.equal(inferEngine(cjkMacro).engine, 'xelatex')
    assert.equal(inferEngine(cjkMacro).source, 'macro')
  })

  await check('engine flags map to the flags latexmk needs', () => {
    assert.equal(engineFlag('xelatex'), '-xelatex')
    assert.equal(engineFlag('lualatex'), '-lualatex')
    assert.equal(engineFlag('pdflatex'), '-pdf')
  })
}

// ---------------------------------------------------------------------------
// Log parsing (V6 / V7 / V9)
// ---------------------------------------------------------------------------

await check('parseLog reads a real -file-line-error line', () => {
  const log = [
    '(./main.tex',
    'LaTeX2e <2026-06-01>',
    './bad.tex:4: Undefined control sequence.',
    'l.4 \\undefinedcommand',
    '                     ',
    'The control sequence at the end of the top line',
    '',
  ].join('\n')
  const findings = parseLog(log, { exitCode: 12 })
  assert.equal(findings.errors.length, 1)
  assert.equal(findings.errors[0].file, './bad.tex')
  assert.equal(findings.errors[0].line, 4)
  assert.equal(findings.errors[0].message, 'Undefined control sequence.')
  assert.ok(findings.errors[0].detail.includes('control sequence'))
  assert.equal(findings.failed, true)
})

await check('parseLog joins the wrapped Missing character line', () => {
  // Copied verbatim from a measured log: the font descriptor wraps at ~79 cols.
  const log = [
    'Missing character: There is no 𠀀 (U+20000) in font SimSun/OT:script=hani;langua',
    'ge=dflt;!',
    'Missing character: There is no 😀 (U+1F600) in font [lmroman10-regular]:mapping=',
    'tex-text;!',
  ].join('\n')
  const findings = parseLog(log, { exitCode: 0 })
  assert.equal(findings.missingGlyphs.length, 2)
  const rare = findings.missingGlyphs.find((glyph) => glyph.code === 'U+20000')
  assert.ok(rare !== undefined, JSON.stringify(findings.missingGlyphs))
  assert.equal(rare.char, '𠀀')
  assert.ok(rare.font.includes('SimSun'), rare.font)
  const emoji = findings.missingGlyphs.find((glyph) => glyph.code === 'U+1F600')
  assert.ok(emoji !== undefined)
  assert.ok(emoji.font.includes('lmroman10-regular'), emoji.font)
})

await check('parseLog finds undefined citations and references', () => {
  const log = [
    "LaTeX Warning: Citation 'nokey' on page 1 undefined on input line 7.",
    "LaTeX Warning: Reference `nolabel' on page 1 undefined on input line 7.",
  ].join('\n')
  const findings = parseLog(log)
  assert.deepEqual(findings.missingCitations.map((entry) => entry.key), ['nokey'])
  assert.deepEqual(findings.missingReferences.map((entry) => entry.label), ['nolabel'])
})

await check('parseLog distinguishes "backend ran" from "please rerun"', () => {
  const notRun = parseLog('Package biblatex Warning: Please (re)run Biber on the file:\n (biblatex)                main.\n')
  assert.equal(notRun.backendRan, false)
  const ran = parseLog('Latexmk: applying rule \'biber main\'...\nINFO - This is Biber 2.21\n')
  assert.equal(ran.backendRan, true)
})

await check('parseLog reads overfull boxes without treating them as errors', () => {
  const findings = parseLog('Overfull \\hbox (690.0pt too wide) in paragraph at lines 3--4\n')
  assert.equal(findings.overfull.length, 1)
  assert.equal(findings.overfull[0].amountPt, 690)
  assert.equal(findings.overfull[0].line, 3)
  assert.equal(findings.failed, false)
})

await check('parseLog identifies the engine banner', () => {
  assert.equal(parseLog('This is XeTeX, Version 3.14').engineUsed, 'xelatex')
  assert.equal(parseLog('This is pdfTeX, Version 3.14').engineUsed, 'pdflatex')
  assert.equal(parseLog('This is LuaTeX, Version 1.0').engineUsed, 'lualatex')
})

// ---------------------------------------------------------------------------
// Page specification
// ---------------------------------------------------------------------------

await check('parsePages handles ranges, lists and clamping', () => {
  assert.deepEqual(parsePages('1-3', 10), [1, 2, 3])
  assert.deepEqual(parsePages('1,4,7-9', 10), [1, 4, 7, 8, 9])
  assert.deepEqual(parsePages('8-20', 10), [8, 9, 10])
  assert.deepEqual(parsePages('0-2', 10), [1, 2])
})

// ---------------------------------------------------------------------------
// The skill frontmatter parser
// ---------------------------------------------------------------------------

await check('parseSkill handles a plain single-line description', () => {
  const raw = '---\nname: x\ndescription: a plain description\n---\n\n# Body\n'
  const parsed = parseSkill(raw, 'test')
  assert.equal(parsed.description, 'a plain description')
  assert.equal(parsed.content, '# Body')
})

await check('parseSkill handles a | block description (the regex-reader trap)', () => {
  const raw = '---\nname: x\ndescription: |\n  first line\n  second line\n---\n\n# Body\n'
  const parsed = parseSkill(raw, 'test')
  assert.equal(parsed.description, 'first line\nsecond line')
  assert.notEqual(parsed.description, '|')
})

await check('parseSkill rejects a file with no description', () => {
  assert.throws(() => parseSkill('---\nname: x\n---\nbody\n', 'test'), /no description/)
})

// ---------------------------------------------------------------------------
// The real toolchain (V1 / V2 / V3 / V4 / V6 / V9)
// ---------------------------------------------------------------------------

const service = createService({}, { info: () => {}, warn: () => {} })

let doctor = null
await check('latex_doctor reports a ready environment with evidence', async () => {
  doctor = await service.doctor({})
  if (verbose) console.log(`        status=${doctor.status} bin=${doctor.texBin} latexmk=${doctor.latexmkVersion}`)
  assert.equal(doctor.status, 'ready', `status was ${doctor.status}; checks: ${JSON.stringify(doctor.checks)}`)
  assert.ok(doctor.texBin.length > 0)
  assert.equal(doctor.latexmkVersion, '4.88', `latexmk version read as "${doctor.latexmkVersion}" (perl warning not skipped?)`)
  assert.ok(doctor.engines.some((engine) => engine.name === 'xelatex' && engine.present))
  assert.ok(doctor.packages.some((entry) => entry.name === 'ctex' && entry.found), 'ctex not found')
  assert.ok(doctor.packages.some((entry) => entry.name === 'biblatex-gb7714-2015' && entry.found), 'gb7714 not found')
  assert.equal(doctor.python.hasPyMuPDF, true, 'system Python should have PyMuPDF on this machine')
  assert.equal(doctor.pdfTextTier, 'full')
  assert.ok(!doctor.tempResolved.includes('~'), `temp dir still short-named: ${doctor.tempResolved}`)
  assert.equal(doctor.smoke.ran, false)
})

await check('latex_doctor smoke test compiles a ctex document (V1/V2)', async () => {
  const withSmoke = await service.doctor({ smoke: true })
  assert.equal(withSmoke.smoke.ran, true)
  assert.equal(withSmoke.smoke.ok, true, withSmoke.smoke.detail)
  assert.equal(withSmoke.status, 'ready')
})

let compiled = null
await check('latex_compile builds a ctex project under a non-ASCII path (V3/V4)', async () => {
  const projectRoot = scratchProject('中文路径')
  created.push(projectRoot)
  const projectDir = join(projectRoot, '论文项目')
  mkdirSync(projectDir, { recursive: true })
  writeTex(projectDir, 'main.tex', CTEX_DOC)

  compiled = await service.compile({ file: join(projectDir, 'main.tex') })
  if (verbose) {
    console.log(`        engine=${compiled.engine} (${compiled.engineSource}) exit=${compiled.exitCode} pdf=${compiled.pdfPath}`)
  }
  assert.equal(compiled.engine, 'xelatex', `inferred ${compiled.engine} via ${compiled.engineSource}`)
  assert.equal(compiled.exitCode, 0, `exit ${compiled.exitCode}: ${compiled.headline}`)
  assert.ok(compiled.pdfPath.length > 0, 'no PDF produced')
  assert.ok(existsSync(compiled.pdfPath), compiled.pdfPath)
  assert.equal(compiled.norc, true)
  assert.ok(compiled.argv.includes('-xelatex'))
  assert.equal(compiled.findings.missingGlyphs.length, 0)
  assert.ok(!compiled.warnings.some((warning) => warning.includes('could not be decoded')), JSON.stringify(compiled.warnings))
})

await check('latex_compile reports file/line/message for a syntax error (V6)', async () => {
  const dir = scratchProject('badsyntax')
  created.push(dir)
  const file = writeTex(
    dir,
    'bad.tex',
    '\\documentclass[UTF8]{ctexart}\n\\begin{document}\n中文\n\\undefinedcommand\n\\end{document}\n',
  )
  const result = await service.compile({ file })
  assert.notEqual(result.exitCode, 0, 'a broken document must not exit 0')
  assert.ok(result.findings.errors.length > 0, `no parsed errors; headline: ${result.headline}`)
  const first = result.findings.errors[0]
  assert.equal(first.line, 4, `error reported at line ${first.line}, message: ${first.message}`)
  assert.ok(/Undefined control sequence/i.test(first.message), first.message)
  assert.equal(result.ok, false)
})

let bib = null
await check('latex_compile runs biber for a biblatex project (V9)', async () => {
  const dir = scratchProject('biber')
  created.push(dir)
  writeTex(
    dir,
    'main.tex',
    [
      '\\documentclass[UTF8]{ctexart}',
      '\\usepackage[backend=biber,style=gb7714-2015]{biblatex}',
      '\\addbibresource{refs.bib}',
      '\\begin{document}',
      '中文正文，引用 \\cite{ref1}。',
      '\\printbibliography',
      '\\end{document}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(dir, 'refs.bib'),
    '@book{ref1,\n  author = {张三},\n  title = {测试图书},\n  year = {2020},\n  publisher = {某出版社}\n}\n',
    'utf8',
  )
  bib = await service.compile({ file: join(dir, 'main.tex') })
  assert.equal(bib.exitCode, 0, `exit ${bib.exitCode}: ${bib.headline}`)
  assert.equal(bib.bibliography, 'biber')
  assert.equal(bib.findings.backendRan, true, 'biber did not run')
  assert.equal(bib.findings.missingCitations.length, 0)
})

// ---------------------------------------------------------------------------
// Verification (V7 / V8)
// ---------------------------------------------------------------------------

await check('latex_verify reaches the full tier on a clean PDF (V7 baseline)', async () => {
  assert.ok(compiled !== null, 'no compile to verify')
  const verified = await service.verify({ pdf: compiled.pdfPath })
  if (verbose) console.log(`        capability=${verified.capability} pages=${verified.pages} cjk=${verified.perPageCjk}`)
  assert.equal(verified.capability, 'full')
  assert.equal(verified.verifyTool, 'pymupdf')
  assert.ok(verified.pages > 0)
  assert.ok(verified.perPageCjk.some((count) => count > 0), 'no Chinese counted in a Chinese document')
  assert.deepEqual(verified.blankPages, [])
  assert.equal(verified.missingGlyphCount, 0)
})

await check('latex_verify detects a rare CJK codepoint the font cannot draw (V7)', async () => {
  const dir = scratchProject('glyph')
  created.push(dir)
  const file = writeTex(
    dir,
    'main.tex',
    [
      '\\documentclass[UTF8]{ctexart}',
      '\\begin{document}',
      '中文正文，含一个生僻字：𠀀 结束。',
      '\\end{document}',
      '',
    ].join('\n'),
  )
  const built = await service.compile({ file })
  assert.equal(built.exitCode, 0)
  // The log must already report it as a missing glyph.
  assert.ok(built.findings.missingGlyphs.length > 0, 'the log did not report the missing character')
  const verified = await service.verify({ pdf: built.pdfPath })
  assert.ok(verified.missingGlyphCount > 0, `verification missed the tofu (capability ${verified.capability})`)
  assert.ok(
    verified.findings.some((finding) => /glyph/i.test(finding)),
    JSON.stringify(verified.findings),
  )
})

await check('latex_verify renders PNGs on request and reports their paths', async () => {
  assert.ok(compiled !== null)
  const rendered = await service.verify({ pdf: compiled.pdfPath, render: true, pages: '1', dpi: 80 })
  assert.equal(rendered.capability, 'full')
  assert.ok(rendered.rendered.length > 0, 'render:true produced no PNG')
  for (const path of rendered.rendered) assert.ok(existsSync(path), `missing PNG: ${path}`)
  assert.deepEqual(rendered.pagesRendered, [1])
})

await check('latex_verify honours expectCjk=false for a Latin document', async () => {
  const dir = scratchProject('latin')
  created.push(dir)
  const file = writeTex(dir, 'en.tex', '\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n')
  const built = await service.compile({ file })
  assert.equal(built.exitCode, 0)
  const withoutCjk = await service.verify({ pdf: built.pdfPath, expectCjk: false })
  assert.ok(!withoutCjk.findings.some((finding) => /zero CJK|non-CJK/i.test(finding)), JSON.stringify(withoutCjk.findings))
})

await check('latex_verify degrades to the text tier when PyMuPDF is absent (V8)', async () => {
  assert.ok(compiled !== null)
  // The DSH-shipped Python 3.12 has no PyMuPDF; it is the honest way to
  // exercise the fallback without uninstalling anything.
  const dshPython = join(
    process.env.USERPROFILE ?? '',
    '.dsh',
    'dsh-runtimes',
    'dsh-primary-runtime',
    'dependencies',
    'python',
    'python.exe',
  )
  if (!existsSync(dshPython)) {
    // Not an environment that has one: say so instead of pretending it passed.
    console.log(`        SKIP  (no DSH Python at ${dshPython}; the fallback path is covered by the unit checks)`)
    return
  }
  const fallback = createService({ pythonPath: dshPython }, { info: () => {}, warn: () => {} })
  const verified = await fallback.verify({ pdf: compiled.pdfPath })
  if (verbose) console.log(`        capability=${verified.capability} tool=${verified.verifyTool} pages=${verified.pages}`)
  assert.equal(verified.capability, 'text', `expected the text tier, got ${verified.capability} via ${verified.verifyTool}`)
  assert.equal(verified.verifyTool, 'pdftotext')
  assert.ok(verified.pages > 0, 'the text tier could not count pages')
  assert.ok(verified.perPageCjk.some((count) => count > 0), 'the text tier lost the Chinese text (missing -enc UTF-8?)')
  assert.ok(verified.warnings.length > 0, 'the degradation must be reported, not silent')
})

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

await check('every tool render() produces non-empty text for a real result', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const byName = Object.fromEntries(captured.tools.map((tool) => [tool.name, tool]))
  const doctorValue = await byName.latex_doctor.execute({}, { agent: { id: 'test-agent' }, signal: undefined })
  const doctorText = byName.latex_doctor.output.render({}, doctorValue)
  assert.equal(doctorText[0].type, 'text')
  assert.ok(doctorText[0].text.includes('LaTeX environment'), doctorText[0].text)
  assert.ok(Object.keys(doctorValue).length > 10)
})

await check('latex_compile reports a missing file instead of throwing', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const tool = captured.tools.find((entry) => entry.name === 'latex_compile')
  const value = await tool.execute({ file: 'E:/definitely/not/here.tex' }, { agent: { id: 'test-agent' }, signal: undefined })
  assert.equal(value.ok, false)
  assert.ok(value.error.length > 0)
  const text = tool.output.render({}, value)[0].text
  assert.ok(text.includes('BUILD NOT RUN'), text)
})

await check('a relative path is resolved against the session working directory, not the process cwd', async () => {
  // The bug this guards: the harness does not put `cwd` on the execution input,
  // so a tool that reads `exec.cwd` gets undefined and resolves relative paths
  // against the desktop app's own directory. "Compile main.tex" would then fail
  // for a file the user is looking at. The cwd is a service call.
  const projectDir = scratchProject('relcwd')
  created.push(projectDir)
  writeTex(projectDir, 'main.tex', CTEX_DOC)

  const { ctx, captured } = fakeContext({ sessionDirectory: projectDir })
  apply(ctx, {})
  const tool = captured.tools.find((entry) => entry.name === 'latex_compile')

  const value = await tool.execute({ file: 'main.tex' }, { agent: { id: 'test-agent' }, signal: undefined })
  assert.ok(captured.cwdRequests.length > 0, 'the tool never asked the workingDirectory service for the session cwd')
  assert.equal(value.texFile, join(projectDir, 'main.tex'), `resolved against the wrong directory: ${value.texFile}`)
  assert.equal(value.ok, true, `compile failed: ${value.error || value.headline}`)
  assert.ok(value.pdfPath.startsWith(projectDir.replace(/\\/g, '/')) || value.pdfPath.startsWith(projectDir), value.pdfPath)

  // The verify side must resolve the same way, given the pdfPath the compile reported.
  const verifyTool = captured.tools.find((entry) => entry.name === 'latex_verify')
  const verified = await verifyTool.execute(
    { pdf: '.latex-build/main.pdf' },
    { agent: { id: 'test-agent' }, signal: undefined },
  )
  assert.equal(verified.error, '', `verify could not find the PDF: ${verified.error}`)
  assert.equal(verified.capability, 'full')
  assert.ok(verified.pages > 0)
})

await check('latex_verify reports a missing PDF instead of throwing', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const tool = captured.tools.find((entry) => entry.name === 'latex_verify')
  const value = await tool.execute({ pdf: 'E:/definitely/not/here.pdf' }, { agent: { id: 'test-agent' }, signal: undefined })
  assert.equal(value.pages, 0)
  assert.ok(value.error.length > 0)
  assert.equal(value.capability, 'minimal')
})

// ---------------------------------------------------------------------------
// Every tool result must survive the harness's JSON validator
// ---------------------------------------------------------------------------

/**
 * Verbatim reimplementation of the harness's `visitJsonValue` / `snapshotJsonValue`
 * acceptance test (read out of the shipped runtime). A tool result that fails
 * this is rejected outright with "value is not lossless JSON", so the model sees
 * a tool crash instead of the actionable error the tool had prepared.
 *
 * The rules, all of which have bitten this plugin at least once:
 *   - `undefined` anywhere is unrepresentable (the real incident: a failure
 *     branch omitted `pdfBytes`);
 *   - objects must have `Object.prototype` or `null` as prototype;
 *   - arrays must have `Array.prototype` and no extra own keys;
 *   - no `NaN`, `Infinity`, or `-0`;
 *   - no cycles, no symbol keys, no non-enumerable own properties.
 *
 * @param value - the candidate tool result.
 * @returns the first violation, or null when the value is acceptable.
 */
function losslessViolation(value) {
  const visit = (node, ancestors, path) => {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return null
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) return `${path}: non-finite number ${node}`
      if (Object.is(node, -0)) return `${path}: negative zero`
      return null
    }
    if (typeof node !== 'object') return `${path}: typeof ${typeof node}`
    if (ancestors.has(node)) return `${path}: reference cycle`
    ancestors.add(node)
    try {
      if (Array.isArray(node)) {
        if (Object.getPrototypeOf(node) !== Array.prototype) return `${path}: array prototype is not Array.prototype`
        if (Reflect.ownKeys(node).length !== node.length + 1) return `${path}: array carries extra own keys`
        for (let index = 0; index < node.length; index += 1) {
          if (!Object.hasOwn(node, index)) return `${path}[${index}]: array hole`
          const violation = visit(node[index], ancestors, `${path}[${index}]`)
          if (violation !== null) return violation
        }
        return null
      }
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null) {
        return `${path}: prototype is ${prototype?.constructor?.name ?? 'exotic'}`
      }
      for (const key of Reflect.ownKeys(node)) {
        if (typeof key !== 'string') return `${path}: symbol key`
        if (Object.getOwnPropertyDescriptor(node, key)?.enumerable !== true) return `${path}.${key}: non-enumerable`
        const violation = visit(Reflect.get(node, key), ancestors, `${path}.${key}`)
        if (violation !== null) return violation
      }
      return null
    } finally {
      ancestors.delete(node)
    }
  }
  return visit(value, new Set(), '$')
}

await check('every tool result passes the harness JSON validator, including failure paths', async () => {
  const { ctx, captured } = fakeContext()
  apply(ctx, {})
  const byName = Object.fromEntries(captured.tools.map((tool) => [tool.name, tool]))
  const exec = { agent: { id: 'test-agent' }, signal: undefined }

  // Success shapes, taken from a real build and a real verification.
  assert.ok(compiled !== null, 'no compile result available')
  const doctorValue = await byName.latex_doctor.execute({}, exec)
  const verifyValue = await byName.latex_verify.execute({ pdf: compiled.pdfPath }, exec)
  const compileValue = await byName.latex_compile.execute({ file: compiled.texFile }, exec)

  const cases = [
    ['latex_doctor success', doctorValue],
    ['latex_verify success', verifyValue],
    ['latex_compile success', compileValue],
    // Failure paths: the class of bug that produced "value is not lossless JSON".
    ['latex_compile missing file', await byName.latex_compile.execute({ file: 'E:/nope/missing.tex' }, exec)],
    ['latex_verify missing pdf', await byName.latex_verify.execute({ pdf: 'E:/nope/missing.pdf' }, exec)],
    ['latex_verify unreadable pdf', await byName.latex_verify.execute({ pdf: 'package.json' }, exec)],
  ]

  for (const [label, value] of cases) {
    const violation = losslessViolation(value)
    assert.equal(violation, null, `${label}: ${violation}`)
    // The harness also validates against the declared schema, so every required
    // key must be present — a missing key is what `undefined` looked like.
    const tool = captured.tools.find((entry) => label.startsWith(entry.name))
    assert.ok(tool !== undefined, `no tool for ${label}`)
    for (const key of tool.output.schema.required) {
      assert.ok(Object.hasOwn(value, key), `${label}: required key "${key}" is absent from the result`)
    }
  }
})

await check('the JSON validator itself rejects the shapes it is supposed to', () => {
  // Mutation test: prove the guard above has teeth.
  assert.notEqual(losslessViolation({ a: undefined }), null)
  assert.notEqual(losslessViolation({ a: Number.NaN }), null)
  assert.notEqual(losslessViolation({ a: -0 }), null)
  assert.notEqual(losslessViolation(new Map()), null)
  assert.notEqual(losslessViolation([1, , 3]), null)
  assert.equal(losslessViolation({ a: [1, 2, { b: null }] }), null)
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('')
for (const line of results) console.log(line)
console.log('')
if (doctor !== null) {
  console.log(`environment: ${doctor.status} · TeX ${doctor.texVersion} · latexmk ${doctor.latexmkVersion} · PDF tier ${doctor.pdfTextTier}`)
}
if (compiled !== null) {
  console.log(`sample build: ${compiled.engine} (${compiled.engineSource}) exit ${compiled.exitCode} in ${compiled.durationMs} ms`)
}
console.log('')
console.log(failures === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failures} OF ${results.length} CHECK(S) FAILED`)
cleanup()
process.exit(failures === 0 ? 0 : 1)
