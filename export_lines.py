#!/usr/bin/env python3
"""
Fetch esports lines from Underdog Fantasy and PrizePicks, then save to CSV.

Usage:
    python export_lines.py                  # Save all lines to data/esports_lines.csv
    python export_lines.py --output my.csv  # Custom output path
    python export_lines.py --game LOL       # Filter by game (LOL, CS2, DOTA2, VAL)
    python export_lines.py --matched-only   # Only export matched lines (on both platforms)
"""

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError


UNDERDOG_URL = "https://api.underdogfantasy.com/beta/v5/over_under_lines"
PP_PROXY_URL = "https://pp-python.vercel.app/api/prizepicks"

TARGET_SPORTS = {"LOL", "CS", "DOTA2", "ESPORTS"}

GAME_NAME_MAP = {
    "LoL": "LOL",
    "League of Legends": "LOL",
    "CS2": "CS2",
    "Counter-Strike": "CS2",
    "Counter-Strike 2": "CS2",
    "DOTA2": "DOTA2",
    "Dota2": "DOTA2",
    "Dota 2": "DOTA2",
    "VAL": "VAL",
    "Valorant": "VAL",
}


def fetch_json(url, timeout=30):
    """Fetch JSON from a URL using stdlib only."""
    req = Request(url, headers={"Accept": "application/json", "User-Agent": "esports-lines-exporter/1.0"})
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_underdog_lines():
    """Fetch esports lines from Underdog Fantasy."""
    print("[Underdog] Fetching lines...")
    data = fetch_json(UNDERDOG_URL)

    esports_games = {}
    for g in data.get("games", []):
        if g.get("sport_id") in TARGET_SPORTS:
            esports_games[g["id"]] = {
                "sport_id": g["sport_id"],
                "title": g.get("title", ""),
                "scheduled_at": g.get("scheduled_at", ""),
            }

    app_lookup = {}
    esports_app_ids = set()
    for a in data.get("appearances", []):
        if a.get("match_id") in esports_games:
            esports_app_ids.add(a["id"])
            app_lookup[a["id"]] = {
                "player_id": a.get("player_id", ""),
                "team_name": a.get("team_name", ""),
                "match_id": a["match_id"],
            }

    players = {}
    for p in data.get("players", []):
        name = (p.get("first_name") or "").strip()
        if p.get("last_name"):
            name += " " + p["last_name"]
        players[p["id"]] = name

    rows = []
    for line in data.get("over_under_lines", []):
        ou = line.get("over_under", {})
        app_stat = ou.get("appearance_stat", {})
        app_id = app_stat.get("appearance_id")
        if app_id not in esports_app_ids:
            continue

        app_info = app_lookup[app_id]
        game_info = esports_games.get(app_info["match_id"], {})
        sport_id = game_info.get("sport_id", "")

        player_name = (players.get(app_info["player_id"], "Unknown")).strip()
        import re
        player_name = re.sub(r"^(?:LoL|LOL|CS2?|DOTA2?|Val|VAL|Valorant):\s*", "", player_name, flags=re.IGNORECASE)

        if sport_id == "CS":
            game_name = "CS2"
        elif sport_id == "ESPORTS":
            title = (game_info.get("title") or "").lower()
            if any(x in title for x in ["lpl", "lck", "lec", "lcs", "league", "lol"]):
                game_name = "LOL"
            elif any(x in title for x in ["dota", "ti "]):
                game_name = "DOTA2"
            else:
                game_name = "LOL"
        elif sport_id == "DOTA2":
            game_name = "DOTA2"
        else:
            game_name = sport_id

        options = {}
        for opt in line.get("options", []):
            options[opt["choice"]] = opt.get("american_price", "")

        rows.append({
            "platform": "Underdog",
            "game": game_name,
            "player": player_name,
            "team": app_info.get("team_name", ""),
            "match": game_info.get("title", ""),
            "scheduled": game_info.get("scheduled_at", ""),
            "stat": app_stat.get("display_stat", ""),
            "line": float(line.get("stat_value", 0)),
            "higher_price": options.get("higher", ""),
            "lower_price": options.get("lower", ""),
            "status": line.get("status", ""),
        })

    print(f"[Underdog] Found {len(rows)} esports lines")
    return rows


def fetch_prizepicks_lines():
    """Fetch esports lines from PrizePicks via the proxy."""
    print("[PrizePicks] Fetching lines via proxy...")
    try:
        data = fetch_json(PP_PROXY_URL, timeout=45)
        if not data.get("available"):
            print(f"[PrizePicks] Unavailable: {data.get('error', 'unknown')}")
            return [], False
        lines = data.get("lines", [])
        print(f"[PrizePicks] Found {len(lines)} esports lines")
        return lines, True
    except (URLError, json.JSONDecodeError) as e:
        print(f"[PrizePicks] Error: {e}")
        return [], False


def normalize_name(name):
    """Normalize player name for matching."""
    import re
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", "", (name or "").lower().strip()))


def normalize_stat(stat):
    """Normalize stat name for matching."""
    import re
    s = (stat or "").lower().strip()
    s = re.sub(r"\s*(?:on|in)\s+maps?\s+[\d+]+", "", s)
    s = re.sub(r"maps?\s+[\d\-]+\s*", "", s)
    s = re.sub(r"\s*\(.*?\)", "", s)
    return re.sub(r"\s+", " ", s).strip()


def build_comparisons(underdog_lines, pp_lines):
    """Match lines across platforms and build comparison rows."""
    all_lines = underdog_lines + pp_lines
    by_game = {}
    for line in all_lines:
        game = line.get("game", "")
        if game not in by_game:
            by_game[game] = []
        by_game[game].append(line)

    comparisons = []
    for game, lines in by_game.items():
        ud_lines = [l for l in lines if l.get("platform") == "Underdog"]
        pp_game = [l for l in lines if l.get("platform") == "PrizePicks"]

        ud_index = {}
        for l in ud_lines:
            key = f"{normalize_name(l['player'])}||{normalize_stat(l['stat'])}"
            ud_index.setdefault(key, []).append(l)

        pp_index = {}
        for l in pp_game:
            key = f"{normalize_name(l['player'])}||{normalize_stat(l['stat'])}"
            pp_index.setdefault(key, []).append(l)

        matched_pp_keys = set()
        for key, ud_entries in ud_index.items():
            pp_entries = pp_index.get(key, [])
            if pp_entries:
                matched_pp_keys.add(key)
                for ud in ud_entries:
                    for pp in pp_entries:
                        diff = round(ud["line"] - pp["line"], 2)
                        comparisons.append({
                            "game": game,
                            "player": ud["player"],
                            "team": ud.get("team") or pp.get("team", ""),
                            "stat": ud["stat"],
                            "match": ud.get("match") or pp.get("match", ""),
                            "scheduled": ud.get("scheduled") or pp.get("scheduled", ""),
                            "underdog_line": ud["line"],
                            "underdog_higher": ud.get("higher_price", ""),
                            "underdog_lower": ud.get("lower_price", ""),
                            "prizepicks_line": pp["line"],
                            "prizepicks_flash": pp.get("flash_sale_line"),
                            "prizepicks_promo": pp.get("is_promo", False),
                            "diff": diff,
                            "matched": True,
                        })
            else:
                for ud in ud_entries:
                    comparisons.append({
                        "game": game,
                        "player": ud["player"],
                        "team": ud.get("team", ""),
                        "stat": ud["stat"],
                        "match": ud.get("match", ""),
                        "scheduled": ud.get("scheduled", ""),
                        "underdog_line": ud["line"],
                        "underdog_higher": ud.get("higher_price", ""),
                        "underdog_lower": ud.get("lower_price", ""),
                        "prizepicks_line": "",
                        "prizepicks_flash": "",
                        "prizepicks_promo": "",
                        "diff": "",
                        "matched": False,
                    })

        for key, pp_entries in pp_index.items():
            if key not in matched_pp_keys:
                for pp in pp_entries:
                    comparisons.append({
                        "game": game,
                        "player": pp["player"],
                        "team": pp.get("team", ""),
                        "stat": pp["stat"],
                        "match": pp.get("match", ""),
                        "scheduled": pp.get("scheduled", ""),
                        "underdog_line": "",
                        "underdog_higher": "",
                        "underdog_lower": "",
                        "prizepicks_line": pp["line"],
                        "prizepicks_flash": pp.get("flash_sale_line", ""),
                        "prizepicks_promo": pp.get("is_promo", False),
                        "diff": "",
                        "matched": False,
                    })

    comparisons.sort(key=lambda c: (not c["matched"], c["game"], c["player"], c["stat"]))
    return comparisons


CSV_FIELDS = [
    "game", "player", "team", "stat", "match", "scheduled",
    "underdog_line", "underdog_higher", "underdog_lower",
    "prizepicks_line", "prizepicks_flash", "prizepicks_promo",
    "diff", "matched",
]


def main():
    parser = argparse.ArgumentParser(description="Export esports betting lines to CSV")
    parser.add_argument("--output", "-o", default=None, help="Output CSV path (default: data/esports_lines_YYYYMMDD_HHMMSS.csv)")
    parser.add_argument("--game", "-g", default=None, choices=["LOL", "CS2", "DOTA2", "VAL"], help="Filter by game")
    parser.add_argument("--matched-only", "-m", action="store_true", help="Only export matched lines")
    args = parser.parse_args()

    # Fetch from both platforms
    underdog_lines = fetch_underdog_lines()
    pp_lines, pp_available = fetch_prizepicks_lines()

    # Build comparisons
    comparisons = build_comparisons(underdog_lines, pp_lines)

    # Apply filters
    if args.game:
        comparisons = [c for c in comparisons if c["game"] == args.game]
    if args.matched_only:
        comparisons = [c for c in comparisons if c["matched"]]

    # Determine output path
    if args.output:
        output_path = args.output
    else:
        os.makedirs("data", exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        output_path = f"data/esports_lines_{timestamp}.csv"

    # Write CSV
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(comparisons)

    # Summary
    total = len(comparisons)
    matched = sum(1 for c in comparisons if c["matched"])
    games = sorted(set(c["game"] for c in comparisons))

    print(f"\nExported {total} lines ({matched} matched) to {output_path}")
    print(f"Games: {', '.join(games)}")
    print(f"Underdog: {len(underdog_lines)} | PrizePicks: {len(pp_lines)} ({'available' if pp_available else 'unavailable'})")


if __name__ == "__main__":
    main()
