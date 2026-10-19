#!/usr/bin/env python3
"""Build a gentle, stable-ID Anki package from one TMW frequency tier.

Requires the optional package: python3 -m pip install genanki==0.13.1
"""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import html
import json
import sqlite3
import tempfile
import zipfile
from pathlib import Path

TIERS = ("Student", "Trainee", "Debut", "Major", "Prima", "Divine", "Eternal", "Immortal", "Mythic")
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data" / "tmw-terms.json.gz"


def normalize_tier(label: object) -> str:
    first = str(label or "").split(",", 1)[0].strip().casefold()
    return next((tier for tier in TIERS if tier.casefold() == first), "")


def load_terms(source: Path = DEFAULT_SOURCE) -> list[dict[str, object]]:
    with gzip.open(source, "rt", encoding="utf-8") as stream:
        payload = json.load(stream)
    ranks = payload["ranks"]
    terms = []
    for row in payload["terms"]:
        if len(row) < 5 or not row[0] or not row[1]:
            continue
        try:
            source_rank = ranks[int(row[3])]
        except (IndexError, TypeError, ValueError):
            source_rank = ""
        terms.append({
            "id": str(row[4]),
            "term": str(row[0]).strip(),
            "reading": str(row[1]).strip(),
            "frequency": row[2],
            "tier": normalize_tier(source_rank),
        })
    return terms


def select_tier_terms(terms: list[dict[str, object]], tier: str) -> list[dict[str, object]]:
    canonical = normalize_tier(tier)
    if canonical != tier:
        raise ValueError(f"Choose exactly one canonical frequency tier: {', '.join(TIERS)}")
    return [term for term in terms if term["tier"] == canonical and term["id"] and term["term"] and term["reading"]]


def stable_numeric_id(label: str) -> int:
    digest = hashlib.sha256(label.encode("utf-8")).hexdigest()[:12]
    return int(digest, 16)


def _set_gentle_limits(collection_path: Path, deck_id: int, tier: str) -> int:
    with sqlite3.connect(collection_path) as connection:
        dconf_text, decks_text = connection.execute("SELECT dconf, decks FROM col").fetchone()
        options = json.loads(dconf_text)
        decks = json.loads(decks_text)
        base = options.get("1") or next(iter(options.values()))
        config_id = stable_numeric_id(f"TMW:{tier}:options")
        config = copy.deepcopy(base)
        config["id"] = config_id
        config["name"] = f"TMW {tier} · 5 new / 10 reviews per day"
        config.setdefault("new", {})["perDay"] = 5
        config.setdefault("rev", {})["perDay"] = 10
        options[str(config_id)] = config
        deck = decks[str(deck_id)]
        deck["conf"] = config_id
        connection.execute("UPDATE col SET dconf = ?, decks = ?", (json.dumps(options), json.dumps(decks)))
        note_count, card_count = connection.execute("SELECT (SELECT COUNT(*) FROM notes), (SELECT COUNT(*) FROM cards)").fetchone()
        if note_count != card_count:
            raise RuntimeError(f"Expected one card per note; got {note_count} notes and {card_count} cards.")
        return config_id


def card_templates() -> tuple[str, str]:
    question = '<main class="expression">{{Expression}}</main><div class="type-answer">{{type:Reading}}</div>'
    answer = ('{{FrontSide}}<hr id="answer"><main class="reading">{{Reading}}</main>'
              '<p class="details">{{Tier}} · frequency {{Frequency}}</p>'
              '<p class="source-id">Source ID: {{Term ID}}</p>')
    return question, answer


def build_package(terms: list[dict[str, object]], tier: str, output: Path) -> dict[str, object]:
    canonical = normalize_tier(tier)
    if canonical != tier:
        raise ValueError(f"Choose exactly one canonical frequency tier: {', '.join(TIERS)}")
    selected = select_tier_terms(terms, tier)
    if not selected:
        raise ValueError(f"No terms found for {tier}.")

    try:
        import genanki
    except ImportError as exc:
        raise RuntimeError("Install the optional package with: python3 -m pip install genanki==0.13.1") from exc

    model_id = stable_numeric_id(f"TMW:{tier}:model")
    deck_id = stable_numeric_id(f"TMW:{tier}:deck")
    question_template, answer_template = card_templates()
    model = genanki.Model(
        model_id,
        f"TMW {tier} · expression to reading",
        fields=[{"name": name} for name in ("Expression", "Reading", "Tier", "Frequency", "Term ID")],
        templates=[{
            "name": "Type reading",
            "qfmt": question_template,
            "afmt": answer_template,
        }],
        css="""
.card { font-family: system-ui, sans-serif; font-size: 22px; text-align: center; color: #242523; background: #fffefa; }
.expression { padding: 24px 8px; font-size: 42px; font-weight: 600; }
.type-answer { padding: 12px 8px; }
#typeans { width: min(90%, 20rem); padding: 9px 12px; border: 1px solid #b7aa97; border-radius: 8px; font-size: 22px; }
.typeGood { color: #27754d; }
.typeBad { color: #ae4538; }
.typeMissed { color: #987226; }
.reading { padding: 12px 8px; font-size: 30px; }
.details, .source-id { color: #65645f; font-size: 13px; }
#answer { border: 0; border-top: 1px solid #d8d1c5; }
""",
    )
    deck = genanki.Deck(
        deck_id,
        f"TheMoeWay::Frequency::{tier}",
        description=(f"{len(selected)} TMW frequency terms in the {tier} tier. Expression front; reading, tier, frequency, "
                     "and stable source ID on the answer. This dictionary contains no English definitions. "
                     "Gentle limits: 5 new cards and 10 reviews per day."),
    )
    for term in selected:
        fields = [
            html.escape(str(term["term"])),
            html.escape(str(term["reading"])),
            html.escape(str(term["tier"])),
            html.escape(str(term["frequency"] if term["frequency"] is not None else "")),
            html.escape(str(term["id"])),
        ]
        deck.add_note(genanki.Note(
            model=model,
            fields=fields,
            guid=genanki.guid_for(str(term["id"])),
            tags=["TMW", f"tier_{tier.lower()}"],
        ))

    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="anki-tier-") as temp_dir:
        temp_path = Path(temp_dir)
        raw_package = temp_path / "raw.apkg"
        collection = temp_path / "collection.anki2"
        genanki.Package(deck).write_to_file(str(raw_package))
        with zipfile.ZipFile(raw_package) as package:
            collection.write_bytes(package.read("collection.anki2"))
            media = package.read("media")
        config_id = _set_gentle_limits(collection, deck_id, tier)
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as package:
            package.write(collection, "collection.anki2")
            package.writestr("media", media)

    return {
        "path": str(output.resolve()),
        "tier": tier,
        "notes": len(selected),
        "cards": len(selected),
        "deck": f"TheMoeWay::Frequency::{tier}",
        "new_per_day": 5,
        "reviews_per_day": 10,
        "options_id": config_id,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", required=True, choices=TIERS)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    output = args.output or ROOT / f"themoeway-{args.tier.lower()}.apkg"
    metadata = build_package(load_terms(args.source), args.tier, output)
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
