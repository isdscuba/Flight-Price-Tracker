# Changelog

All notable changes to this project will be documented here.

## [1.1.0] - 2026-04-22

### Added
- **Three-source price comparison:** Every check now fetches prices from Google Flights (Cloud Run scraper), fli Scanner (reverse-engineered Google Flights API via `pip install flights`), and Travelpayouts in parallel.
- **fli Scanner endpoint** (`/fli-price`) added to the Python Cloud Run service (`functions-python/main.py`). Uses the `fli` library for faster, API-based Google Flights access as a complement to the existing `fast_flights` scraper.
- **Best price from any source:** The lowest price across all three sources is selected as the primary price and used for alert triggers — previously only Google Flights drove alerts.
- **Source attribution in Telegram alerts:** Every alert now shows all three prices with a ✅ marking the winner and a "Best Price: $X via Source" headline. The all-time best price also shows which source set it.
- **Source attribution in the UI:** Flight cards now show separate rows for Google Flights, fli Scanner, and Travelpayouts, plus a "Best Price" row with a source badge and a cross-source "Best Ever" row.
- New Firestore fields: `lastFliPrice`, `lastPriceSource`, `bestPrice`, `bestPriceSource`.
- `fliPrice` stored in `priceHistory` records alongside existing price fields.

### Changed
- Alert conditions now compare against the best price from any source (was Google-only).
- "Best Google" label in UI replaced by "Best Ever" showing the cross-source all-time low with source badge.
- `sendTestTelegram` now shows all three last prices and the cross-source best ever.

## [Unreleased]

### Added
- Initial GitHub repository setup


