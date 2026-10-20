/**
 * Tool registrations: `latex_compile`, `latex_verify`, `latex_doctor`.
 *
 * Three tools, not five, and the omissions are deliberate:
 *
 *   - no `latex_clean` — `latexmk -c` is one shell command and does not deserve
 *     a permanent schema in every request;
 *   - no `latex_bib` — bibliography completion belongs to a citation plugin;
 *   - no `latex_edit` — editing is a general file operation.
 *
 * The value in each tool is the part a shell command cannot give: the engine
 * decision with its evidence, a structured log interpretation, and a PDF check
 * that names what is wrong instead of reporting `pdfExists`.
 *
 * Schema constraints from the harness: every node carries exactly one scalar
 * `type`, nullability goes through `oneOf`, and `output.render` returns
 * content blocks. Nullable values are reported as empty strings / zero rather
 * than null where a null would only add noise for the model.
 *
 * @module @local/dsh-latex-tool/lib/tools
 */

/** Cap on how many log excerpts reach the model's context. */
const MAX_ERRORS = 8
/** Cap on missing-glyph rows returned. */
const MAX_GLYPHS = 12
/** Cap on warnings returned. */
const MAX_WARNINGS = 12

/**
 * Build the tool definitions.
 *
 * @param service - the LaTeX service from `createService`.
 * @param deps - logger and approval seam, injected by the plugin entry.
 * @returns the tool definitions to register.
 */
export function createTools(service, deps = {}) {
  const { logger } = deps

  return [
    {
      name: 'latex_compile',
      description:
        'Compile a LaTeX project with latexmk and return a structured result: the engine that was chosen and why, '
        + 'the exit code and duration, the PDF path, and a parsed error list (file/line/message) rather than a wall '
        + 'of log text. The engine is inferred from % !TEX program, then the document class (ctex* → xelatex), then '
        + 'packages (fontspec/xeCJK → xelatex, luacode → lualatex), so a Chinese thesis builds with XeLaTeX without '
        + 'being told. Paths are resolved past the Windows 8.3 short name and output is decoded from both UTF-8 and '
        + 'GBK, so a project under a non-ASCII path compiles instead of crashing. Runs with -norc by default; when '
        + 'that ignores a project latexmkrc the result says so. A successful compile is NOT proof the document is '
        + 'correct — call latex_verify on the PDF next.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description:
              'The .tex file to compile, or a directory containing it (main.tex/thesis.tex/… are preferred, or a '
              + 'single .tex). Relative paths resolve against the session working directory.',
          },
          engine: {
            type: 'string',
            enum: ['pdflatex', 'xelatex', 'lualatex'],
            description:
              'Force the engine. Omit to infer it from the source (recommended: ctex/fontspec projects need '
              + 'xelatex, and the wrong engine can still exit 0 while dropping glyphs).',
          },
          outDir: {
            type: 'string',
            enum: ['project', 'temp'],
            description:
              'Where to write build output. "project" (default) uses <project>/.latex-build/ so the build cannot be '
              + 'confused with a stale PDF beside the source; "temp" uses a directory under the system temp dir.',
          },
          timeoutMs: {
            type: 'integer',
            description: 'Deadline in milliseconds (default 180000, maximum 900000). The process tree is killed on expiry.',
          },
        },
        required: ['file'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', description: 'True when the build exited 0 AND produced a PDF.' },
            texFile: { type: 'string', description: 'Absolute path of the compiled .tex file.' },
            engine: { type: 'string', description: 'Engine used: pdflatex, xelatex or lualatex.' },
            engineSource: {
              type: 'string',
              description: 'Why that engine: explicit | magic-program | latexmkrc | documentclass | package | macro | default.',
            },
            engineObserved: { type: 'string', description: 'Engine banner actually seen in the log, when one was printed.' },
            bibliography: { type: 'string', description: 'Bibliography backend the source asks for: biber, bibtex, or empty.' },
            exitCode: {
              oneOf: [{ type: 'integer' }, { type: 'null' }],
              description: 'latexmk exit code, or null when killed by a signal.',
            },
            durationMs: { type: 'integer', description: 'Wall-clock duration of the build.' },
            norc: { type: 'boolean', description: 'True when latexmk ran with -norc (the project latexmkrc was ignored).' },
            outputDir: { type: 'string', description: 'Directory the build wrote into.' },
            logPath: { type: 'string', description: 'The .log file, or empty when the engine produced none.' },
            pdfPath: { type: 'string', description: 'The produced PDF, or empty when none was produced.' },
            pdfBytes: { type: 'integer', description: 'Size of the produced PDF in bytes, 0 when absent.' },
            pdfAgeSeconds: {
              oneOf: [{ type: 'integer' }, { type: 'null' }],
              description: 'Age of the PDF in seconds at the end of the build; a large value means a stale file.',
            },
            headline: { type: 'string', description: 'One-sentence summary of what to fix, if anything.' },
            errors: {
              type: 'array',
              description: 'Hard errors in order, so the first entry is the one to fix.',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string', description: 'File the error was reported against, when known.' },
                  line: {
                    oneOf: [{ type: 'integer' }, { type: 'null' }],
                    description: 'Line number, when reported.',
                  },
                  message: { type: 'string', description: 'The error headline.' },
                  detail: { type: 'string', description: 'The explanatory lines TeX printed under the headline.' },
                },
                required: ['file', 'line', 'message', 'detail'],
                additionalProperties: false,
              },
            },
            missingGlyphs: {
              type: 'array',
              description: 'Characters the chosen font could not draw (the PDF shows blanks or tofu for them).',
              items: {
                type: 'object',
                properties: {
                  char: { type: 'string', description: 'The character.' },
                  code: { type: 'string', description: 'Its codepoint, e.g. U+20000.' },
                  font: { type: 'string', description: 'The font that lacked it.' },
                  count: { type: 'integer', description: 'How many times it was dropped.' },
                },
                required: ['char', 'code', 'font', 'count'],
                additionalProperties: false,
              },
            },
            missingCitations: {
              type: 'array',
              description: 'Citation keys the bibliography did not resolve.',
              items: { type: 'string', description: 'A citation key.' },
            },
            missingReferences: {
              type: 'array',
              description: 'Labels referenced but never defined.',
              items: { type: 'string', description: 'A label name.' },
            },
            missingPackages: {
              type: 'array',
              description: 'Package or class files TeX could not find.',
              items: { type: 'string', description: 'A file name, e.g. somestyle.sty.' },
            },
            overfull: {
              type: 'array',
              description: 'Overfull boxes (layout overflow, not build failures).',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', description: 'hbox or vbox.' },
                  amountPt: { type: 'number', description: 'How far it overflows, in points.' },
                  line: {
                    oneOf: [{ type: 'integer' }, { type: 'null' }],
                    description: 'Source line, when named.',
                  },
                },
                required: ['kind', 'amountPt', 'line'],
                additionalProperties: false,
              },
            },
            findingsWarnings: {
              type: 'array',
              description: 'Warning lines from the LaTeX log (not the same as the run-level warnings field).',
              items: { type: 'string', description: 'One log warning.' },
            },
            backendRan: { type: 'boolean', description: 'True when biber/bibtex actually executed during this build.' },
            timedOut: { type: 'boolean', description: 'True when the deadline killed the build.' },
            truncated: { type: 'boolean', description: 'True when captured output hit the byte cap.' },
            encoding: {
              type: 'object',
              description: 'Which decoder each stream needed: utf-8 or gbk.',
              properties: {
                stdout: { type: 'string', description: 'Decoder used for stdout.' },
                stderr: { type: 'string', description: 'Decoder used for stderr.' },
              },
              required: ['stdout', 'stderr'],
              additionalProperties: false,
            },
            warnings: {
              type: 'array',
              description: 'Run-level remarks (ignored latexmkrc, killed build, stale PDF, …).',
              items: { type: 'string', description: 'One remark.' },
            },
            stdoutTail: { type: 'string', description: 'Tail of latexmk stdout, for evidence.' },
            stderrTail: { type: 'string', description: 'Tail of latexmk stderr, for evidence.' },
            error: { type: 'string', description: 'A setup failure (file missing, output dir unwritable), else empty.' },
          },
          required: [
            'ok', 'texFile', 'engine', 'engineSource', 'engineObserved', 'bibliography', 'exitCode', 'durationMs',
            'norc', 'outputDir', 'logPath', 'pdfPath', 'pdfBytes', 'pdfAgeSeconds', 'headline', 'errors',
            'missingGlyphs', 'missingCitations', 'missingReferences', 'missingPackages', 'overfull',
            'findingsWarnings', 'backendRan', 'timedOut', 'truncated', 'encoding', 'warnings', 'stdoutTail',
            'stderrTail', 'error',
          ],
          additionalProperties: false,
        },
        render(args, value) {
          const lines = []
          const status = value.ok ? 'BUILD OK' : value.error.length > 0 ? 'BUILD NOT RUN' : 'BUILD FAILED'
          lines.push(`${status} · ${value.engine} (${value.engineSource}) · ${value.durationMs} ms · exit ${value.exitCode ?? 'killed'}`)
          lines.push(`file: ${value.texFile}`)
          if (value.pdfPath.length > 0) {
            lines.push(`pdf:  ${value.pdfPath} (${value.pdfBytes} bytes${value.pdfAgeSeconds !== null ? `, ${value.pdfAgeSeconds}s old` : ''})`)
          } else {
            lines.push('pdf:  (none produced)')
          }
          if (value.bibliography.length > 0) lines.push(`bib:  ${value.bibliography}${value.backendRan ? ' (ran)' : ' (never ran)'}`)
          if (value.norc) lines.push('latexmk ran with -norc')
          if (value.error.length > 0) lines.push(`\n${value.error}`)

          if (value.errors.length > 0) {
            lines.push(`\nERRORS (fix the first):`)
            for (const error of value.errors.slice(0, MAX_ERRORS)) {
              const where = error.line === null ? error.file : `${error.file}:${error.line}`
              lines.push(`  ${where} — ${error.message}`)
              if (error.detail.length > 0) {
                for (const detailLine of error.detail.split(/\r?\n/).slice(0, 3)) lines.push(`      ${detailLine}`)
              }
            }
          }
          if (value.missingPackages.length > 0) {
            lines.push(`\nMISSING FILES: ${value.missingPackages.join(', ')}`)
            lines.push('  Check with `kpsewhich <file>`; install with `tlmgr install <package>`.')
          }
          if (value.missingGlyphs.length > 0) {
            lines.push('\nMISSING GLYPHS (silent visual damage — the PDF shows blanks/tofu):')
            for (const glyph of value.missingGlyphs.slice(0, MAX_GLYPHS)) {
              lines.push(`  ${glyph.char} ${glyph.code} ×${glyph.count} in ${glyph.font}`)
            }
          }
          if (value.missingCitations.length > 0) lines.push(`\nUNDEFINED CITATIONS: ${value.missingCitations.join(', ')}`)
          if (value.missingReferences.length > 0) lines.push(`\nUNDEFINED REFERENCES: ${value.missingReferences.join(', ')}`)
          if (value.overfull.length > 0) {
            lines.push(`\nOVERFULL BOXES: ${value.overfull.length}`)
            for (const box of value.overfull.slice(0, 5)) {
              lines.push(`  ${box.kind} ${box.amountPt}pt too ${box.kind === 'hbox' ? 'wide' : 'high'}${box.line === null ? '' : ` (line ${box.line})`}`)
            }
          }
          if (value.warnings.length > 0) {
            lines.push('\nNOTES:')
            for (const warning of value.warnings.slice(0, MAX_WARNINGS)) lines.push(`  ${warning}`)
          }
          lines.push(`\n${value.headline}`)
          if (value.pdfPath.length > 0) lines.push('Next: call latex_verify on the PDF — exit 0 does not prove the document is correct.')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args) {
        return { card: 'terminal', title: `latexmk ${args.file}` }
      },
      async execute(args, exec) {
        const value = await service.compile({
          file: args.file,
          engine: args.engine ?? '',
          outDir: args.outDir ?? 'project',
          timeoutMs: args.timeoutMs,
          cwd: exec?.cwd ?? exec?.workdir ?? '',
          signal: exec?.signal,
        })
        logger?.info?.(`latex: compile ${value.texFile} → exit ${value.exitCode} (${value.engine})`)
        return {
          ok: value.ok,
          texFile: value.texFile,
          engine: value.engine,
          engineSource: value.engineSource,
          engineObserved: value.engineObserved ?? '',
          bibliography: value.bibliography ?? '',
          exitCode: value.exitCode,
          durationMs: value.durationMs,
          norc: value.norc,
          outputDir: value.outputDir,
          logPath: value.logPath,
          pdfPath: value.pdfPath,
          pdfBytes: value.pdfBytes,
          pdfAgeSeconds: value.pdfAgeSeconds,
          headline: value.headline,
          errors: value.findings.errors.slice(0, MAX_ERRORS),
          missingGlyphs: value.findings.missingGlyphs.slice(0, MAX_GLYPHS),
          missingCitations: value.findings.missingCitations.map((entry) => entry.key),
          missingReferences: value.findings.missingReferences.map((entry) => entry.label),
          missingPackages: value.findings.missingPackages,
          overfull: value.findings.overfull.map((entry) => ({ kind: entry.kind, amountPt: entry.amountPt, line: entry.line })),
          findingsWarnings: value.findings.warnings,
          backendRan: value.findings.backendRan,
          timedOut: value.timedOut,
          truncated: value.truncated,
          encoding: value.encoding,
          warnings: value.warnings,
          stdoutTail: value.stdoutTail,
          stderrTail: value.stderrTail,
          error: value.error,
        }
      },
    },

    {
      name: 'latex_verify',
      description:
        'Verify a built PDF by reading its actual content: page count, Chinese characters per page, blank pages, '
        + 'missing glyphs (characters the font could not draw — the PDF shows blanks or tofu while the build exits 0), '
        + 'unresolved references, and literal citation keys. This is the check a zero exit code cannot make, and it is '
        + 'the reason to call it after every compile. Degrades in three tiers and always reports which one ran: '
        + '"full" (PyMuPDF: every check), "text" (pdftotext: no per-glyph attribution), "minimal" (structure only — '
        + 'pages and CJK were NOT checked). With render=true it writes page PNGs and returns their paths; look at '
        + 'them with read_image, because a clean report cannot see an ugly table.',
      parameters: {
        type: 'object',
        properties: {
          pdf: {
            type: 'string',
            description: 'The PDF to verify. Relative paths resolve against the session working directory.',
          },
          pages: {
            type: 'string',
            description: 'Pages to render when render=true, e.g. "1-3" or "1,4,7-9". Every page is inspected regardless.',
          },
          render: {
            type: 'boolean',
            description: 'Render the requested pages to PNG and return their paths (default false). Requires PyMuPDF.',
          },
          dpi: {
            type: 'integer',
            description: 'Rasterisation resolution for rendered pages (default 110, range 50-400).',
          },
          expectCjk: {
            type: 'boolean',
            description: 'Report pages carrying no Chinese characters (default true — a Chinese thesis losing all its Chinese is a real defect).',
          },
          pngDir: {
            type: 'string',
            description: 'Directory for rendered PNGs. Defaults to <pdf directory>/.latex-verify/.',
          },
        },
        required: ['pdf'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            capability: {
              type: 'string',
              description: 'Verification strength actually achieved: full, text or minimal. Never assume full.',
            },
            capabilityDetail: { type: 'string', description: 'What tool answered and what it could not see.' },
            verifyTool: { type: 'string', description: 'pymupdf, pdftotext or structure.' },
            pdf: { type: 'string', description: 'Absolute path of the verified PDF.' },
            sizeBytes: { type: 'integer', description: 'PDF size in bytes.' },
            pages: { type: 'integer', description: 'Page count, or 0 when the tier could not read the document.' },
            perPageCjk: {
              type: 'array',
              description: 'Chinese character count per page, index 0 = page 1.',
              items: { type: 'integer', description: 'CJK count on that page.' },
            },
            zeroCjkPages: {
              type: 'array',
              description: 'Pages with no Chinese characters at all.',
              items: { type: 'integer', description: 'A page number.' },
            },
            blankPages: {
              type: 'array',
              description: 'Pages that are effectively blank (nothing but a page number).',
              items: { type: 'integer', description: 'A page number.' },
            },
            missingGlyphCount: { type: 'integer', description: 'Total glyphs that failed to render.' },
            missingGlyphs: {
              type: 'array',
              description: 'Which codepoints were lost (full tier only; the text tier detects but cannot attribute).',
              items: {
                type: 'object',
                properties: {
                  char: { type: 'string', description: 'The character.' },
                  code: { type: 'string', description: 'Its codepoint.' },
                  count: { type: 'integer', description: 'Occurrences.' },
                },
                required: ['char', 'code', 'count'],
                additionalProperties: false,
              },
            },
            unresolvedRefPages: {
              type: 'array',
              description: 'Pages showing [?] for an unresolved reference.',
              items: { type: 'integer', description: 'A page number.' },
            },
            literalCitePages: {
              type: 'array',
              description: 'Pages showing a citation key literally, meaning the bib entry was missing.',
              items: { type: 'integer', description: 'A page number.' },
            },
            findings: {
              type: 'array',
              description: 'Human-readable findings, one per detected defect.',
              items: { type: 'string', description: 'One finding.' },
            },
            rendered: {
              type: 'array',
              description: 'PNG paths written for visual inspection.',
              items: { type: 'string', description: 'An absolute PNG path.' },
            },
            pagesRendered: {
              type: 'array',
              description: 'Which pages were rendered.',
              items: { type: 'integer', description: 'A page number.' },
            },
            durationMs: { type: 'integer', description: 'How long verification took.' },
            warnings: {
              type: 'array',
              description: 'Why a capability was unavailable, or what the tier could not check.',
              items: { type: 'string', description: 'One warning.' },
            },
            error: { type: 'string', description: 'Why verification could not run at all, else empty.' },
          },
          required: [
            'capability', 'capabilityDetail', 'verifyTool', 'pdf', 'sizeBytes', 'pages', 'perPageCjk',
            'zeroCjkPages', 'blankPages', 'missingGlyphCount', 'missingGlyphs', 'unresolvedRefPages',
            'literalCitePages', 'findings', 'rendered', 'pagesRendered', 'durationMs', 'warnings', 'error',
          ],
          additionalProperties: false,
        },
        render(args, value) {
          const lines = []
          lines.push(`capability: ${value.capability} (${value.verifyTool}) — ${value.capabilityDetail}`)
          lines.push(`pdf: ${value.pdf} (${value.sizeBytes} bytes, ${value.pages} pages)`)
          if (value.error.length > 0) {
            lines.push(`\nERROR: ${value.error}`)
            return [{ type: 'text', text: lines.join('\n') }]
          }
          if (value.capability === 'minimal') {
            lines.push('\nOnly the PDF structure was checked. Pages, CJK counts and glyphs were NOT verified.')
            for (const warning of value.warnings) lines.push(`  ${warning}`)
            return [{ type: 'text', text: lines.join('\n') }]
          }
          const cjkTotal = value.perPageCjk.reduce((sum, count) => sum + count, 0)
          lines.push(`CJK characters: ${cjkTotal} total across ${value.perPageCjk.length} pages`)
          if (value.perPageCjk.length > 0) {
            lines.push(`  per page: ${value.perPageCjk.map((count, index) => `${index + 1}:${count}`).join(' ')}`)
          }
          if (value.zeroCjkPages.length > 0) lines.push(`  pages with NO Chinese: ${value.zeroCjkPages.join(', ')}`)
          if (value.blankPages.length > 0) lines.push(`  effectively blank pages: ${value.blankPages.join(', ')}`)
          if (value.missingGlyphCount > 0) {
            lines.push(`\nMISSING GLYPHS: ${value.missingGlyphCount}`)
            for (const glyph of value.missingGlyphs.slice(0, MAX_GLYPHS)) {
              lines.push(`  ${glyph.char} ${glyph.code} ×${glyph.count}`)
            }
          }
          if (value.unresolvedRefPages.length > 0) lines.push(`\nUNRESOLVED REFERENCES on pages: ${value.unresolvedRefPages.join(', ')}`)
          if (value.literalCitePages.length > 0) lines.push(`\nLITERAL CITATION KEYS on pages: ${value.literalCitePages.join(', ')}`)
          if (value.findings.length > 0) {
            lines.push('\nFINDINGS:')
            for (const finding of value.findings.slice(0, MAX_WARNINGS)) lines.push(`  - ${finding}`)
          } else {
            lines.push('\nNo structural findings.')
          }
          if (value.rendered.length > 0) {
            lines.push(`\nRendered pages: ${value.rendered.join(', ')}`)
            lines.push('Look at them with read_image — a clean report cannot see a badly placed table or an orphaned figure.')
          } else if (args.render === true) {
            lines.push('\nrender was requested but no PNG was written; see warnings.')
          }
          if (value.warnings.length > 0) {
            lines.push('\nWARNINGS:')
            for (const warning of value.warnings.slice(0, MAX_WARNINGS)) lines.push(`  ${warning}`)
          }
          lines.push('\nA clean report is not a visual check: if the document is Chinese, confirm the CJK counts are non-zero.')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args) {
        return { card: 'generic', title: `verify ${args.pdf}` }
      },
      async execute(args, exec) {
        const value = await service.verify({
          pdf: args.pdf,
          pages: args.pages ?? '1-3',
          render: args.render === true,
          dpi: args.dpi,
          expectCjk: args.expectCjk !== false,
          pngDir: args.pngDir ?? '',
          cwd: exec?.cwd ?? exec?.workdir ?? '',
          signal: exec?.signal,
        })
        return {
          capability: value.capability,
          capabilityDetail: value.capabilityDetail ?? '',
          verifyTool: value.verifyTool,
          pdf: value.pdf,
          sizeBytes: value.sizeBytes,
          pages: value.pages,
          perPageCjk: value.perPageCjk,
          zeroCjkPages: value.zeroCjkPages,
          blankPages: value.blankPages,
          missingGlyphCount: value.missingGlyphCount,
          missingGlyphs: value.missingGlyphs,
          unresolvedRefPages: value.unresolvedRefPages,
          literalCitePages: value.literalCitePages,
          findings: value.findings,
          rendered: value.rendered,
          pagesRendered: value.pagesRendered,
          durationMs: value.durationMs,
          warnings: value.warnings ?? [],
          error: value.error ?? '',
        }
      },
    },

    {
      name: 'latex_doctor',
      description:
        'Check the LaTeX environment and report a verdict with evidence: where TeX is installed and how that was '
        + 'established, the latexmk version (read past the Perl locale warning that breaks naive parsing), which '
        + 'engines answer, whether ctex / xeCJK / fontspec / biblatex-gb7714-2015 are installed, which PDF-text tier '
        + 'the machine can reach, and whether the Windows 8.3 short name in TEMP has been resolved (latexmk refuses '
        + 'a "~" path, which is what makes other LaTeX tooling report "not ready" forever on this class of machine). '
        + 'Call this before blaming the document for a build that will not start. Setting smoke=true additionally '
        + 'compiles a minimal ctex document and deletes it, which is the end-to-end proof (~10s).',
      parameters: {
        type: 'object',
        properties: {
          smoke: {
            type: 'boolean',
            description: 'Also compile a minimal ctex document in the resolved temp directory and remove it (default false, ~10s).',
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'ready, degraded or missing.' },
            texRoot: { type: 'string', description: 'TeX MF root (TEXMFROOT), when discoverable.' },
            texBin: { type: 'string', description: 'Directory holding latexmk and the engines.' },
            texSource: { type: 'string', description: 'How it was found: config.texBin, kpsewhich, probe or PATH.' },
            texVersion: { type: 'string', description: 'TeX Live release year, when it could be inferred.' },
            latexmkVersion: { type: 'string', description: 'latexmk version, e.g. 4.88.' },
            latexmkDetail: { type: 'string', description: 'The full version line, for evidence.' },
            engines: {
              type: 'array',
              description: 'Engines present next to latexmk.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Engine name.' },
                  version: { type: 'string', description: 'Version banner, or empty.' },
                  present: { type: 'boolean', description: 'Whether the executable exists.' },
                },
                required: ['name', 'version', 'present'],
                additionalProperties: false,
              },
            },
            packages: {
              type: 'array',
              description: 'Packages that decide whether Chinese thesis work is possible.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Package name.' },
                  file: { type: 'string', description: 'The file probed for.' },
                  found: { type: 'boolean', description: 'Whether kpsewhich located it.' },
                  path: { type: 'string', description: 'Where it lives, when found.' },
                },
                required: ['name', 'file', 'found', 'path'],
                additionalProperties: false,
              },
            },
            backends: {
              type: 'array',
              description: 'Bibliography backend executables.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'biber or bibtex.' },
                  found: { type: 'boolean', description: 'Whether it exists.' },
                },
                required: ['name', 'found'],
                additionalProperties: false,
              },
            },
            python: {
              type: 'object',
              description: 'Python interpreter used for the full PDF check.',
              properties: {
                executable: { type: 'string', description: 'Resolved interpreter path.' },
                version: { type: 'string', description: 'Python version.' },
                hasPyMuPDF: { type: 'boolean', description: 'Whether import fitz works.' },
                source: { type: 'string', description: 'How it was found.' },
              },
              required: ['executable', 'version', 'hasPyMuPDF', 'source'],
              additionalProperties: false,
            },
            pdfTextTier: { type: 'string', description: 'Best PDF verification tier available: full, text or minimal.' },
            pdftotext: { type: 'string', description: 'Resolved pdftotext path, or empty.' },
            tempRaw: { type: 'string', description: 'The temp directory exactly as the OS reports it (may be 8.3).' },
            tempResolved: { type: 'string', description: 'The temp directory after resolving the 8.3 short name.' },
            shortNameFixed: { type: 'boolean', description: 'True when raw and resolved differ, i.e. a "~" path was fixed.' },
            checks: {
              type: 'array',
              description: 'Individual checks with their evidence.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Check id.' },
                  ok: { type: 'boolean', description: 'Whether it passed.' },
                  detail: { type: 'string', description: 'The evidence used for the verdict.' },
                },
                required: ['id', 'ok', 'detail'],
                additionalProperties: false,
              },
            },
            smoke: {
              type: 'object',
              description: 'The optional end-to-end compile check.',
              properties: {
                ran: { type: 'boolean', description: 'Whether it ran.' },
                ok: { type: 'boolean', description: 'Whether it produced a PDF.' },
                exitCode: {
                  oneOf: [{ type: 'integer' }, { type: 'null' }],
                  description: 'latexmk exit code.',
                },
                durationMs: { type: 'integer', description: 'How long it took.' },
                detail: { type: 'string', description: 'What happened, including the directory used.' },
              },
              required: ['ran', 'ok', 'exitCode', 'durationMs', 'detail'],
              additionalProperties: false,
            },
            warnings: {
              type: 'array',
              description: 'Actionable gaps.',
              items: { type: 'string', description: 'One warning.' },
            },
            durationMs: { type: 'integer', description: 'How long the check took.' },
          },
          required: [
            'status', 'texRoot', 'texBin', 'texSource', 'texVersion', 'latexmkVersion', 'latexmkDetail',
            'engines', 'packages', 'backends', 'python', 'pdfTextTier', 'pdftotext', 'tempRaw', 'tempResolved',
            'shortNameFixed', 'checks', 'smoke', 'warnings', 'durationMs',
          ],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [`LaTeX environment: ${value.status.toUpperCase()}`]
          lines.push(`TeX:    ${value.texBin.length > 0 ? `${value.texBin}${value.texVersion.length > 0 ? ` (TeX Live ${value.texVersion})` : ''}` : '(not found)'} via ${value.texSource}`)
          lines.push(`latexmk: ${value.latexmkVersion.length > 0 ? value.latexmkVersion : '(no version reported)'}`)
          if (value.engines.length > 0) {
            lines.push(`Engines: ${value.engines.map((engine) => `${engine.name}${engine.present ? '' : ' (missing)'}`).join(', ')}`)
          }
          const found = value.packages.filter((entry) => entry.found).map((entry) => entry.name)
          const absent = value.packages.filter((entry) => !entry.found).map((entry) => entry.name)
          if (found.length > 0) lines.push(`Found:    ${found.join(', ')}`)
          if (absent.length > 0) lines.push(`Missing:  ${absent.join(', ')}`)
          if (value.backends.length > 0) {
            lines.push(`Backends: ${value.backends.map((entry) => `${entry.name}${entry.found ? '' : ' (missing)'}`).join(', ')}`)
          }
          lines.push(`PDF text: ${value.pdfTextTier}${value.python.hasPyMuPDF ? ` (PyMuPDF in ${value.python.executable})` : value.pdftotext.length > 0 ? ` (pdftotext at ${value.pdftotext})` : ''}`)
          lines.push(`Temp:     ${value.tempResolved}${value.shortNameFixed ? `\n          8.3 short name fixed: ${value.tempRaw} -> ${value.tempResolved}` : ' (already a long name)'}`)
          if (value.smoke.ran) {
            lines.push(`Smoke test: ${value.smoke.ok ? 'PASSED' : 'FAILED'} (${value.smoke.durationMs} ms) — ${value.smoke.detail}`)
          }
          const failed = value.checks.filter((check) => !check.ok)
          if (failed.length > 0) {
            lines.push('\nFailed checks:')
            for (const check of failed) lines.push(`  ${check.id}: ${check.detail}`)
          }
          if (value.warnings.length > 0) {
            lines.push('\nWARNINGS:')
            for (const warning of value.warnings.slice(0, MAX_WARNINGS)) lines.push(`  ${warning}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args) {
        return { card: 'generic', title: args.smoke ? 'latex doctor (with smoke test)' : 'latex doctor' }
      },
      async execute(args, exec) {
        const value = await service.doctor({ smoke: args.smoke === true, signal: exec?.signal })
        return {
          status: value.status,
          texRoot: value.texRoot ?? '',
          texBin: value.texBin ?? '',
          texSource: value.texSource ?? 'none',
          texVersion: value.texVersion ?? '',
          latexmkVersion: value.latexmkVersion ?? '',
          latexmkDetail: value.latexmkDetail ?? '',
          engines: (value.engines ?? []).map((engine) => ({
            name: engine.name,
            version: engine.version ?? '',
            present: engine.present === true,
          })),
          packages: (value.packages ?? []).map((entry) => ({
            name: entry.name,
            file: entry.file,
            found: entry.found === true,
            path: entry.path ?? '',
          })),
          backends: value.backends ?? [],
          python: {
            executable: value.python?.executable ?? '',
            version: value.python?.version ?? '',
            hasPyMuPDF: value.python?.hasPyMuPDF === true,
            source: value.python?.source ?? 'none',
          },
          pdfTextTier: value.pdfTextTier ?? 'minimal',
          pdftotext: value.pdftotext ?? '',
          tempRaw: value.tempRaw ?? '',
          tempResolved: value.tempResolved ?? '',
          shortNameFixed: value.shortNameFixed === true,
          checks: value.checks ?? [],
          smoke: value.smoke ?? { ran: false, ok: false, exitCode: null, durationMs: 0, detail: '' },
          warnings: value.warnings ?? [],
          durationMs: value.durationMs,
        }
      },
    },
  ]
}
