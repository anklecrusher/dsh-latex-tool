# Edit Safety

Rules for changing a real manuscript without damaging it.

## Before editing anything

1. Read the target file completely, or at minimum the whole construct you are
   touching plus its enclosing environment.
2. Find the root document and confirm the file you are about to edit is actually
   compiled (a `.tex` sitting in the folder may be orphaned). `latex_compile`
   reports the root it chose as `texFile` and why the engine was picked as
   `engineSource` — use those two fields instead of guessing.
3. Grep for references **to** what you are about to change:

```bash
grep -rn "tab:results" --include=*.tex .
grep -rn "sec:method" --include=*.tex .
grep -rn "he2016deep" --include=*.tex .
```

4. Note whether the project is under version control (`git status`) — if it is,
   a bad edit is recoverable, which changes how boldly you proceed.

## Preserve these, always

- `\label{...}` keys and their `\ref{...}`/`\eqref{...}`/`\autoref{...}` targets
- `\cite{...}`/`\citet{...}`/`\parencite{...}` keys
- Numeric values, units, table cell contents, equation content
- Figure file paths and `\includegraphics` options
- Author comments (`% ...`), which often carry decisions and TODOs
- `.bib` field values — formatting changes are acceptable, content changes are not

## Structural edits

### Splitting or moving a chapter

- Move `\label`s with their content; a label left behind silently changes meaning.
- `\include` inserts a page break; `\input` does not. Choose deliberately.
- After moving, grep for every `\ref` to labels in the moved region and confirm
  they still resolve — rebuild and check that `latex_compile` reports an empty
  `missingReferences`, or that `latex_verify` finds no unresolved-ref pages.
- Chapter numbering depends on inclusion order — verify the TOC after moving.

### Moving or resizing a float

- Keep `\label` inside the `figure`/`table` environment, after `\caption`. A label
  before `\caption` binds to the wrong number.
- `[htbp]` is a request, not a command. If placement misbehaves, tighten the
  surrounding text or use `[H]` (`float` package) with judgment — `[H]` can create
  large gaps.
- Wide tables: prefer `\resizebox{\textwidth}{!}{...}` or `adjustbox` over
  guessing at `\tabcolsep`. Check the result visually — `latex_compile` reports
  the overfull amount in its `overfull` array, but only the rendered page shows
  whether it actually left the paper.

### Renaming a section

Renaming does not rename its label. Update the label separately if semantics
changed, and grep for the old label everywhere.

## Tables

- Every row needs the same number of `&` separators; `Extra alignment tab` comes
  from one too many.
- `\\` at the end of the last row before `\bottomrule` is required by `booktabs`.
- `\toprule`/`\midrule`/`\bottomrule` are `booktabs`; `\hline` is core LaTeX. Do
  not mix them in one table unless intentional — the spacing differs visibly.
- Merged cells: `\multicolumn{n}{c}{text}` changes the column count for that row
  only; recount `&` afterwards.
- Long tables that break across pages need `longtable`, not `tabular`.

## Equations

- `\begin{equation}` is numbered; `\[ ... \]` and `equation*` are not. Do not
  switch casually — numbering shifts all later references.
- `align` requires `&` alignment points; `split` nests inside `equation`.
- Multi-line math: `\\` inside `align` is a row break, not a line break in text.
- Punctuation at the end of a displayed equation is a style choice; match the
  surrounding manuscript.

## Bibliography edits

- Adding an entry: place it to match the file's ordering convention, keep the key
  convention, and verify the required fields for the entry type are present
  (`author`, `title`, `year`, plus `journal`/`booktitle`/`publisher` as
  appropriate).
- Do not rewrite an existing entry's authors or year to match what you believe —
  that is a factual change and belongs to the author.
- After editing the `.bib`, rebuild and confirm the citation resolves rather than
  showing the key in brackets. `latex_compile` reports `missingCitations` for
  keys the backend could not find, and `latex_verify` flags pages that still show
  a bracket-shaped key or `[?]`.
- Verify the DOIs you add actually exist. Fabricating a plausible DOI is worse
  than leaving the field blank.

## Rebuild discipline

- Rebuild after each meaningful batch, not after every character.
- If a batch breaks the build and the cause is not immediately obvious, revert
  that batch before trying the next idea. Layering fixes on a broken state
  produces a diff nobody can review.
- Keep the build log of the last good state when debugging; comparing "before" and
  "after" logs localizes a regression fast. `latex_compile` returns `logPath`, and
  copying that file aside before an edit gives you the baseline.

## What not to do

- Do not comment out a broken block to make the build pass. Fix it or report it.
- Do not edit `.cls`, `.sty`, `.bst` supplied by a journal or university.
- Do not add `\usepackage{...}` speculatively to silence an `Undefined control
  sequence` — find which package actually provides the macro.
- Do not delete `%` comments to "clean up".
- Do not change the engine to whatever happens to compile — an engine change
  alters font handling and output in ways the author may not expect.
- Do not report success based on `exitCode: 0` alone. A clean exit plus a PDF is
  "compiled"; only a rendered page makes it "verified".

## When stuck

After three attempts on the same error without progress:

1. Restore the file to its last compiling state.
2. Report: the exact error line, the log excerpt, the attempts made, and the
   specific information needed (which package version, which template the
   university requires, whether a missing figure is expected to exist).

An honest blocker with evidence is a better outcome than a silently corrupted
manuscript.
