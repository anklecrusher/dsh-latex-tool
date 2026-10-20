# Official LaTeX Plugin Pitfalls

Measured failures of `openai-bundled/latex@0.2.8` on this Windows machine, and
what `@local/dsh-latex-tool` does instead. Read this before "fixing" the local
plugin back toward the official one, or before reporting a LaTeX bug that turns
out to be a tooling bug.

Source paths below refer to the installed copy at
`<codex-plugins>/cache/openai-bundled/latex/0.2.8/`. Line numbers are from that
exact version; a different version may have moved them.

The four failures share one shape: **the build failure is reported as a LaTeX
problem, but the LaTeX project is fine.** That is why they cost time.

---

## F1 — `latex-doctor` always says "not ready" on Windows

**Symptom.** `latex_doctor.py` reports `ready: false` and
`TeX Live smoke test: failed`, although TeX Live is installed, on `PATH`, and
compiles by hand. The smoke log ends with:

```
Latexmk: Filename 'C:/Users/ANKLEC~1/AppData/Local/Temp/codex-latex-doctor-XXXX/smoke.tex' contains character not allowed for TeX file.
Latexmk: Stopping because of bad filename(s).
runscript.tlu:933: command failed with exit code 255
```

`exitCode: 255`, no PDF, `ready: false` forever — the plugin is unusable even
though the machine is fine.

**Root cause.** `latex_doctor.py:35` creates its scratch directory with
`tempfile.TemporaryDirectory(prefix="codex-latex-doctor-")`. Python's
`tempfile.mkdtemp()` inherits the value of `%TEMP%`, and on this machine `%TEMP%`
is the **8.3 short name** `C:\Users\ANKLEC~1\AppData\Local\Temp` (note `~1`).
The smoke `.tex` path is then passed to `latexmk`, and `latexmk` refuses it:

`latexmk.pl` line 373:

```perl
our $illegal_in_texname = "\x00\t\f\n\r\$%\\~\x7F";
```

`~` is in that set, and the check runs *before* any engine starts. Nothing about
the document is wrong; the temp directory name is.

**Evidence.** Reproduced directly:

```python
import tempfile
tempfile.mkdtemp()
# 'C:\\Users\\ANKLEC~1\\AppData\\Local\\Temp\\tmpy7wy4hr7'   <- short name
```

Feeding a `.tex` from that directory to `latexmk` gives exit 255 with the message
above, while the same document in a long-named directory compiles cleanly.

**Fix in this plugin.** Every temp directory is resolved through
`fs.realpathSync.native()` before use, and the long name is what gets passed to
`latexmk`:

```
fs.realpathSync(d)        -> C:\Users\ANKLEC~1\AppData\Local\Temp\probe-XXXX
fs.realpathSync.native(d) -> C:\Users\ankle crusher\AppData\Local\Temp\probe-XXXX
```

The distinction is load-bearing: the non-native `realpathSync` **does not** expand
the short name on Windows (measured three times, same result), the native variant
does. `latex_doctor` exposes both halves of the fix as data — `tempRaw` (what
`%TEMP%` actually said), `tempResolved` (the long form used), and
`shortNameFixed` (whether they differed) — so the next occurrence is visible
instead of silent.

---

## F2 — Crash on any project under a non-ASCII path

**Symptom.** `compile_latex.py` raises, with no build attempted:

```
UnicodeDecodeError: 'utf-8' codec can't decode byte 0xd6 in position 1073: invalid continuation byte
```

It only happens when the project path contains Chinese (or any non-ASCII)
characters. The same project in an ASCII path works.

**Root cause.** `compile_latex.py:245` runs the compiler with `text=True` and no
`encoding=`, so Python decodes with the locale default. On this machine
`PYTHONUTF8=1` makes that UTF-8, while `latexmk`'s own output for the non-ASCII
path is **GBK** (it echoes the path back in the console code page, which is
CP936). Two encodings in one stream, one of them wrongly assumed.

**Evidence.** Running `latexmk` under a Chinese path and catching the raw bytes
shows a single GBK-only sequence inside otherwise-UTF-8 output:

```
utf-8 FAIL at 1058 byte= 0xd6
raw: .../dsh-latex-skillprobe/\xd6\xd0\xce\xc4\xcf\xee\xc4\xbf/t.tex
gbk: .../dsh-latex-skillprobe/中文项目/t.tex
```

(The failing byte is `0xd6` here; the exact value depends on which characters the
path contains — it is always the first byte of a GBK-encoded Chinese character.)

**Fix in this plugin.** Two independent layers:

- Node side: subprocesses run with `text: false` and yield Buffers; the decoder
  tries UTF-8 first and, if U+FFFD appears, re-decodes the same buffer as GBK
  (CP936). Mixed streams therefore survive.
- Python side (`scripts/verify_pdf.py`): stdout is forced to UTF-8 with
  `sys.stdout.reconfigure(encoding="utf-8")` and a binary-layer fallback, so a
  JSON payload carrying Chinese is written correctly even though the default
  Windows stdout encoding is GBK.

---

## F3 — Managed TeX Live install is dead code on Windows

**Symptom.** The `texlive-runtime-installer` skill offers to install a
Codex-managed TeX Live. On Windows it always fails with an error that reads like a
bug in the user's setup:

```
RuntimeError: Managed TeX Live install is currently supported on macOS and Linux only.
```

**Root cause.** `install_texlive.py:78`:

```python
if sys.platform.startswith("win"):
    raise RuntimeError(
        "Managed TeX Live install is currently supported on macOS and Linux only."
    )
```

The branch is unconditional. There is no Windows implementation to reach, so the
capability advertised by the plugin cannot exist on this platform.

**Fix in this plugin.** No managed install, and no pretence of one.
`latex_doctor` only reports what is missing — `status`, `checks[]`,
`packages[].found`, `engines[].present` — and leaves the decision (install, switch
installation, or stop) to the human. Unknown state is reported as unknown; it is
never guessed at.

---

## F4 — Version reader reports the Perl warning instead of the version

**Symptom.** Diagnostics show:

```json
"commands": { "latexmk": { "version": "perl: warning: Setting locale failed." } }
```

Every TeX Live tool looks like it has the same "version".

**Root cause.** `detect_texlive.py:91-93` runs `latexmk -norc -v` and returns
`first_nonempty_line(output)` (the helper is defined at line 77). But TeX Live's
`latexmk` is a Perl wrapper, and on this machine Perl fails to set the locale, so
it writes a multi-line warning to stderr **first**:

```
0: 'perl: warning: Setting locale failed.'
1: 'perl: warning: Please check that your locale settings:'
...
13: 'Latexmk, John Collins, 9 March 2026. Version 4.88'
```

`subprocess` merges stderr into stdout (`stderr=subprocess.STDOUT`), so line 0 is
the warning. The version is on line 13 and is never read.

**Fix in this plugin.** Match the version out of the text instead of taking the
first line:

```js
/Latexmk.*?Version\s+([\d.]+)/
```

`latex_doctor` returns `latexmkVersion: "4.88"` plus `latexmkDetail` with the
full matched line, so a future format change is visible rather than silently
producing the same wrong answer. Verified against this machine's real output.

---

## Capability gaps, not just bugs

The four failures above are fixable in place. The table below is different: these
are things the official plugin **does not attempt**, so no amount of patching
reaches them. This is the actual reason the local plugin exists.

| Capability | `openai-bundled/latex@0.2.8` | `@local/dsh-latex-tool` |
| --- | --- | --- |
| Engine inference | `--engine` flag defaulting to `pdflatex` (`compile_latex.py:390`); no reading of `\documentclass` or packages. A `ctexart` project silently builds with the wrong engine, or with no engine flag at all — which yields DVI, not PDF. | Reads the `% !TEX program` magic comment, then `\documentclass` (`ctex*` → `xelatex`), then `\usepackage` (`fontspec`/`xeCJK` → `xelatex`, `luacode` → `lualatex`), then falls back to `pdflatex`. Reports `engineSource` and `engineObserved`. |
| CJK / ctex awareness | None. No mention of `ctex`, `xeCJK`, `fontspec`, or any GB standard anywhere in the scripts. | Knows `ctex`/`xeCJK`/`fontspec` and the CJK font situation; `latex_doctor` reports whether `ctex` and `biblatex-gb7714-2015` are actually installed. |
| Log parsing | `exitCode` plus the **last 8000 characters** of the log (`compile_latex.py:253`). The first error — the one that matters — is exactly what gets truncated away on a long build. | Structured: `errors[{file, line, message}]`, `missingGlyphs`, `missingCitations`, `missingReferences`, `missingPackages`, `overfull`, `findingsWarnings`, `backendRan`, plus separate `warnings` for tooling messages. |
| Output verification | `pdfExists: true/false` (`compile_latex.py:252`). That is the whole check. A PDF full of tofu and blank pages passes. | Three tiers: PyMuPDF (blank pages, CJK counts, U+FFFD, tofu, missing glyphs, unresolved refs, literal cite keys), `pdftotext -enc UTF-8`, then PDF structure only — and it reports which tier answered via `capability` / `verifyTool` instead of claiming full fidelity. Can render pages to PNG for a human look. |
| Chinese path handling | Crashes (F2). | Double-decodes UTF-8 → GBK. |
| Temp path / 8.3 names | Broken (F1). | `realpathSync.native()`, with `tempRaw`/`tempResolved` reported. |
| Edit discipline | None — nothing tells the model not to delete content to force a build, or to keep `\label`/`\cite` keys intact. | `skill/references/edit-safety.md`, enforced in the workflow: change one thing, rebuild, never comment out content, never edit journal `.cls`. |
| GB/T 7714 bibliography | None. | `biblatex-gb7714-2015` guidance, style-variant list, author-year vs numeric, backend detection. |
| Rendering for visual proof | None. | `latex_verify` with `render: true` returns PNG paths; the workflow requires looking at them. |

---

## A note on the bundled Tectonic

Not one of the four above, but measured while reproducing them: `0.2.8` ships
`detect_tectonic.py` and prefers "bundled Tectonic" in `plugin.json`, yet
`<plugins>/cache/openai-bundled/latex/0.2.8/bin/tectonic.exe` **does not exist**
in the installed copy, and detection reports
`{"status": "missing", "reason": "No app, bundled, or PATH Tectonic executable was found."}`.
So on this machine the "Tectonic first" path never runs and everything degrades to
TeX Live — one more reason the reported failure lookups point at TeX Live paths
the user did not choose.

The local plugin does not bundle or shell out to Tectonic at all. One toolchain,
reported accurately, beats two with a silent fallback.
