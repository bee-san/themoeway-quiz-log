#!/usr/bin/env python3
"""Build the locally served, compact TMW frequency dictionary asset."""

from __future__ import annotations

import gzip
import json
import pathlib
import sys

EXPECTED_TERMS = 243_795
EXPECTED_SOURCE_ROWS = 243_796
EXPECTED_EMPTY_ROWS = 1


def bank_number(name: str) -> int:
    return int(name.removeprefix("term_bank_").removesuffix(".json"))


def build(source_zip: pathlib.Path, output: pathlib.Path) -> tuple[int, int]:
    import zipfile

    ranks: list[str] = []
    terms: list[list[object]] = []
    seen: set[tuple[str, str]] = set()
    source_rows = 0
    empty_rows = 0
    with zipfile.ZipFile(source_zip) as archive:
        names = sorted(
            (name for name in archive.namelist() if name.startswith("term_bank_") and name.endswith(".json")),
            key=bank_number,
        )
        if not names:
            raise ValueError("No term banks found in the source archive")
        for name in names:
            bank = bank_number(name)
            rows = json.loads(archive.read(name))
            metadata = json.loads(archive.read(f"term_meta_bank_{bank}.json"))
            if len(rows) != len(metadata):
                raise ValueError(f"{name}: {len(rows)} terms but {len(metadata)} metadata rows")
            for row_index, (term_row, meta_row) in enumerate(zip(rows, metadata, strict=True), start=1):
                source_rows += 1
                expression, reading = str(term_row[0]), str(term_row[1])
                if expression != meta_row[0] or reading != meta_row[2].get("reading"):
                    raise ValueError(f"Term/metadata mismatch in {name}: {expression} ({reading})")
                if not expression.strip() or not reading.strip():
                    empty_rows += 1
                    continue
                key = (expression, reading)
                if key in seen:
                    raise ValueError(f"Duplicate expression/reading pair: {key}")
                seen.add(key)
                frequency = meta_row[2].get("frequency", {})
                rank = str(frequency.get("displayValue", ""))
                if rank not in ranks:
                    ranks.append(rank)
                terms.append([expression, reading, int(frequency.get("value", 0)), ranks.index(rank), f"term_bank_{bank}:{row_index}"])
    if source_rows != EXPECTED_SOURCE_ROWS:
        raise ValueError(f"Expected {EXPECTED_SOURCE_ROWS} source rows, found {source_rows}")
    if empty_rows != EXPECTED_EMPTY_ROWS:
        raise ValueError(f"Expected {EXPECTED_EMPTY_ROWS} empty placeholders, found {empty_rows}")
    if len(terms) != EXPECTED_TERMS:
        raise ValueError(f"Expected {EXPECTED_TERMS} usable terms, found {len(terms)}")
    payload = {
        "title": "TMW v2",
        "attribution": "TMW; Vignes, Claude",
        "sourceRows": source_rows,
        "emptyRowsSkipped": empty_rows,
        "ranks": ranks,
        "terms": terms,
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as file:
        with gzip.GzipFile(fileobj=file, mode="wb", compresslevel=9, mtime=0) as compressed:
            compressed.write(raw)
    return len(terms), output.stat().st_size


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: build_dictionary.py SOURCE.zip OUTPUT.json.gz")
    count, size = build(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
    print(f"Built {count:,} aligned terms ({size:,} compressed bytes)")
