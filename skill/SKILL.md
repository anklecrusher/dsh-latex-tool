---
name: latex-project-workflow
description: Compile, diagnose, and verify LaTeX projects with the dsh-latex-tool tools. Use when the user asks to build a .tex file, fix a LaTeX error, check layout or references, or restructure a manuscript — including Chinese theses built with ctex + biblatex-gb7714. Covers engine selection, log triage, edit discipline, and PDF verification by rendering pages.
---

# LaTeX Project Workflow

Read a LaTeX project, compile it correctly the first time, diagnose real errors
from the log rather than guessing, edit the source with minimal change, and prove
the result by rendering the PDF.

The work is done through three tools — `latex_doctor`, `latex_compile`,
`latex_verify`. They exist because every one of these steps has a way to look
successful while being wrong: a shell that cannot see TeX, an engine that silently
drops glyphs, a build that exits 0 over tofu. Use the tools for the mechanical
part and spend the attention on the judgement that stays human.

## Non-negotiables

- **Never claim a PDF is correct without rendering it.** A zero exit code and a
  new `main.pdf` prove the build ran, not that Chinese renders, floats sit
  correctly, or the page count is sane.
- **Never delete or comment out content to make it compile.** Fix the cause. If
  you cannot, report the blocker.
- **Change one thing at a time**, rebuild, and keep the diff reviewable.
- **Do not edit `.cls` / `.sty` / `.bst`** supplied by a journal or university to
  force a build through.
- **A stale PDF is not evidence.** Check the PDF's timestamp against the compile
  you just ran, or build into a fresh output directory. `latex_compile` reports
  `pdfPath`, `pdfBytes` and `pdfAgeSeconds` so this is checkable rather than
  assumed.

## Step 1 — Establish the machine facts

Call `latex_doctor`. It is the first step, every session, before touching a
project:

```json
{}
```

```json
{ "smoke": true }
```

Pass `smoke: true` when you are about to do a long or risky build, or when the
plain report is ambiguous. It compiles a small `ctex` document in a proper temp
directory, checks that a PDF came out, and cleans up — about ten seconds, so once
per session rather than before every build.

Read these fields, in this order:

- `status` — `ready` / `degraded` / `missing`. Stop and report on `missing`.
  On `degraded`, read `checks`, `engines[].present` and `packages[].found` and say
  what is actually unavailable before attempting a build.
- `texBin`, `texVersion`, `texSource` — where TeX is and how it was found
  (`config.texBin` / `kpsewhich` / `probe` / `PATH` / `none`). You do not need to
  reason about `PATH`; the tool reports the answer.
- `latexmkVersion` and `latexmkDetail` — the version, not the Perl warning that
  precedes it in the raw output.
- `packages[]` — whether `ctex` and `biblatex-gb7714-2015` are really installed,
  by `found` and `path`.
- `pdfTextTier` — how far PDF verification can go: `full` (PyMuPDF), `text`
  (`pdftotext`), or `minimal` (structure only). This is the ceiling for Step 6;
  `latex_verify` reports the same thing as `capability`.
- `tempResolved` / `shortNameFixed` — whether `%TEMP%` carried an 8.3 short name
  and was corrected. If `shortNameFixed` is false, the temp path needed no repair.

As background, not as a procedure to perform: this machine runs TeX Live 2026,
installed under `D:\Program Files (x86)\texlive\2026` with binaries in its
`bin/windows` subdirectory. It has `xelatex`, `pdflatex`, `lualatex`, `latexmk`,
`bibtex`, `biber`, `kpsewhich`, `texfot` and `tlmgr`, plus real Chinese support
(`ctex`, `xeCJK`, `biblatex-gb7714-2015` styles through 2025). The tool confirms
all of it; treat this paragraph as orientation, never as a substitute for the
report.

## Step 2 — Identify the real root and build recipe

`main.tex` is a candidate, not proof. Determine:

1. **Root document** — follow the build command if one exists (`Makefile`,
   `latexmkrc`, `.vscode/settings.json`, `.github/workflows/*`), else the file
   with `\documentclass` that is not `\include`d by another. `latex_compile`
   reports the root it chose as `texFile`.
2. **Engine** — see the table below. `latex_compile` infers it and reports why in
   `engineSource` (`documentclass` / `magic-program` / `package` / `macro` /
   `latexmkrc` / `explicit` / `default`); confirm that reason matches the source
   rather than accepting it blindly, and compare `engine` against
   `engineObserved`.
3. **Bibliography backend** — `\addbibresource` ⇒ biber; `\bibliography` ⇒
   bibtex; neither ⇒ no backend. Do not assume biber just because `biblatex` is
   loaded; check for `backend=bibtex`. `latex_compile` returns this as
   `bibliography`.
4. **Multi-file structure** — `\include` / `\input` children. Errors will be
   reported against the child path; edit the child, not the root.

### Engine selection

| Signal in source | Engine |
| --- | --- |
| `\usepackage{fontspec}`, `\setmainfont`, `\usepackage{polyglossia}` | `xelatex` (or `lualatex`) |
| `\usepackage{xeCJK}`, `\setCJKmainfont` | `xelatex` |
| `\directlua`, `luacode` | `lualatex` |
| `\documentclass{ctexart/ctexrep/ctexbook}`, `ctex` package | `xelatex` preferred — see the caveat below |
| Plain `article`/`report`/`book`, no CJK, no fontspec | `pdflatex` |

`latex_compile` applies this same table (a `% !TEX program` magic comment
overrides it), and `engineObserved` reports what the log says actually ran. If
`engine` and `engineObserved` disagree, stop and investigate — the build did not
do what was asked.

**Caveat that costs time:** `ctexart` under `pdflatex` *does* compile and *does*
render Chinese on this machine — it falls back to the CJK package mapping and the
system `simsun.ttc`, and the text extracts correctly. So "pdflatex produced a
PDF" is not evidence that the engine is right. Prefer `xelatex` for `ctex*`
because it is what the class is designed for and what handles `fontspec`,
emoji-adjacent glyphs, and unusual characters sanely. Never mix: a project that
loads `fontspec` **must not** be built with `pdflatex`.

Observed on this machine: `pdflatex` + `ctexart` silently drops characters it has
no mapping for instead of failing, which is exactly the kind of damage a
successful exit code hides.

## Step 3 — Compile

Call `latex_compile`:

```json
{ "file": "main.tex" }
```

```json
{ "file": "main.tex", "engine": "xelatex", "outDir": "temp" }
```

- `file` — the `.tex` path, or a directory containing the root. Omit `engine`
  unless Step 2 proved the inference wrong.
- `engine` — `pdflatex` / `xelatex` / `lualatex`, optional. Only set it when you
  have a reason.
- `outDir` — `"project"` (default) keeps build products in `.latex-build/` inside
  the project; `"temp"` puts them in a temp directory and leaves the tree clean.
- `timeoutMs` — default 180000. A 300-page thesis with biber is normally well
  inside two minutes; raise it rather than retrying blindly.

The tool does what hand-driving `latexmk` keeps getting wrong: it adds `-norc`
(a project `latexmkrc` is executable Perl and must not run just because someone
asked for a preview — set `respectLatexmkrc` in the plugin config if the project
needs its own), passes an explicit engine flag, restores 8.3 short names in temp
paths, and decodes latexmk's mixed UTF-8/GBK output instead of crashing on it.

Then read the result rather than only the exit code. Everything is flat on the top
level — there is no `findings` wrapper to dig through:

- `ok`, `exitCode`, `headline`, `durationMs`, `timedOut` — did the run work.
- `errors` — the parsed hard errors, each `{ file, line, message, detail }`.
- `missingGlyphs` — `{ char, code, font, count }` per missing glyph; this is the
  one place a font is named.
- `missingCitations`, `missingReferences`, `missingPackages` — **arrays of
  strings** (the keys and file names), not objects.
- `overfull` — `{ kind, amountPt, line }` per overfull box.
- `bibliography`, `backendRan` — which backend was expected and whether it ran.
- `pdfPath`, `pdfBytes`, `pdfAgeSeconds`, `outputDir`, `logPath` — the artefacts,
  and `encoding` (`{ stdout, stderr }`) telling you which decoder each stream
  needed, which is how a non-ASCII path shows up as handled rather than mangled.

Two arrays that are easy to confuse, and must not be: `findingsWarnings` holds the
**LaTeX warnings from the log** (an overfull, a `Please (re)run Biber`, a
`Label(s) may have changed`); `warnings` holds **this run's process-level notes**
(the project has a `latexmkrc` that `-norc` ignored, the build timed out and was
killed). Read the first for document problems, the second for tooling problems.

Hand-written `latexmk` commands are still valid and are what you fall back to
when the tool's output does not explain the failure, or when a project needs a
flag the tool does not pass. They are collected in
`references/compile-recipes.md` for cross-checking and troubleshooting; they are
not the normal path.

Two facts about `latexmk` that remain true and surprise people:

`latexmk` with **no** engine flag on a `ctexart` project builds a **DVI**, not a
PDF, because the class requests the classic route. Always pass an explicit engine
flag — a "missing `main.pdf`" after a clean run is usually this, not a failure.

`-outdir` is safe for output, but `\input`/`\include` and graphics paths resolve
relative to the source tree, which is what you want. If a project has hand-written
backend invocations, prefer an in-place build.

## Step 4 — Triage the log

`latex_compile` already parses the log it produced: `errors[]` carries
`file` / `line` / `message`, and the missing-package, missing-citation,
missing-reference, missing-glyph and overfull classes each have their own array.
Start there.

When you need the raw log, `logPath` points at it. `-file-line-error` makes real
errors look like `file.tex:123: message`, so:

```bash
grep -nE "^\./[^:]+:[0-9]+:|^! " main.log | head -20
```

Read the **first** error, not the last; later messages are usually cascade.

| Log symptom | Meaning | Action |
| --- | --- | --- |
| `File \`x.sty' not found` | package absent | check `kpsewhich x.sty`; if absent, `tlmgr install` (may need elevation) or drop the dependency |
| `Undefined control sequence` | typo or missing package | usually a misspelled macro; check the line |
| `Missing $ inserted` | math content outside math mode | add `$…$` or `\(…\)` |
| `Runaway argument` | unbalanced brace | inspect from the reported line backwards |
| `begin{X} ended by \end{Y}` | environment mismatch | the Y error names both |
| `Citation 'k' undefined` | key not in `.bib`, or backend not run | check `main.blg` for the real reason |
| `Reference 'r' undefined` | label missing or not yet resolved | needs another pass; if persistent, the label truly is missing |
| `Overfull \hbox` | content wider than the line | layout issue, not build failure; inspect the page |
| `Missing character: There is no …` | glyph absent from chosen font | **silent visual corruption** — treat as a real defect |
| `Label(s) may have changed. Rerun` | aux settling | run once more, or use `latexmk` which handles it |

`Missing character` is the single most under-reported Chinese typesetting bug. It
appears in the log but not as an error and produces a blank or tofu glyph in the
PDF. `latex_compile` surfaces it in `missingGlyphs` with `char` / `code` / `font` /
`count`; Step 6 confirms the damage from the PDF side.

`texfot` filters the log to the interesting lines, for the hand-driven case:

```bash
latexmk -xelatex -interaction=nonstopmode main.tex 2>&1 | tail -5
# or, for the engine directly:
xelatex -interaction=nonstopmode main.tex 2>&1 | texfot
```

One `perl: Setting locale failed` warning on stderr is cosmetic; suppress with
`LC_ALL=C LANG=C` when it pollutes output. Do not read it as a version string —
that mistake is one of the reasons this plugin exists (see
`references/official-plugin-pitfalls.md`).

## Step 5 — Edit safely

- Read the whole file (or at least the surrounding environment) before editing.
- Preserve `\label{...}` keys, `\cite{...}` keys, `\ref{...}` targets, table cell
  contents, numeric values, and comments that carry author intent.
- When restructuring (splitting a chapter, moving a float, renaming a section),
  grep for every reference to the thing being moved first.
- Rebuild after each meaningful batch. If a batch breaks the build, revert it
  before trying the next idea rather than layering fixes.
- After three failed repair attempts on the same error, stop and report the
  blocker with the log evidence.

The full rule set — floats, tables, equations, bibliography entries, and the list
of things not to do — is in `references/edit-safety.md`. Read it before any
structural change to a real manuscript.

## Step 6 — Prove the result visually

Call `latex_verify`:

```json
{ "pdf": "main.pdf", "expectCjk": true }
```

```json
{ "pdf": "main.pdf", "expectCjk": true, "render": true, "pages": "1-4" }
```

- `pdf` — the built PDF. Usually `latex_compile`'s `pdfPath`.
- `expectCjk` — default true; flags body pages carrying no Chinese. Set it false
  for an English-only project.
- `pages` — a string like `"1-3"` or `"1,4,7-9"`; which pages to render.
- `render` — `true` writes PNGs and returns their paths in `rendered` /
  `pagesRendered`. Default false: checks run over the whole document either way,
  so only ask for a render when you are going to look.
- `dpi` — default 110.

It reports `capability` / `verifyTool` honestly: `full`/`pymupdf`,
`text`/`pdftotext`, or `minimal`/`structure`. **Do not assume it is `full`** —
read what it says. The tiers do not see the same things: `minimal` does not check
even page count or CJK at all, and `text` cannot see glyph-level damage. State the
tier you actually got instead of implying a complete check.

The structural findings it returns: `capability` (how strong the check really
was), `blankPages`, `missingGlyphCount` / `missingGlyphs` (encoding damage and
missing glyphs together — U+FFFD, U+FFFF, tofu), `unresolvedRefPages` (`[?]`),
`literalCitePages` (a citation key printed literally), `zeroCjkPages`,
`perPageCjk`, and a flat `findings` list. It is a filter, not a verdict.
`missingGlyphs` entries are `{ char, code, count }`; the verifier does not
attribute them to a font — for that, use `latex_compile`'s `missingGlyphs`, which
does carry `font`.

**Then look at the pages.** With `render: true`, take each path from `rendered`
and open it with the image-reading tool — actually view it. That step is not
optional and no textual check replaces it. Check:

- Chinese characters render as characters, not boxes or blanks
- No content runs past the right margin
- Tables have visible rules and aligned columns
- Figures are not orphaned onto their own page without text
- Page count changed only as intended
- The title page and page numbers look right

The checker cannot see a table that is technically inside the margin but ugly, or
a figure that broke the reading order. It also cannot see a document that lost all
its Chinese but kept its Latin text — which is why `expectCjk` (on by default)
flags zero-CJK body pages; if it says "no findings" on a document that is supposed
to be Chinese, confirm `perPageCjk` is non-zero before believing it.

Two limits worth stating plainly: a literal citation key only shows up as a
bracket-shaped string under the LaTeX-default and manual-bibliography forms —
`natbib` renders `(?)` and `biblatex` renders the bare key, so `literalCitePages`
can be empty on a broken bibliography. And a zero exit code from a clean-room build
is still not a visual check.

## Reference index

All paths are relative to this skill directory:

- `references/compile-recipes.md` — exact commands per project shape, cleaning,
  out-of-tree builds, and the `latexmk` flag semantics. The hand-driven
  counterpart to `latex_compile`.
- `references/log-errors.md` — error-to-cause table with real log excerpts, and
  which `latex_compile` field carries each class.
- `references/cjk-and-fonts.md` — ctex/xeCJK/fontspec setup, GB/T 7714
  bibliography, and the font pitfalls on Windows.
- `references/edit-safety.md` — structural editing rules for chapters, floats,
  cross-references, and bibliography entries.
- `references/official-plugin-pitfalls.md` — the four measured failures of
  `openai-bundled/latex@0.2.8` on this machine, with root causes, and the
  capability gaps that motivated this plugin. Read before "restoring" anything
  to the official behaviour.

The verifier lives one level up, at `scripts/verify_pdf.py` in the plugin root.
The `latex_verify` tool drives it; read it directly only when you need to know
exactly what a finding means.

## Reporting

State, in this order: what was changed (files + reason), the exact engine and
command used, the build outcome with exit status, what the rendered PDF shows,
and what remains unresolved or unverified. Distinguish "compiled successfully"
from "visually verified" — they are different claims.
