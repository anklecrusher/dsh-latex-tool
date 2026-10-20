# dsh-latex-tool

LaTeX compile, diagnose and verify for the DeepSeek Harness: three tools
(`latex_compile`, `latex_verify`, `latex_doctor`), one bundled skill
(`latex-project-workflow`), and a settings panel.

It exists because the stock LaTeX tooling fails on this class of machine in
ways that report success, and because none of it can tell you whether the PDF
it produced is actually correct.

---

## 1. Why not just use the official plugin

`openai-bundled/latex@0.2.8` was measured on this machine. Four hard faults and
five capability gaps; every one is reproduced in
[`skill/references/official-plugin-pitfalls.md`](skill/references/official-plugin-pitfalls.md)
with the source lines involved.

| # | Fault | Measured consequence |
|---|---|---|
| F1 | `tempfile.mkdtemp()` inherits the 8.3 short name `C:\Users\ANKLEC~1\…`; latexmk refuses `~` in a filename | its doctor reports "not ready" forever, on a working TeX Live |
| F2 | `subprocess.run(text=True)` decodes latexmk output with the locale default | `UnicodeDecodeError` on any project under a non-ASCII path |
| F3 | `install_texlive.py:78` raises on Windows | the "install TeX Live" button is dead code on Windows |
| F4 | `detect_texlive.py:91` takes the first non-empty line of `latexmk -v` | that line is `perl: warning: Setting locale failed`, not the version |

And what it cannot do even when it works: no `ctex` in its engine table (so a
Chinese thesis gets `pdflatex`), no log semantics beyond `exitCode` plus the
last 8000 characters, no product verification beyond `pdfExists`, no editing
discipline, no GB/T 7714.

**Conclusion: copy its mechanism, replace its judgement, fix its faults.**

---

## 2. The three tools

### `latex_compile`

Drives `latexmk` and returns a structured result.

```jsonc
// input
{ "file": "main.tex", "engine": "xelatex", "outDir": "project", "timeoutMs": 180000 }
// output (abridged)
{ "ok": true, "engine": "xelatex", "engineSource": "documentclass", "exitCode": 0,
  "pdfPath": "…/.latex-build/main.pdf", "headline": "no errors",
  "errors": [], "missingGlyphs": [], "missingCitations": [], "warnings": [] }
```

Engine inference, in priority order — each step recorded in `engineSource` so a
wrong guess is diagnosable from the result rather than by rereading the source:

1. an explicit `engine` argument;
2. `% !TEX program = …` (following `% !TEX root` first);
3. the project's `latexmkrc` `$pdf_mode`, only when `respectLatexmkrc: true`;
4. `\documentclass{ctexart|ctexrep|ctexbook|ctexbeamer}` → **xelatex**;
5. `\usepackage{fontspec|xeCJK|polyglossia|unicode-math}` → xelatex;
   `{luacode}` → lualatex;
6. `\setCJKmainfont` / `\setmainfont` / `\directlua` → xelatex / lualatex;
7. `pdflatex`.

Step 4 is the one the official plugin does not have, and the reason a Chinese
thesis builds correctly here without being told which engine to use.

### `latex_verify`

The capability the official plugin lacks entirely. Reads the PDF's actual
content and reports:

- page count, per-page CJK counts (`perPageCjk`), zero-CJK pages;
- effectively blank pages (a page carrying only its number is blank);
- missing glyphs — XeTeX writes **U+FFFF** for a glyph the font lacks, while
  `pdftotext` writes **U+FFFD**; both count;
- `[?]` for unresolved references, and literal citation keys in brackets;
- optional PNG rendering, with the paths returned so the model can look at them.

**Three tiers, and the result always says which one answered.** This is the part
a naive implementation gets wrong: a weaker check that is reported as a full one
is worse than no check.

| `capability` | Tool | Sees |
|---|---|---|
| `full` | PyMuPDF via Python | everything, including per-codepoint glyph loss |
| `text` | `pdftotext -enc UTF-8` | pages, CJK counts, blank pages; no per-glyph attribution |
| `minimal` | PDF structure only | `%PDF-`, `%%EOF`, size — **page count and CJK were not checked** |

`-enc UTF-8` is not optional: without it `pdftotext` writes through the console
code page and extracts Chinese as empty text, which reads as "clean" instead of
"lost everything". Measured on this machine.

### `latex_doctor`

Reports a verdict **with the evidence behind it**:

```jsonc
{ "status": "ready", "texBin": "D:/Program Files (x86)/texlive/2026/bin/windows",
  "texSource": "kpsewhich", "latexmkVersion": "4.88",
  "engines": [ { "name": "xelatex", "version": "XeTeX 3.141592653-2.6-0.999998 (TeX Live 2026)", "present": true } ],
  "packages": [ { "name": "ctex", "found": true }, { "name": "biblatex-gb7714-2015", "found": true } ],
  "python": { "executable": "D:/Program Files/python.exe", "hasPyMuPDF": true },
  "pdfTextTier": "full",
  "tempRaw": "C:/Users/ANKLEC~1/AppData/Local/Temp",
  "tempResolved": "C:/Users/ankle crusher/AppData/Local/Temp",
  "shortNameFixed": true,
  "smoke": { "ran": true, "ok": true, "exitCode": 0, "durationMs": 9000 } }
```

Design rules that make its verdict trustworthy:

- **PATH membership is not evidence.** This machine's Machine PATH still lists a
  deleted `D:\texlive\2024\bin\windows`; a string test would report a working
  installation that is not there. Every candidate is `stat`ed.
- **Versions are found by pattern, not position**, because TeX Live's `latexmk`
  is a Perl wrapper that writes its locale warning first.
- **The smoke test is a real build** of a minimal `ctexart` document in the
  resolved temp directory, then the directory is deleted. It is opt-in
  (`smoke: true`) because it costs ~10 s.

---

## 3. The measurements this plugin is built on

All taken on this machine (Windows 11, zh-CN, TeX Live 2026, latexmk 4.88,
Node 24, DSH 0.2.1-rc.2, 2026-10-20).

**The 8.3 short name breaks latexmk, and only `realpathSync.native` fixes it.**

```
$ node -e "require('os').tmpdir()"
C:\Users\ANKLEC~1\AppData\Local\Temp
$ fs.realpathSync(tmp)         → C:\Users\ANKLEC~1\AppData\Local\Temp   (unchanged)
$ fs.realpathSync.native(tmp)  → C:\Users\ankle crusher\AppData\Local\Temp

# compiling with a short-named absolute path:
Latexmk: Filename 'C:/Users/ANKLEC~1/AppData/Local/Temp/probe/main.tex'
          contains character not allowed for TeX file.
Latexmk: Stopping because of bad filename(s).
exit 255
# the same project at the long name: exit 0, PDF produced
```

**latexmk writes UTF-8 to stdout and GBK to stderr.** Not the same encoding on
the two streams of one process — measured with a project whose missing input
file has a Chinese name:

```
stdout: "不存在\ufffd… .tex' not found."      ← clean UTF-8
stderr: "Latexmk: Missing input file '\xb2\xbb\xb4\xe6…'"   ← GBK bytes
```

So decoding is per-stream: try UTF-8, fall back to GBK only when UTF-8 produced
replacement characters. The reverse order would be wrong — GBK decodes almost
any byte sequence without complaint.

**`ctexart` under `pdflatex` compiles and exits 0 while dropping unmapped
glyphs.** "It produced a PDF" is therefore not evidence the engine was right;
`xelatex` is chosen for `ctex*` classes because that is what they are designed
for.

**A ctex project with no engine flag builds DVI, not PDF, and exits 0.** The
engine flag (`-pdf` / `-xelatex` / `-lualatex`) is mandatory, not cosmetic.

**XeTeX writes U+FFFF for a missing glyph; `pdftotext` writes U+FFFD.** Both are
a failed glyph; a checker that only looks for one of them misses half the cases.

**`pdftotext` needs `-enc UTF-8`.** Default output under CP936 for a Chinese PDF
is empty (verified: `od -c` shows only `1 A B C`, the Chinese gone).

---

## 4. Configuration

All keys are optional; the plugin probes the machine unaided when the config is
empty. Set them in `cordis.patch.yml` under the `latex-tool` row's `config:`.

| Key | Default | Meaning |
|---|---|---|
| `texBin` | probe | TeX bin directory. Omit unless probing picks the wrong tree. |
| `pythonPath` | probe | Interpreter for the full PDF tier. A Python without PyMuPDF is not an error — verification degrades and says so. |
| `defaultEngine` | `auto` | `auto` infers per project; setting an engine pins it. |
| `respectLatexmkrc` | `false` | `false` runs latexmk with `-norc`, because a latexmkrc is Perl that would execute on a project the user only asked to preview. The result says `norc: true`, and a project that has a latexmkrc gets a warning that it was ignored. |
| `timeoutMs` | `180000` | Compile deadline. The process tree is killed on expiry. |
| `renderDpi` | `110` | Resolution for rendered verification pages. |

The panel can also set `defaultEngine` and `respectLatexmkrc`. Two layers exist
on purpose:

- **patch layer** — the `config:` block, reviewed in git. **Wins.**
- **state layer** — what the panel writes, in
  `$DSH_HOME/storages/dsh-latex-tool/state.json`.

The panel shows which layer each value came from (`patch` / `state` / `default`),
so a toggle that is pinned by the patch says so instead of appearing broken. A
panel change never silently shadows the reviewed patch.

---

## 5. The bundled skill is the only copy

`skill/` holds `latex-project-workflow` and its five references. It was moved
here from `codex-skills/skills/latex-paper-workflow` and
`~/.agents/skills/latex-paper-workflow`, both of which were deleted **after**
this provider was verified — in that order, deliberately: deleting first would
leave a window with no LaTeX skill at all.

Two copies drift: edit one, forget the other, and which one the model loads
depends on provider priority. The cost of the merge is that changing the skill
now means changing this repository. That is the intended trade.

Deleting the tool's `skill/` directory or removing the bundle removes the skill
with it — no residue.

---

## 6. Design decisions worth knowing

**No dependencies.** Zero. The plugin is a `link:` directory, pnpm installs
nothing, and the 24-hour package cooling-off period is irrelevant. The
frontmatter parser is 40 lines because only four fields exist; `js-yaml` would
turn this into a package that needs its own install for a `description:` line.

**No schemastery for config.** This bundle is symlinked into the profile from
`E:`, and Node resolves a symlinked module to its real path, so a bare
`@deepseek-ai/schemastery` import would resolve from
`E:\GitHubWorkspace\…` and fail with `ERR_MODULE_NOT_FOUND`. A hand-written
validator is used instead, and unknown keys are warned about rather than
silently ignored.

**No `@deepseek-ai/*` peer dependency.** Declaring one with a `^0.1.x` range is
how a plugin becomes uninstallable on `0.2.1-rc.2`.

**Three tools, not five.** No `latex_clean` (`latexmk -c` is one shell command
and does not deserve a permanent schema), no `latex_bib` (a citation plugin's
job), no `latex_edit` (editing is a general file operation).

**PNG paths, not inline images.** Building an `ImageAttachmentRef` needs the
attachment pipeline. Returning paths and letting the model call `read_image` is
simpler and matches how every other tool here reports artifacts.

**No managed TeX install.** Installing a 4 GB distribution is not a plugin's
job, and the official plugin's Windows path for it is dead code for good reason.
`latex_doctor` reports what is missing; the user installs it.

---

## 7. Verifying it

```bash
# Offline: the plugin's own code paths against the real TeX installation.
node test-harness.mjs --verbose

# Live: install into a throwaway profile, compose it with the real CLI, remove it.
node scripts/live-check.mjs
```

`test-harness.mjs` runs 44 checks covering engine inference, log parsing, both
decoding paths, the 8.3 fix, PDF verification in both the `full` and `text`
tiers, real compiles (ctex under a Chinese path, a deliberate syntax error, a
biber project, a missing-glyph project), and the skill provider's contract.
`live-check.mjs` proves the things a fake context cannot: the bundle installs as
a `link:` dependency, the loader composes the `latex-tool` row, the skill
provider passes the runtime's `validateCandidate()`, and removing the bundle
composes the row away.

Exit code 0 means every check passed.

---

## 8. Installation

This is a self-authored plugin, so it lives in its own repository and the
profile references it by absolute path:

```jsonc
// profile/package.json
"dependencies": { "@local/dsh-latex-tool": "link:E:/GitHubWorkspace/own/opensource/dsh-latex-tool" },
"dsh": { "profile": { "bundles": [ /* … */ "@local/dsh-latex-tool" ] } }
```

```powershell
& "D:\Users\ankle crusher\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile desktop add E:\GitHubWorkspace\own\opensource\dsh-latex-tool
```

Then sync the profile mirror and restart the desktop app — `dsh.profile.bundles`
is read at boot:

```powershell
& 'E:\GitHubWorkspace\own\opensource\dsh-profile-desktop\scripts\capture.ps1'
```

Read `git diff` there before committing: DSH and the market rewrite
`cordis.patch.yml` silently.

---

## 9. Layout

```
dsh-latex-tool/
├── package.json              # dsh.bundle.patch + dsh.client, zero dependencies
├── cordis.patch.yml          # the latex-tool insert row, every key documented
├── entry.js                  # cache-busting import so edits apply without a restart
├── index.js                  # tools + skill provider + panel RPC route
├── client.js                 # settings panel (settings.plugins.tab)
├── lib/
│   ├── config.js             # patch/state layers, provenance, plain validator
│   ├── decode.js             # per-stream UTF-8 → GBK fallback
│   ├── paths.js              # realpathSync.native, latexmk's illegal-name rule
│   ├── run.js                # spawn as bytes, tree kill, deadline
│   ├── detect.js             # TeX / latexmk / engines / packages / Python / pdftotext
│   ├── engine.js             # inference chain and latexmk engine flags
│   ├── diagnose.js           # .log → structured findings
│   ├── compile.js            # the latexmk driver
│   ├── verify.js             # three-tier PDF verification
│   ├── doctor.js             # environment self-check + smoke test
│   ├── service.js            # one path shared by tools and the panel
│   ├── skill.js              # the skill provider and its frontmatter parser
│   └── tools.js              # the three tool definitions
├── skill/                    # latex-project-workflow — the ONLY copy
│   ├── SKILL.md
│   └── references/
├── scripts/
│   ├── verify_pdf.py         # PyMuPDF helper with a --json contract
│   └── live-check.mjs        # install / compose / remove against the real CLI
├── locale/{zh,en}.json
├── icon.svg
└── test-harness.mjs
```

---

## 10. Licence

Private. Written for this machine's environment; the measured findings it
encodes are documented so they can be rechecked rather than trusted.
