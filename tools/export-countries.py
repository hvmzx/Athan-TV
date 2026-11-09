"""Regenerate tizen-app/js/countries.js from the API country list.

Usage:
    python tools/export-countries.py

The TV app is fully standalone, so the country directory is bundled instead of
being fetched at runtime. Re-run this after scraping/countries_data.py changes.
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
API_DIR = ROOT / "repos" / "mawaqit-api"
OUTPUT = ROOT / "tizen-app" / "js" / "countries.js"

sys.path.insert(0, str(API_DIR))

from scraping.countries_data import COUNTRIES  # noqa: E402


def main() -> None:
    payload = json.dumps(COUNTRIES, ensure_ascii=False, indent=4)
    content = (
        "/* Generated from repos/mawaqit-api/scraping/countries_data.py.\n"
        " * Run python tools/export-countries.py to regenerate. Don't edit by hand.\n"
        " */\n"
        "(function () {\n"
        '    "use strict";\n\n'
        "    window.MAWAQIT_COUNTRIES = " + payload + ";\n"
        "})();\n"
    )
    OUTPUT.write_text(content, encoding="utf-8")
    print(f"Wrote {OUTPUT} ({len(COUNTRIES)} countries)")


if __name__ == "__main__":
    main()
