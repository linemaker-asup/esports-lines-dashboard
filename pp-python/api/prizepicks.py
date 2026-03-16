"""
Vercel Python Serverless Function: PrizePicks esports proxy.
Uses curl_cffi with edge101 TLS fingerprint impersonation to bypass PerimeterX.
"""

from http.server import BaseHTTPRequestHandler
import json
import time

PP_URL = "https://api.prizepicks.com/projections"

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

# In-memory cache (persists across warm Lambda invocations)
_cache = {"data": None, "time": 0}
CACHE_TTL = 300  # 5 minutes


def fetch_prizepicks():
    from curl_cffi import requests as cffi_requests

    resp = cffi_requests.get(
        PP_URL,
        params={
            "per_page": 250,
            "single_stat": "true",
            "game_mode": "pickem",
        },
        headers={
            "Accept": "application/json",
            "Referer": "https://app.prizepicks.com/",
            "Accept-Language": "en-US,en;q=0.9",
        },
        impersonate="edge101",
        timeout=30,
    )

    if resp.status_code != 200:
        return {"error": f"HTTP {resp.status_code}", "lines": [], "available": False}

    data = resp.json()

    # Build lookups from "included"
    players_map = {}
    leagues_map = {}
    for item in data.get("included", []):
        item_type = item.get("type")
        if item_type == "new_player":
            attrs = item.get("attributes") or {}
            players_map[item["id"]] = {
                "name": attrs.get("display_name") or attrs.get("name") or "Unknown",
                "team": attrs.get("team", ""),
            }
        elif item_type == "league":
            name = (item.get("attributes") or {}).get("name", "")
            if name in GAME_NAME_MAP:
                leagues_map[item["id"]] = name

    # Extract esports lines
    lines = []
    for proj in data.get("data", []):
        attrs = proj.get("attributes") or {}
        rels = proj.get("relationships") or {}
        league_id = ((rels.get("league") or {}).get("data") or {}).get("id", "")
        league_name = leagues_map.get(str(league_id), "")
        game_name = GAME_NAME_MAP.get(league_name)
        if not game_name:
            continue
        line_score = attrs.get("line_score")
        if line_score is None:
            continue
        player_id = str(((rels.get("new_player") or {}).get("data") or {}).get("id", ""))
        player = players_map.get(player_id, {})
        lines.append({
            "platform": "PrizePicks",
            "game": game_name,
            "player": player.get("name", "Unknown"),
            "team": player.get("team", ""),
            "match": attrs.get("description", ""),
            "scheduled": attrs.get("start_time", ""),
            "stat": attrs.get("stat_type", ""),
            "line": float(line_score),
            "flash_sale_line": float(attrs["flash_sale_line_score"]) if attrs.get("flash_sale_line_score") else None,
            "is_promo": attrs.get("is_promo", False),
            "status": attrs.get("status", ""),
        })

    return {
        "lines": lines,
        "available": True,
        "total_projections": len(data.get("data", [])),
        "esports_count": len(lines),
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        now = time.time()

        # Serve cached if fresh
        if _cache["data"] and (now - _cache["time"]) < CACHE_TTL:
            result = _cache["data"]
        else:
            try:
                result = fetch_prizepicks()
                if result.get("available"):
                    _cache["data"] = result
                    _cache["time"] = now
            except Exception as e:
                result = {"error": str(e), "lines": [], "available": False}

        body = json.dumps(result).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
