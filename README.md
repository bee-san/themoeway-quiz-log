# TheMoeWay Quiz Log

A static weekly-quiz tracker. Quiz history, settings, and queued Anki outcomes are stored in this browser only. Back up and restore through the app; data is not synced between browsers and is not part of the public site.

## What it does

- Record weekly scores and follow accuracy, history, trend, and a rough next-quiz estimate after at least three results. The forecast uses a linear trend over up to six recent quizzes; it is not a promise.
- Save explicit word outcomes only. Wrong answers map to Anki **Again**; right answers map to **Good**. Aggregate scores never produce word grades.
- Grade only an exact expression-and-reading match that resolves to exactly one Anki note and one card in the chosen deck. Missing or ambiguous matches are left ungraded. Outcomes whose grade result cannot be verified are marked uncertain and are not automatically retried.
- Import a typed-answer `.apkg` for each of the nine canonical tiers: Student, Trainee, Debut, Major, Prima, Divine, Eternal, Immortal, and Mythic. Each front asks you to type the reading using Anki's `{{type:Reading}}` field; the answer reveals it. Each package sets 5 new cards and 10 reviews per day.
- Publish only the static app, dictionary, and decks. There are no seeded or personal quiz results in the static files.

## AnkiConnect setup

The app defaults to `http://127.0.0.1:8766`; change the port in AnkiConnect if needed. Anki must be running on the same computer as the browser. The app accepts only `127.0.0.1`, `localhost`, or `::1` endpoints; never bind AnkiConnect to a public or LAN interface.

Use an AnkiConnect Extended build that supports `requestPermission`, `findNotes`, `notesInfo`, `gradeNow`, and `getReviewsOfCards`. Allow the app's exact browser origin in the add-on's CORS/origin settings and approve the permission prompt. HTTPS hosting may also require browser permission for local-network access. A live connection to the user's Anki installation has not been verified in this project environment.

The API key, if configured, is entered for the current page session only and is not saved. Quiz results are saved locally before any Anki request. If Anki is offline, outcomes remain pending in local storage. Verify any uncertain grade in Anki before retrying it.

## Typed tier packages

Prebuilt packages are in `downloads/` and contain one deck each under `TheMoeWay::Frequency::<Tier>`:

- `themoeway-student-typing.apkg` — 345 cards
- `themoeway-trainee-typing.apkg` — 726 cards
- `themoeway-debut-typing.apkg` — 4,572 cards
- `themoeway-major-typing.apkg` — 6,027 cards
- `themoeway-prima-typing.apkg` — 6,427 cards
- `themoeway-divine-typing.apkg` — 6,908 cards
- `themoeway-eternal-typing.apkg` — 7,353 cards
- `themoeway-immortal-typing.apkg` — 5,559 cards
- `themoeway-mythic-typing.apkg` — 205,878 cards

Import a package in Anki using **File → Import**. The deck cards contain expression, reading, tier, source frequency, and stable source ID; there are no invented English definitions. Anki is the scheduler for these decks; the app does not create a second review queue for them.

To rebuild one package:

```sh
python3 -m pip install genanki==0.13.1
PYTHONPATH=/path/to/genanki python3 scripts/build_anki_tier.py \
  --tier Trainee --output downloads/themoeway-trainee-typing.apkg
```

## Run locally

```sh
npm install
npm run build
python3 -m http.server 8748 --bind 127.0.0.1 --directory .
```

Open `http://127.0.0.1:8748/`. The browser downloads the public dictionary only when you open AnkiConnect. On GitHub Pages or another HTTPS host, configure the exact site origin in AnkiConnect; the local API remains loopback-only.

The TMW frequency data is published with the source attribution carried in its metadata: TMW; Vignes, Claude. It contains expressions/readings/frequency tiers, not English definitions.

GitHub Pages: https://bee-san.github.io/themoeway-quiz-log/. Quiz history and preferences remain in browser-local storage and are never published. Browser storage is origin-specific: when moving from another host, export a backup there and restore it on this Pages site. Allow `https://bee-san.github.io` in AnkiConnect's origin settings; keep AnkiConnect bound to loopback.

## Tests

```sh
npm test
npm run build
```

Tests cover quiz parsing/analytics, explicit word outcomes, AnkiConnect matching and grade verification, local-storage backup/restore, frequency-tier normalization, and typed-card templates. Package files were additionally checked for ZIP/SQLite integrity, note/card counts, type-answer templates, and 5/10 limits. They have not been imported into a live Anki collection.
