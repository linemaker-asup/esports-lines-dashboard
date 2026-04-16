"""
ParlayPlay esports lines proxy.

Uses Selenium headless Chrome to bypass Cloudflare protection and intercept
the crossgame/search API response from ParlayPlay.  Exposes the normalized
eSports player props via a simple FastAPI endpoint.

Deployment: requires a host with Google Chrome and ChromeDriver installed
(e.g. Fly.io with a custom Dockerfile, a VPS, etc.).
"""

import json
import os
import time
import threading

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# League mapping
# ---------------------------------------------------------------------------
PLP_LEAGUE_MAP = {
    "valorant": "VAL",
    "lol": "LOL",
    "league of legends": "LOL",
    "cs2": "CS2",
    "counter-strike": "CS2",
    "dota 2": "DOTA2",
    "dota2": "DOTA2",
    "call of duty": "COD",
    "cod": "COD",
}

# ---------------------------------------------------------------------------
# In-memory cache
# ---------------------------------------------------------------------------
_cache = {"data": None, "time": 0}
CACHE_TTL = int(os.environ.get("CACHE_TTL", "300"))  # 5 min default
_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Selenium scraper
# ---------------------------------------------------------------------------

def _extract_api_data(driver, logs):
    """Extract crossgame/search API response bodies from Chrome performance logs."""
    data = {}
    for entry in logs:
        try:
            msg = json.loads(entry["message"])["message"]
            if msg["method"] == "Network.responseReceived":
                url = msg["params"]["response"]["url"]
                status = msg["params"]["response"]["status"]
                if "crossgame/search" in url and status == 200:
                    request_id = msg["params"]["requestId"]
                    try:
                        body = driver.execute_cdp_cmd(
                            "Network.getResponseBody", {"requestId": request_id}
                        )
                        parsed = json.loads(body["body"])
                        data[url] = parsed
                    except Exception:
                        pass
        except Exception:
            pass
    return data


def _normalize_players(player_entry):
    """Normalize a ParlayPlay player entry into standard line format(s)."""
    results = []
    try:
        match = player_entry.get("match", {})
        sport = match.get("sport", {})
        league = match.get("league", {})

        if sport.get("sportName") != "eSports":
            return results

        league_short = league.get("leagueNameShort", "")
        game = PLP_LEAGUE_MAP.get(league_short.lower(), "ESPORTS")

        player_info = player_entry.get("player", {})
        player_name = player_info.get("fullName", "")
        team_abbr = player_info.get("team", {}).get("teamAbbreviation", "")

        home = match.get("homeTeam", {}).get("teamname", "")
        away = match.get("awayTeam", {}).get("teamname", "")
        match_title = f"{home} vs {away}" if home and away else ""
        match_date = match.get("matchDate", "")

        # FG period: determine map prefix from match type
        match_type = match.get("matchType", "")
        if match_type == "best_of_5":
            prefix = "Maps 1-5 "
        elif match_type == "best_of_3":
            prefix = "Maps 1-3 "
        elif match_type == "best_of_2":
            prefix = "Maps 1-2 "
        else:
            prefix = ""

        for stat in player_entry.get("stats", []):
            stat_name = stat.get("challengeName", "")
            line_val = stat.get("statValue")
            multiplier = stat.get("defaultMultiplier")

            if not stat_name or line_val is None:
                continue

            full_stat = f"{prefix}{stat_name}"

            results.append({
                "platform": "ParlayPlay",
                "game": game,
                "player": player_name,
                "team": team_abbr,
                "match": match_title,
                "scheduled": match_date,
                "stat": full_stat,
                "line": float(line_val),
                "over_multiplier": multiplier,
                "under_multiplier": None,
            })
    except Exception:
        pass
    return results


def _scrape_parlayplay():
    """Scrape ParlayPlay using Selenium headless Chrome."""
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options

    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1400,900")
    options.add_argument("--disable-extensions")
    options.add_argument("--disable-infobars")
    options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
    options.set_capability("goog:loggingPrefs", {"performance": "ALL"})

    # Try to find Chrome binary
    for path in ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]:
        if os.path.exists(path):
            options.binary_location = path
            break

    driver = webdriver.Chrome(options=options)
    all_players = []

    try:
        driver.get("https://parlayplay.io")
        time.sleep(8)

        title = driver.title
        if "moment" in title.lower() or "challenge" in title.lower():
            time.sleep(10)
            title = driver.title

        if "ParlayPlay" not in title:
            return {"lines": [], "available": False, "error": f"Cloudflare blocked: {title}"}

        logs = driver.get_log("performance")
        all_data = _extract_api_data(driver, logs)

        for url, data in all_data.items():
            if isinstance(data, dict) and "players" in data:
                for p in data["players"]:
                    entries = _normalize_players(p)
                    all_players.extend(entries)

        # Deduplicate
        seen = set()
        deduped = []
        for p in all_players:
            key = f"{p['game']}||{p['player']}||{p['stat']}||{p['line']}"
            if key not in seen:
                seen.add(key)
                deduped.append(p)

        return {
            "lines": deduped,
            "available": True,
            "raw_count": len(all_players),
            "deduped_count": len(deduped),
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    except Exception as e:
        return {"lines": [], "available": False, "error": str(e)}
    finally:
        try:
            driver.quit()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# API endpoint
# ---------------------------------------------------------------------------

@app.get("/api/parlayplay")
def get_parlayplay():
    now = time.time()

    with _lock:
        if _cache["data"] and (now - _cache["time"]) < CACHE_TTL:
            return _cache["data"]

    # Scrape outside the lock to avoid blocking other requests
    result = _scrape_parlayplay()

    if result.get("available"):
        with _lock:
            _cache["data"] = result
            _cache["time"] = time.time()

    return result


@app.get("/health")
def health():
    return {"status": "ok"}
