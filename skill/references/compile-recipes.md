# Compile Recipes

The hand-written commands on this page are **for cross-checking and
troubleshooting only**. Day to day, call the `latex_compile` tool: it infers the
engine from the source, adds `-norc`, restores 8.3 short names on the temp path,
and decodes the mixed UTF-8/GBK output. Reach for `latexmk` by hand when the tool
reports something you do not understand, when you want to reproduce a failure in
isolation, or when a project needs a flag the tool does not pass.

The commands were verified against TeX Live 2026 (bin directory
`.../texlive/2026/bin/windows` on this machine). See the end of this page for
why that path is described rather than hard-coded.

## Canonical commands

### Chinese thesis / `ctex*` class

```bash
latexmk -xelatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex
```

### English journal paper

```bash
latexmk -pdf -interaction=nonstopmode -halt-on-error -file-line-error main.tex
```

### LuaLaTeX project

```bash
latexmk -lualatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex
```

### Verification build in an isolated directory

```bash
rm -rf .build-verify
latexmk -xelatex -interaction=nonstopmode -halt-on-error -file-line-error \
        -outdir=.build-verify main.tex
```

`latex_compile` does the equivalent with `outDir: "temp"`, which keeps the
project tree free of build products entirely.

### Clean

```bash
latexmk -c        # remove aux files, keep PDF
latexmk -C        # remove everything including PDF
```

## Why the engine flag is mandatory

Verified: `latexmk -interaction=nonstopmode main.tex` on a `ctexart` project
produces **`main.dvi`**, not `main.pdf`, and exits 0. The class asks for the
classic DVI route, and `latexmk` follows. A "missing PDF" after a successful run
usually means this, not a build failure:

```
Log file says output to 'main.dvi'
latexmk: All targets (main.dvi) are up-to-date
```

Always pass `-pdf`, `-xelatex`, or `-lualatex`.

## Finding the TeX installation without hard-coding it

Every command above assumes `latexmk` is on `PATH`. On a machine whose `PATH` is
not repaired, either of these locates the real bin directory without guessing:

```bash
kpsewhich -var-value=TEXMFROOT          # the TeX Live root, if a binary answers
where latexmk                           # Windows: first hit wins
command -v latexmk                      # POSIX shells
```

`latex_doctor` performs this probe for you and reports `texBin`, `texVersion`,
`latexmkVersion` and `texSource` (which of config / kpsewhich / probe / PATH
succeeded). If it reports `status: "missing"` or `"degraded"`, read its
`checks` array before compiling anything — a stale shell is a common cause.

One measured detail, if you must do this by hand: inside Git Bash only the POSIX
mount form works in `PATH` (`/d/Program Files (x86)/texlive/2026/bin/windows`).
The `D:/Program Files/...` form works as an argument to the binary but does
**not** resolve as a `PATH` element.

## Multi-file projects

`\include{chapters/ch1}` works with `latexmk` unchanged; errors are reported
against `chapters/ch1.tex`. Edit the child file.

`\include` forces a page break. For content that must flow, use `\input`.

`\includeonly{chapters/ch1}` speeds up iteration but leaves cross-references to
excluded files undefined — do not treat those warnings as real breakage, and do a
full build before claiming success.

## Bibliography

| Source uses | Backend | latexmk handles it |
| --- | --- | --- |
| `\bibliography{refs}` + `\bibliographystyle{...}` | bibtex | yes |
| `\addbibresource{refs.bib}` + `\printbibliography` | biber | yes |
| `biblatex` with `backend=bibtex` | bibtex | yes |
| `\printbibliography` but no `\addbibresource` | — | no entries; silent empty bibliography |

`latexmk` reads the `.bcf`/`.aux` and runs the right backend. Verified on a
`ctexart` + `biblatex` + `gb7714-2015` + biber project: 1 engine pass, `biber`,
then 2 more passes, all automatic. `latex_compile` reports the detected backend
in its `bibliography` field.

`biblatex-gb7714-2015` usage:

```latex
\usepackage[backend=biber,style=gb7714-2015]{biblatex}
\addbibresource{refs.bib}
```

Style files present on this machine include `gb7714-2015`, `-2015ay`, `-2025`,
`-1987`, `-2005`, plus school variants `gb7714-CCNU`, `gb7714-SEU`,
`gb7714-NWAFU`. `kpsewhich gb7714-2015.bbx` confirms availability, and
`latex_doctor` lists it under `packages`.

Warning to expect while iterating: `Package biblatex Warning: Please (re)run
Biber`. On the first `latexmk` pass this is normal and self-heals. If it survives
the final pass, the backend genuinely did not run.

## Diagnosing a build that produces nothing

```bash
latexmk -xelatex -interaction=nonstopmode -halt-on-error main.tex 2>&1 | tail -20
ls -la main.pdf
grep -nE "^\./[^:]+:[0-9]+:" main.log | head
```

Check, in order: did the engine start at all (no log means a bad filename), is
the root document the one you think, did `\documentclass` fail, and does the
`-halt-on-error` line name a file that exists.

`latex_compile` already returns this for you in a parsed form — `errors`,
`headline`, `stdoutTail`, `stderrTail` — so read its output first and only drop
to the commands above when the parsed result contradicts the raw log.

## Out-of-tree builds and includes

`-outdir` works for output, but `\input`/`\include` paths resolve relative to the
**source** file's directory, not the output directory, which is what you want.
Graphics with relative paths likewise resolve from the source tree. If a project
uses `\graphicspath`, do not duplicate it.

## Windows filename constraints

`latexmk` refuses a source path containing any of
`NUL TAB FF LF CR $ % \ ~ DEL` (its own `$illegal_in_texname` list, line 373 of
`latexmk.pl`). An 8.3 short path such as `C:\Users\NAME~1\...` contains `~`, so a
build directory created with the short form fails with
`Filename ... contains character not allowed for TeX file` and exit 255.

This is why `latex_compile` resolves temp directories through
`fs.realpathSync.native()` before using them: the short name becomes the long
name and the constraint no longer bites. If you ever build by hand in a temp
directory on Windows, resolve the long form first.

## tlmgr (installing missing packages)

```bash
LC_ALL=C LANG=C tlmgr info <package>          # is it installed?
LC_ALL=C LANG=C tlmgr install <package>       # may require elevation
```

`tlmgr` is not invoked by the plugin — it reports what is missing and lets you
decide. `LC_ALL=C LANG=C` silences the Perl locale warning that otherwise floods
stderr.
