#!/usr/bin/env python3
"""Render a built PDF and report what a reader would actually see.

Why this exists: a LaTeX build exits 0 and writes a PDF even when glyphs are
missing, pages are blank, or Chinese silently degraded to tofu. This script turns
those into explicit findings.

Usage:
    python verify_pdf.py main.pdf                 # summary + page 1..3 PNGs
    python verify_pdf.py main.pdf --pages 1-5
    python verify_pdf.py main.pdf --png-dir out --dpi 130
    python verify_pdf.py main.pdf --expect-cjk    # fail if body pages lack CJK
    python verify_pdf.py main.pdf --json          # machine-readable
    python verify_pdf.py main.pdf --json --no-render   # check only, write no PNGs

`--json` writes exactly one JSON object to stdout (UTF-8, no other output) and
keeps the exit-code contract unchanged.

`--pages` and `--no-render` are independent of the check: **every** page is always
examined (CJK counts, blank pages, missing glyphs, unresolved refs). `--pages`
only picks which pages get rendered, and `--no-render` turns rendering off
entirely — no directory is created and no file is written, so `rendered` and
`pagesRendered` come back as empty arrays.

Requires PyMuPDF (`import fitz`). Everything else is standard library.

Exit codes: 0 clean, 1 findings that need a human, 2 usage/IO error.
In `--json` mode the JSON object is always written before exiting, including the
exit-2 cases (where it carries an `error` object).
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
from pathlib import Path
from typing import Any

CJK = re.compile(r"[\u4e00-\u9fff]")

# Characters that mean "the glyph could not be drawn".
#   U+FFFD  replacement character (encoding damage)
#   U+FFFF  noncharacter — what XeTeX/pdf extraction yields for a glyph the font
#           lacks; verified on this machine with a rare CJK Ext-B codepoint.
#   U+25A1/U+25A0  tofu boxes some fonts/readers emit.
REPLACEMENT = "\ufffd"
TOFU = "\u25a1\u25a0\ufffd\uffff"


def parse_pages(spec: str, total: int) -> list[int]:
    """Parse '1-5', '2', '1,3,7-9' into 1-based page numbers, clamped."""
    out: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            lo_s, _, hi_s = chunk.partition("-")
            lo, hi = int(lo_s), int(hi_s)
        else:
            lo = hi = int(chunk)
        lo = max(1, lo)
        hi = min(total, hi)
        out.extend(range(lo, hi + 1))
    return sorted(set(out))


def slash(path: Path | str) -> str:
    """Absolute path with forward slashes — stable on every consumer OS."""
    return str(Path(path).resolve()).replace("\\", "/")


def code_point(ch: str) -> str:
    return f"U+{ord(ch):04X}"


def empty_payload(pdf: Path, expect_cjk: bool) -> dict[str, Any]:
    """The full JSON contract with neutral values, for both the clean and the
    error path: an error response carries the same shape, just zeroed."""
    return {
        "file": slash(pdf),
        "sizeBytes": 0,
        "pages": 0,
        "perPageCjk": [],
        "zeroCjkPages": [],
        "blankPages": [],
        "replacementCharPages": [],
        "missingGlyph": {"total": 0, "codepoints": [], "pages": []},
        "unresolvedRefPages": [],
        "literalCitePages": [],
        "expectCjk": expect_cjk,
        "findings": [],
        "rendered": [],
        "pagesRendered": [],
        "error": None,
    }


def emit_json(payload: dict[str, Any]) -> None:
    """Write exactly one JSON object and nothing else to stdout.

    The document is serialized with ``ensure_ascii=False`` so Chinese survives
    readable and round-trips unchanged. The one exception is
    ``missingGlyph.codepoints[].char``: those are by definition broken glyphs
    (U+FFFD, U+FFFF, tofu boxes, astral codepoints), and a raw U+FFFF or a lone
    surrogate in the byte stream is exactly the kind of value a downstream
    parser should not have to wrestle with. Each one is emitted as its own JSON
    ``\\uXXXX`` escape — still a natural JSON escape, never a `"\\uffff"`
    literal string — by serializing that single character with
    ``ensure_ascii=True`` and splicing it in over a collision-proof token.
    """
    codepoints = payload.get("missingGlyph", {}).get("codepoints", [])
    tokens: list[tuple[str, str]] = []
    for i, entry in enumerate(codepoints):
        token = f"@@dsh-glyph-token-{i}@@"
        tokens.append((token, json.dumps(entry["char"], ensure_ascii=True)))
        entry["char"] = token

    text = json.dumps(payload, ensure_ascii=False)
    for token, literal in tokens:
        text = text.replace(f'"{token}"', literal)

    try:
        # On Windows the default is GBK; a surrogate that slipped through the
        # PDF text layer must not crash the writer either.
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[attr-defined]
        sys.stdout.write(text + "\n")
        sys.stdout.flush()
    except (AttributeError, ValueError):  # pragma: no cover - exotic stdout
        buffer = getattr(sys.stdout, "buffer", None)
        data = (text + "\n").encode("utf-8", "backslashreplace")
        if buffer is not None:
            buffer.write(data)
            buffer.flush()
        else:  # pragma: no cover - no binary layer at all
            sys.stdout.write(data.decode("ascii", "backslashreplace"))
            sys.stdout.flush()


def fail(
    json_mode: bool,
    payload: dict[str, Any],
    kind: str,
    message: str,
) -> int:
    """Usage/IO/dependency failure: exit 2, with full JSON in JSON mode."""
    if json_mode:
        payload["error"] = {"kind": kind, "message": message}
        emit_json(payload)
    else:
        print(f"error: {message}", file=sys.stderr)
    return 2


class UsageParser(argparse.ArgumentParser):
    """An ArgumentParser whose own errors still honour the JSON contract.

    argparse exits 2 on a bad flag by printing to stderr — which would leave a
    `--json` caller with exit 2, an empty stdout, and no way to learn why. When
    `--json` appears in argv, print the error object instead. The check is on
    argv rather than on the parsed namespace because argparse fails before the
    namespace exists.
    """

    def error(self, message: str) -> None:  # type: ignore[override]
        if "--json" in sys.argv[1:]:
            emit_json_with_error("usage", f"{self.prog}: {message}")
            # argparse's own exit code for a usage error. We must raise rather
            # than return, because a returned error() lets parsing continue with
            # a namespace that is missing required arguments.
            raise SystemExit(2)
        super().error(message)


def emit_json_with_error(kind: str, message: str) -> None:
    """Emit the zeroed contract with an error object, without a known PDF path."""
    payload = empty_payload(Path(""), False)
    # `Path("")` resolves to the cwd; an unparsed invocation has no PDF at all,
    # and reporting the working directory as the "file" would be a lie.
    payload["file"] = ""
    payload["error"] = {"kind": kind, "message": message}
    emit_json(payload)


def main() -> int:
    ap = UsageParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("pdf", type=Path)
    ap.add_argument(
        "--pages",
        default=None,
        help="pages to render, e.g. 1-3 or 1,4,7-9 (default: 1-3). Only selects "
        "which pages get rendered; every page is always checked",
    )
    ap.add_argument("--dpi", type=int, default=110)
    ap.add_argument(
        "--png-dir",
        type=Path,
        default=None,
        help="where to write PNGs (default: alongside the PDF)",
    )
    ap.add_argument(
        "--expect-cjk", action="store_true", help="report body pages with no CJK characters"
    )
    ap.add_argument("--quiet", action="store_true", help="only print findings (text mode)")
    ap.add_argument(
        "--no-render",
        action="store_true",
        help="do not render any page image; checks still cover every page",
    )
    ap.add_argument(
        "--json",
        action="store_true",
        help="write one JSON object to stdout; suppresses all human output",
    )
    args = ap.parse_args()

    json_mode = args.json
    # A render target is only meaningful when rendering is enabled. Passing
    # --png-dir together with --no-render must stay a no-op, directory included.
    render = not args.no_render
    if render:
        pages_spec = args.pages if args.pages is not None else "1-3"
    else:
        pages_spec = None

    payload = empty_payload(args.pdf, args.expect_cjk)

    if not args.pdf.is_file():
        return fail(json_mode, payload, "io", f"no such file: {args.pdf}")

    payload["sizeBytes"] = args.pdf.stat().st_size

    try:
        import fitz  # PyMuPDF
    except ImportError:
        return fail(
            json_mode,
            payload,
            "dependency",
            "PyMuPDF not installed (pip install pymupdf)",
        )

    try:
        doc = fitz.open(args.pdf)
    except Exception as exc:  # noqa: BLE001 - surface any reader failure plainly
        return fail(json_mode, payload, "reader", f"cannot open {args.pdf}: {exc}")

    findings: list[str] = []
    try:
        total = doc.page_count
        payload["pages"] = total

        # Validate --pages before printing anything, so a bad value fails cleanly.
        if pages_spec is None:
            wanted: list[int] = []
        else:
            try:
                wanted = parse_pages(pages_spec, total)
            except ValueError:
                return fail(json_mode, payload, "usage", f"bad --pages value: {pages_spec!r}")

        per_page_cjk: list[tuple[int, int]] = []
        blank_pages: list[int] = []
        replacement_pages: list[int] = []
        unresolved_pages: list[int] = []
        literal_cite_pages: list[int] = []
        glyph_counts: dict[str, int] = {}
        glyph_by_page: list[dict[str, int]] = []

        for i, page in enumerate(doc, start=1):
            text = page.get_text()
            # A page carrying only its running page number is still effectively
            # blank; do not let the number hide a layout accident.
            without_pagenum = re.sub(
                r"^\s*\d+\s*$", "", text.strip(), flags=re.MULTILINE
            ).strip()
            images = page.get_images()
            has_vector = bool(page.get_drawings())
            cjk_count = len(CJK.findall(text))
            per_page_cjk.append((i, cjk_count))

            if not without_pagenum and not images and not has_vector:
                blank_pages.append(i)
                findings.append(
                    f"page {i}: effectively blank (no text beyond a page number, "
                    f"no images, no vector content)"
                )
            if REPLACEMENT in text:
                replacement_pages.append(i)
                findings.append(
                    f"page {i}: contains U+FFFD replacement characters (encoding damage)"
                )
            if any(ch in text for ch in TOFU):
                missing = sum(text.count(ch) for ch in TOFU)
                glyph_by_page.append({"page": i, "count": missing})
                for ch in TOFU:
                    n = text.count(ch)
                    if n:
                        glyph_counts[ch] = glyph_counts.get(ch, 0) + n
                findings.append(
                    f"page {i}: {missing} glyph(s) failed to render "
                    f"(tofu/U+FFFF — check the log for 'Missing character')"
                )
            if re.search(r"\[\?\]", text):
                unresolved_pages.append(i)
                findings.append(f"page {i}: unresolved reference rendered as '[*?]'")
            # A citation key printed literally means the key was missing from the bib.
            if re.search(r"\[[a-zA-Z][A-Za-z0-9_:.-]{3,}\]", text):
                literal_cite_pages.append(i)
                findings.append(
                    f"page {i}: looks like a literal citation key in brackets "
                    f"(missing bib entry)"
                )

        zero_cjk = [n for n, c in per_page_cjk if c == 0]
        if args.expect_cjk:
            if len(zero_cjk) == total:
                findings.append("document is entirely non-CJK but --expect-cjk was given")
            elif zero_cjk:
                zero = ", ".join(str(n) for n in zero_cjk)
                findings.append(f"pages with zero CJK characters: {zero}")

        payload["perPageCjk"] = [c for _, c in per_page_cjk]
        payload["zeroCjkPages"] = zero_cjk
        payload["blankPages"] = blank_pages
        payload["replacementCharPages"] = replacement_pages
        payload["unresolvedRefPages"] = unresolved_pages
        payload["literalCitePages"] = literal_cite_pages
        payload["missingGlyph"] = {
            "total": sum(glyph_counts.values()),
            "codepoints": [
                {"char": ch, "code": code_point(ch), "count": n}
                for ch, n in sorted(glyph_counts.items(), key=lambda kv: ord(kv[0]))
            ],
            "pages": glyph_by_page,
        }

        # Render. A render failure is an IO error, not a document finding.
        png_dir = args.png_dir or args.pdf.parent
        written: list[Path] = []
        if wanted:
            try:
                png_dir.mkdir(parents=True, exist_ok=True)
                for n in wanted:
                    page = doc[n - 1]
                    out = png_dir / f"{args.pdf.stem}-p{n}.png"
                    page.get_pixmap(dpi=args.dpi).save(out)
                    written.append(out)
            except Exception as exc:  # noqa: BLE001 - report, never crash
                payload["rendered"] = [slash(p) for p in written]
                payload["pagesRendered"] = wanted[: len(written)]
                payload["findings"] = findings
                return fail(json_mode, payload, "io", f"cannot render page images: {exc}")

        payload["rendered"] = [slash(p) for p in written]
        payload["pagesRendered"] = list(wanted)
        payload["findings"] = findings
    finally:
        doc.close()

    if json_mode:
        emit_json(payload)
        return 1 if findings else 0

    # ---- text mode: unchanged human-readable format ----------------------
    if not args.quiet:
        print(f"file    : {args.pdf}")
        print(f"size    : {payload['sizeBytes']} bytes")
        print(f"pages   : {payload['pages']}")
        print("cjk/page:", " ".join(f"{n}:{c}" for n, c in per_page_cjk))
        for out in written:
            print(f"rendered: {out}")

    if findings:
        print("\nFINDINGS:")
        for f in findings:
            print(f"  - {f}")
        return 1

    if not args.quiet:
        print("\nno structural findings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
