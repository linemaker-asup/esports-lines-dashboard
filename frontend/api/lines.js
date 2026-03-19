// Vercel Edge Function: /api/lines
// Fetches Underdog lines directly and PrizePicks via Python proxy
// (which uses curl_cffi TLS impersonation to bypass PerimeterX).

export const config = {
  runtime: "edge",
  maxDuration: 55,
};

const UNDERDOG_URL = "https://api.underdogfantasy.com/beta/v5/over_under_lines";
const TARGET_SPORTS = new Set(["LOL", "CS", "DOTA2", "ESPORTS"]);

// ---------------------------------------------------------------------------
// Underdog fetching
// ---------------------------------------------------------------------------
async function fetchUnderdogLines() {
  try {
    const resp = await fetch(UNDERDOG_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) {
      console.error(`[Underdog] HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();

    const esportsGames = {};
    for (const g of data.games || []) {
      if (TARGET_SPORTS.has(g.sport_id)) {
        esportsGames[g.id] = {
          sport_id: g.sport_id,
          title: g.title || "",
          scheduled_at: g.scheduled_at || "",
        };
      }
    }

    const appLookup = {};
    const esportsAppIds = new Set();
    for (const a of data.appearances || []) {
      if (esportsGames[a.match_id]) {
        esportsAppIds.add(a.id);
        appLookup[a.id] = {
          player_id: a.player_id || "",
          team_name: a.team_name || "",
          match_id: a.match_id,
        };
      }
    }

    const players = {};
    for (const p of data.players || []) {
      let name = (p.first_name || "").trim();
      if (p.last_name) name += " " + p.last_name;
      players[p.id] = name;
    }

    const rows = [];
    for (const line of data.over_under_lines || []) {
      const ou = line.over_under || {};
      const appStat = ou.appearance_stat || {};
      const appId = appStat.appearance_id;
      if (!esportsAppIds.has(appId)) continue;

      const appInfo = appLookup[appId];
      const gameInfo = esportsGames[appInfo.match_id] || {};
      const sportId = gameInfo.sport_id || "";

      let playerName = (players[appInfo.player_id] || "Unknown").trim();
      playerName = playerName.replace(
        /^(?:LoL|LOL|CS2?|DOTA2?|Val|VAL|Valorant):\s*/i,
        ""
      );

      let gameName;
      if (sportId === "CS") {
        gameName = "CS2";
      } else if (sportId === "ESPORTS") {
        const title = (gameInfo.title || "").toLowerCase();
        if (
          ["cod:", "call of duty", "cdl"].some((x) => title.includes(x))
        ) {
          gameName = "COD";
        } else if (
          ["val:", "valorant", "vct"].some((x) => title.includes(x))
        ) {
          gameName = "VAL";
        } else if (
          ["lpl", "lck", "lec", "lcs", "league", "lol"].some((x) =>
            title.includes(x)
          )
        ) {
          gameName = "LOL";
        } else if (["dota", "ti "].some((x) => title.includes(x))) {
          gameName = "DOTA2";
        } else {
          gameName = "ESPORTS";
        }
      } else if (sportId === "DOTA2") {
        gameName = "DOTA2";
      } else {
        gameName = sportId;
      }

      const options = {};
      for (const opt of line.options || []) {
        options[opt.choice] = opt.american_price || "";
      }

      rows.push({
        platform: "Underdog",
        game: gameName,
        player: playerName,
        team: appInfo.team_name || "",
        match: gameInfo.title || "",
        scheduled: gameInfo.scheduled_at || "",
        stat: appStat.display_stat || "",
        line: parseFloat(line.stat_value || 0),
        higher_price: options.higher || "",
        lower_price: options.lower || "",
        status: line.status || "",
      });
    }

    // Deduplicate: for each player+stat, prefer the line with H/L odds
    const deduped = [];
    const seen = {};
    for (const r of rows) {
      const key = `${r.game}||${r.player}||${r.stat}`;
      const hasOdds = r.higher_price && r.lower_price;
      if (!seen[key]) {
        seen[key] = { index: deduped.length, hasOdds };
        deduped.push(r);
      } else if (hasOdds && !seen[key].hasOdds) {
        // Replace the one without odds
        deduped[seen[key].index] = r;
        seen[key].hasOdds = true;
      }
      // else skip duplicate without odds
    }

    console.log(`[Underdog] Fetched ${rows.length} raw, ${deduped.length} deduped esports lines`);
    return deduped;
  } catch (err) {
    console.error(`[Underdog] Error: ${err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// PrizePicks fetching (via Python proxy with curl_cffi TLS impersonation)
// ---------------------------------------------------------------------------
const PP_PROXY_URL = "https://pp-python.vercel.app/api/prizepicks";

async function fetchPrizePicksLines() {
  try {
    const resp = await fetch(PP_PROXY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(35000),
    });
    if (!resp.ok) {
      console.error(`[PrizePicks] Proxy HTTP ${resp.status}`);
      return { lines: [], available: false };
    }
    const data = await resp.json();
    if (!data.available) {
      console.error(`[PrizePicks] Proxy unavailable: ${data.error || "unknown"}`);
      return { lines: [], available: false };
    }
    console.log(`[PrizePicks] Fetched ${data.lines.length} esports lines via proxy`);
    return { lines: data.lines, available: true };
  } catch (err) {
    console.error(`[PrizePicks] Error: ${err}`);
    return { lines: [], available: false };
  }
}

// ---------------------------------------------------------------------------
// Normalization for cross-platform matching
// ---------------------------------------------------------------------------
function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

function normalizeMapRange(stat) {
  // Extract and normalize map range from stat strings
  // Underdog: "Kills on Maps 1+2", "Kills on Maps 1+2+3"
  // PrizePicks: "MAPS 1-2 Kills", "MAP 1 Kills", "MAP 3 Kills"
  const s = (stat || "").toLowerCase();

  // "maps 1+2+3" or "maps 1-3" → "m123"
  if (/maps?\s*1[\+\-]2[\+\-]3/.test(s) || /maps?\s*1\s*-\s*3/.test(s)) return "m123";
  // "maps 1+2" or "maps 1-2" → "m12"
  if (/maps?\s*1[\+\-]2/.test(s) || /maps?\s*1\s*-\s*2/.test(s)) return "m12";
  // "map 1" → "m1"
  if (/map\s*1(?!\d)/.test(s)) return "m1";
  // "map 2" → "m2"
  if (/map\s*2(?!\d)/.test(s)) return "m2";
  // "map 3" → "m3"
  if (/map\s*3(?!\d)/.test(s)) return "m3";

  return "";
}

function normalizeStat(stat) {
  let s = (stat || "").toLowerCase().trim();
  const mapRange = normalizeMapRange(s);
  // Strip map references to get the core stat
  s = s.replace(/\s*(?:on|in)\s+maps?\s+[\d\+\-]+/g, "");
  s = s.replace(/maps?\s+[\d\-]+\s*/g, "");
  s = s.replace(/\s*\(.*?\)/g, "");
  s = s.replace(/\s+/g, " ").trim();
  // Append normalized map range so matching is accurate
  return mapRange ? `${s} ${mapRange}` : s;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // Fetch both platforms in parallel
  const [underdogLines, ppResult] = await Promise.all([
    fetchUnderdogLines(),
    fetchPrizePicksLines(),
  ]);

  // Filter PrizePicks to only "standard" lines (exclude Goblin/Demon variants)
  const prizepicksLines = ppResult.lines.filter(
    (l) => !l.odds_type || l.odds_type === "standard"
  );
  const allLines = [...underdogLines, ...prizepicksLines];

  // Group by game
  const byGame = {};
  for (const line of allLines) {
    if (!byGame[line.game]) byGame[line.game] = [];
    byGame[line.game].push(line);
  }

  // Build comparisons
  const comparisons = [];
  for (const [game, lines] of Object.entries(byGame)) {
    const udLines = lines.filter((l) => l.platform === "Underdog");
    const ppLines = lines.filter((l) => l.platform === "PrizePicks");

    const udIndex = {};
    for (const l of udLines) {
      const key = normalizeName(l.player) + "||" + normalizeStat(l.stat);
      if (!udIndex[key]) udIndex[key] = [];
      udIndex[key].push(l);
    }

    const ppIndex = {};
    for (const l of ppLines) {
      const key = normalizeName(l.player) + "||" + normalizeStat(l.stat);
      if (!ppIndex[key]) ppIndex[key] = [];
      ppIndex[key].push(l);
    }

    const matchedPpKeys = new Set();
    for (const [key, udEntries] of Object.entries(udIndex)) {
      const ppEntries = ppIndex[key] || [];
      if (ppEntries.length > 0) {
        matchedPpKeys.add(key);
        for (const ud of udEntries) {
          for (const pp of ppEntries) {
            comparisons.push({
              game,
              player: ud.player,
              team: ud.team || pp.team || "",
              stat: ud.stat,
              match: ud.match || pp.match || "",
              scheduled: ud.scheduled || pp.scheduled || "",
              underdog_line: ud.line,
              underdog_higher: ud.higher_price || "",
              underdog_lower: ud.lower_price || "",
              prizepicks_line: pp.line,
              prizepicks_flash: pp.flash_sale_line || null,
              prizepicks_promo: pp.is_promo || false,
              diff: Math.round((ud.line - pp.line) * 100) / 100,
              matched: true,
            });
          }
        }
      } else {
        for (const ud of udEntries) {
          comparisons.push({
            game,
            player: ud.player,
            team: ud.team || "",
            stat: ud.stat,
            match: ud.match || "",
            scheduled: ud.scheduled || "",
            underdog_line: ud.line,
            underdog_higher: ud.higher_price || "",
            underdog_lower: ud.lower_price || "",
            prizepicks_line: null,
            prizepicks_flash: null,
            prizepicks_promo: false,
            diff: null,
            matched: false,
          });
        }
      }
    }

    for (const [key, ppEntries] of Object.entries(ppIndex)) {
      if (!matchedPpKeys.has(key)) {
        for (const pp of ppEntries) {
          comparisons.push({
            game,
            player: pp.player,
            team: pp.team || "",
            stat: pp.stat,
            match: pp.match || "",
            scheduled: pp.scheduled || "",
            underdog_line: null,
            underdog_higher: null,
            underdog_lower: null,
            prizepicks_line: pp.line,
            prizepicks_flash: pp.flash_sale_line || null,
            prizepicks_promo: pp.is_promo || false,
            diff: null,
            matched: false,
          });
        }
      }
    }
  }

  // Sort: matched first, then by game, player, stat
  comparisons.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1;
    if (a.game !== b.game) return a.game.localeCompare(b.game);
    if (a.player !== b.player) return a.player.localeCompare(b.player);
    return a.stat.localeCompare(b.stat);
  });

  const summary = {
    total_lines: allLines.length,
    underdog_count: underdogLines.length,
    prizepicks_count: prizepicksLines.length,
    prizepicks_available: ppResult.available,
    matched_count: comparisons.filter((c) => c.matched).length,
    games: Object.keys(byGame).sort(),
    fetched_at: new Date().toISOString(),
  };

  return new Response(
    JSON.stringify({ summary, comparisons }),
    { status: 200, headers }
  );
}
