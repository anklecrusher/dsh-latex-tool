# Log Errors: Cause and Fix

Every entry below was reproduced on this machine with TeX Live 2026 unless noted.

`latex_compile` already parses the log it produces: its `errors` array carries
`file` / `line` / `message`, and `missingGlyphs`, `missingCitations`,
`missingReferences`, `missingPackages`, `overfull` each collect one class of
trouble. Read that first. This page is for when the parsed result is empty but the
PDF is still wrong, or when you need to explain the cause to the author.

## Reading the log

Use `-file-line-error`, then errors are greppable:

```bash
grep -nE "^\./[^:]+:[0-9]+:|^! " main.log | head -30
```

`latex_compile` passes `-file-line-error` and `-halt-on-error` for you, and its
`logPath` field points at the log it produced (under `.latex-build/` by default,
or the temp output directory with `outDir: "temp"`).

Real examples from this machine:

```
./bad.tex:4: Undefined control sequence.
! LaTeX Error: File `notapackagexyz.sty' not found.
./mp.tex:3: Emergency stop.
./mp.tex:3:  ==> Fatal error occurred, no output PDF file produced!
```

**Read the first one.** Everything after the first hard error is cascade noise.

## Error table

### `File \`X.sty' not found`

```
! LaTeX Error: File `notapackagexyz.sty' not found.
! Emergency stop.
!  ==> Fatal error occurred, no output PDF file produced!
```

Check whether it exists anywhere in the distribution:

```bash
kpsewhich notapackagexyz.sty     # empty output = absent
LC_ALL=C tlmgr info <package>
```

`latex_compile` reports these under `missingPackages`. Fix: install with
`tlmgr`, or replace with an available equivalent. Do not fabricate a stub `.sty`.

### `Undefined control sequence`

The macro does not exist: typo (`\citep` without `natbib`), a package not loaded,
or a command from a class the project no longer uses. The reported line is where
it is *used*; the cause may be a missing `\usepackage` in the preamble.

Common real typos: `\beginn{`, `\endd{`, `\hlin`, `\usepacakge`,
`\documentclas`, `\capton`, `\labl`, `\incluegraphics`, `\seciton`.

### `Missing $ inserted`

Math content outside math mode, or a stray `_`/`^`/`\alpha` in text. Also fires
when a `$` is unbalanced earlier in the paragraph — look upstream from the
reported line.

### `Runaway argument` / `Paragraph ended before ... was complete`

An unclosed brace or an unclosed `\begin{...}`. Count braces from the reported
line *backwards*, ignoring braces inside comments (`%`), inside `\verb`, and
escaped `\{`/`\}`.

### `begin{X} ended by \end{Y}`

Environment mismatch; both names appear in the message. Usually a missing
`\end{X}` earlier, causing nesting to slide.

### `Citation 'key' undefined`

Distinguish three cases:

1. Backend never ran — look for `Package biblatex Warning: Please (re)run Biber`
   surviving the final pass, or `backendRan: false` in the `latex_compile`
   result.
2. Key really is missing — the `.blg` file names it:
   ```
   WARN - I didn't find a database entry for 'nosuchkey' (section 0)
   ```
   `latex_compile` collects these under `missingCitations`.
3. `\bibliography`/`\addbibresource` path wrong — the PDF then shows the damage
   directly. Verified on this machine with `--interaction=nonstopmode`, all exits
   0: `natbib` + `\citep{nokey}` renders `(?)` and `\cite{nokey}` renders a bare
   `?`; `biblatex` + `\parencite{nokeyatall}` renders the bare key
   `nokeyatall`, with no brackets at all. So the `[key]` / `[?]` shapes that
   `latex_verify` looks for are the LaTeX-default and manual-bibliography forms —
   a missing key under natbib or biblatex can slip past that particular test.
   When the PDF is supposed to carry citations, look at the rendered page.

Fix by adding the entry or correcting the key. Never replace a missing citation
with a fabricated reference.

### `Reference 'r' undefined`

Usually just needs another pass. If it persists after a full `latexmk` run, the
`\label` truly does not exist, or it is inside a float that got dropped, or the
`\ref` appears in a chapter excluded by `\includeonly`.
`latex_compile` collects the keys under `missingReferences`.

### `Overfull \hbox (Npt too wide)`

Not a build failure. Content exceeds the line width by `Npt`. Verified with a
`\makebox[3\textwidth]`:

```
Overfull \hbox (690.0pt too wide) in paragraph at lines 3--4
```

`latex_compile` returns these as `overfull: [{kind, amountPt, line}]`.

Fixes: rephrase, allow hyphenation/login, reduce `\tabcolsep`, use
`\resizebox`/`adjustbox`, or restructure the table. Check the rendered page — a
large overfull often means content is physically off the paper.

`Underfull \hbox` is cosmetic badness, usually ignorable.

### `Missing character: There is no X (U+NNNN) in font Y`

**The most dangerous quiet failure.** Exit code stays 0 and the PDF builds, but
the glyph is blank or tofu.

Verified:

```
Missing character: There is no 𠀀 (U+20000) in font SimSun/OT:script=hani;langua
Missing character: There is no 😀 (U+1F600) in font [lmroman10-regular]:mapping=
Missing character: There is no α (U+03B1) in font [lmroman10-regular]:mapping=
```

`latex_compile` returns these under `missingGlyphs` (`char`, `code`, `font`,
`count`), and `latex_verify` confirms the damage independently by finding
U+FFFD/U+FFFF/tofu in the extracted text. The two should agree; if the log says
nothing and verification finds glyphs, suspect a font substitution rather than a
missing codepoint.

The third line is instructive: a Greek letter `α` typed in **text mode** under
`ctexart` with a Latin main font gets no glyph. Use math mode (`$\alpha$`), or a
font that covers Greek in text.

For Chinese: if the main CJK font lacks a rare character, set a fallback font
(`xeCJK`/`ctex` support fallback lists) or accept and document the substitution.
Never silently ignore this warning in a thesis.

### `Label(s) may have changed. Rerun to get cross-references right.`

Normal on early passes. `latexmk` reruns automatically. If it survives the final
pass, something is genuinely unstable (e.g. a counter used in a label).

### `Package biblatex Warning: Please (re)run Biber`

Normal mid-build under `latexmk`. Survives only if the backend did not run;
`latex_compile` reports that as `backendRan: false`.

### `perl: warning: Setting locale failed` (stderr, not the log)

Cosmetic, produced by TeX Live's Perl tooling on Windows. Silence with
`LC_ALL=C LANG=C` in front of the command. Do not treat as a build problem.

One consequence worth knowing: on this machine the warning comes first on
stderr, so a "take the first non-empty line" version reader reports the warning
instead of the version. `latex_doctor` matches
`/Latexmk.*?Version\s+([\d.]+)/` for exactly this reason, and returns both
`latexmkVersion` and the raw `latexmkDetail` line.

### `I can't find file 'main.tex'`

Wrong working directory, or the filename has non-ASCII characters that the shell
mangled. On Windows + Git Bash, a corrupted filename surfaces as
`FileNotFoundError` from Python or this message from TeX, not as an encoding
complaint. Quote paths and prefer running from the project directory.

### `Latexmk: Filename ... contains character not allowed for TeX file`

The source path contains one of `$ % \ ~` (or a control character). Almost always
an 8.3 short temp path (`C:\Users\NAME~1\...`) handed to `latexmk`. Exit code is
255, before any engine runs. `latex_compile` avoids it by resolving the temp
directory with `fs.realpathSync.native()`; by hand, resolve the long path first.
See `official-plugin-pitfalls.md`.

### Garbled or crashed output instead of a log

Non-ASCII project paths make `latexmk` emit GBK bytes on this machine while the
rest of its output is UTF-8. A reader that assumes one encoding either raises
`UnicodeDecodeError` or prints mojibake. `latex_compile` takes raw bytes and
decodes twice (UTF-8, then GBK on U+FFFD), so its `stdoutTail` is readable. If
you re-run the command by hand under a non-ASCII path, set
`LC_ALL=C LANG=C` to force a single locale.

## Systematic debug loop

1. Reproduce with the exact documented command.
2. `grep` the first `^\./` or `^! ` line.
3. Read ±15 lines around it in the log and the matching source line.
4. Form **one** hypothesis.
5. Change **one** thing.
6. Rebuild.
7. If unchanged, revert and form a different hypothesis.

After three unproductive attempts, stop and report: the exact error, the log
excerpt, what you tried, and what you need from the author.
