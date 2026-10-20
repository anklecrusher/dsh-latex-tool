# CJK and Font Setup on Windows

## What this machine has

| Component | Version / status |
| --- | --- |
| TeX Live | 2026 (bin directory under `.../texlive/2026/bin/windows`) |
| `ctex` | 2.6.0 (2026/06/23) |
| `xeCJK` | 3.10.0 |
| `biblatex-gb7714-2015` | installed, styles through GB/T 7714-2025 |
| `biber` | 2.21 |
| System CJK fonts | `simsun.ttc`, `simhei.ttf`, `simkai.ttf`, `simfang.ttf`, `SIMLI.TTF`, `msyh.ttc` in the Windows Fonts directory |

Do not re-verify this by hand — `latex_doctor` returns the same facts as data:
`texVersion`, `engines[]`, `packages[]` (each with `name` / `file` / `found` /
`path`, including `ctex` and `biblatex-gb7714-2015`), `backends[]`, and `python`.
Treat its `status` field as the answer: `ready` means everything needed is
present, `degraded` means it will work but something is missing, `missing` means
stop.

If you want the raw confirmation anyway:

```bash
kpsewhich ctexart.cls
kpsewhich gb7714-2015.bbx
kpsewhich xeCJK.sty
```

## The engine question — verified behaviour

The common claim "`ctex` requires XeLaTeX" is **not literally true on this
machine**. Verified:

- `pdflatex` on a `\documentclass[UTF8]{ctexart}` document exits 0, produces a
  PDF, and text extraction returns the Chinese correctly. The class falls back to
  the `CJK` package with `ctex-zhmaps-windows` and draws glyphs from the system
  `simsun.ttc`.
- `latexmk` with no engine flag on the same document builds **DVI**, not PDF.

What is still true and important:

- `fontspec`, `\setmainfont`, `polyglossia` **require** XeLaTeX or LuaLaTeX.
  Building such a project with `pdflatex` fails outright.
- `xeCJK` requires XeLaTeX.
- `pdflatex` + `ctex` degrades **silently**: characters without a mapping are
  dropped with only a `Missing character` line, never an error.
- `xelatex` is what the class is designed for and handles mixed scripts, unusual
  punctuation, and emoji-adjacent codepoints more predictably.

**Rule:** use `xelatex` for `ctex*` projects. Treat "pdflatex produced a PDF" as
insufficient evidence that the output is correct.

`latex_compile` applies this rule automatically: `\documentclass{ctexart}` (and
`ctexrep`/`ctexbook`) maps to `xelatex` with `engineSource: "documentclass"`, and
a `% !TEX program = ...` magic comment wins over it. Check `engineSource` when you
need to know why an engine was chosen, and `engineObserved` for what the log says
actually ran — if `engine` and `engineObserved` disagree, the build did not do
what was intended.

Verified that all three engines render Chinese correctly here:

| Command | Result |
| --- | --- |
| `latexmk -xelatex` + `ctexart` | PDF, correct Chinese, `SimSun` embedded |
| `latexmk -lualatex` + `ctexart` | PDF, correct Chinese |
| `latexmk -pdflatex` + `ctexart` | PDF, correct Chinese via `CJK`/`simsun.ttc` |

## Recommended preamble for a Chinese thesis

```latex
\documentclass[UTF8, a4paper, 12pt]{ctexart}   % or ctexrep / ctexbook
\usepackage{amsmath, amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[backend=biber, style=gb7714-2015]{biblatex}
\addbibresource{refs.bib}
```

`UTF8` is the default in modern `ctex` but harmless to state explicitly.

`ctexrep` (report) and `ctexbook` (book) are the analogues of `report`/`book` and
are what a multi-chapter 学位论文 normally uses; `ctexart` has no `\chapter`.

### gb7714 style variants

Available `.bbx` files include `gb7714-2015`, `gb7714-2015ay` (author-year),
`gb7714-2015ms`/`mx`/`gbk`, `gb7714-2025`, `gb7714-1987`, `gb7714-2005`, plus
school packs `gb7714-CCNU`, `gb7714-SEU`, `gb7714-NWAFU` and `chinese-css` /
`chinese-erj` / `chinese-jmw` / `chinese-molc`.

Match the style to what the university's template specifies; do not silently
upgrade a 2015 requirement to 2025.

### Author-year vs numeric

`gb7714-2015` is numeric; `gb7714-2015ay` is author-year. Switching changes the
in-text form (`[1]` vs `(何, 2016)`) and the `\cite` command family. Use
`\citet{...}` for textual and `\citep{...}` for parenthetical under natbib-style
setup; `biblatex` uses `\textcite{...}` and `\parencite{...}`. Do not blanket
rewrite one family into another — meaning changes.

## Font pitfalls

### Windows font names vs file names

`fontspec` wants the **font name** ("SimSun", "Microsoft YaHei"), while
`xeCJK`'s `Path=` wants the **file name** (`simsun.ttc`). Mixing them yields
cryptic "font not found" errors.

```latex
% by name
\setCJKmainfont{SimSun}
% by file
\setCJKmainfont[Path=C:/Windows/Fonts/, BoldFont=simhei.ttf]{simsun.ttc}
```

Prefer the by-name form on Windows unless a specific weight is needed.

### Embedding

`SimSun` embeds by subset, which is fine for submission. Fonts licensed as
"print and preview only" may be rejected by some publishers; check the
destination's font policy if the manuscript is going to a journal.

### `Missing character` in a CJK document

Rare codepoints (CJK Ext-B `𠀀`, emoji, some symbols) may be absent from
`SimSun`. Options: switch to a font with coverage, set a fallback list, or
replace the character. Either way, look at the rendered page — the warning alone
does not tell you what the reader will see.

`latex_compile` surfaces the warning in `missingGlyphs`; `latex_verify` confirms
it from the PDF side by finding U+FFFD/U+FFFF/tofu in the extracted text.

### Latin and Greek in text mode

With a CJK main font, a bare `α` in text mode can lose its glyph. Put math in
math mode: `$\alpha$`. Same for operators and sub/superscripts.

## Bibliography gotchas

- `\addbibresource{refs.bib}` with no `\printbibliography` ⇒ entries compiled but
  never shown.
- `.bib` entries with duplicate keys: BibTeX fails, biber warns and keeps one.
- Non-ASCII in `.bib` is fine for biber (UTF-8); BibTeX traditionally is not. If
  a project mixes `\bibliography` with Chinese author names, expect trouble and
  prefer biber.
- `\{`/`\}` inside titles need escaping; braces are the parser's structure.
- `doi` and `url` fields: with `gb7714-2015`, add `\usepackage[doi=false]{biblatex}`
  or let it print DOIs depending on the required format.

## Smoke test

To prove the toolchain works end to end before touching the real manuscript, call
`latex_doctor` with `smoke: true`. It writes a tiny `ctex` document to a temp
directory, compiles it, checks that a PDF appeared, and removes the temp
directory afterwards. The result lands in its `smoke` field
(`ran` / `ok` / `exitCode` / `durationMs` / `detail`) — no hand-written commands
and no leftover files.

It costs about ten seconds, so run it once per session, not before every build.

If you need the manual equivalent — for instance because `latex_doctor` reports a
failure you want to see in full:

```bash
mkdir -p /tmp/tex-smoke && cd /tmp/tex-smoke
printf '\\documentclass[UTF8]{ctexart}\n\\begin{document}\n中文测试 ABC\n\\end{document}\n' > t.tex
latexmk -norc -xelatex -interaction=nonstopmode t.tex
```

On Windows, do not place this under an 8.3 short path — `latexmk` rejects `~` in
a file name and exits 255. Use a long path.

Expect the Chinese to come back as text (check with `latex_verify`, whose
`perPageCjk` should be non-zero). If it does not, fix the toolchain before
blaming the manuscript.
