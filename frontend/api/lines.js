// Vercel Edge Function: /api/lines
// Fetches Underdog lines directly, PrizePicks via Python proxy
// (which uses curl_cffi TLS impersonation to bypass PerimeterX),
// and ParlayPlay via Selenium-based proxy (which bypasses Cloudflare).

export const config = {
  runtime: "edge",
  maxDuration: 55,
};

const UNDERDOG_URL = "https://api.underdogfantasy.com/beta/v5/over_under_lines";
const PLP_PROXY_URL = process.env.PLP_PROXY_URL || "";
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
// ParlayPlay fetching (via Selenium-based proxy that bypasses Cloudflare)
// ---------------------------------------------------------------------------
async function fetchParlayPlayLines() {
  if (!PLP_PROXY_URL) {
    console.log("[ParlayPlay] No PLP_PROXY_URL configured, skipping");
    return { lines: [], available: false };
  }
  try {
    const resp = await fetch(`${PLP_PROXY_URL}/api/parlayplay`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) {
      console.error(`[ParlayPlay] Proxy HTTP ${resp.status}`);
      return { lines: [], available: false };
    }
    const data = await resp.json();
    if (!data.available) {
      console.error(`[ParlayPlay] Proxy unavailable: ${data.error || "unknown"}`);
      return { lines: [], available: false };
    }
    console.log(`[ParlayPlay] Fetched ${data.lines.length} esports lines via proxy`);
    return { lines: data.lines, available: true };
  } catch (err) {
    console.error(`[ParlayPlay] Error: ${err}`);
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

  // Fetch all platforms in parallel
  const [underdogLines, ppResult, plpResult] = await Promise.all([
    fetchUnderdogLines(),
    fetchPrizePicksLines(),
    fetchParlayPlayLines(),
  ]);

  // Filter PrizePicks to only "standard" lines (exclude Goblin/Demon variants)
  const prizepicksLines = ppResult.lines.filter(
    (l) => !l.odds_type || l.odds_type === "standard"
  );
  const parlayplayLines = plpResult.lines || [];
  const allLines = [...underdogLines, ...prizepicksLines, ...parlayplayLines];

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
    const plpLines = lines.filter((l) => l.platform === "ParlayPlay");

    // Build indexes by normalized player+stat key
    const buildIndex = (arr) => {
      const idx = {};
      for (const l of arr) {
        const key = normalizeName(l.player) + "||" + normalizeStat(l.stat);
        if (!idx[key]) idx[key] = [];
        idx[key].push(l);
      }
      return idx;
    };

    const udIndex = buildIndex(udLines);
    const ppIndex = buildIndex(ppLines);
    const plpIndex = buildIndex(plpLines);

    // Collect all unique keys across all platforms
    const allKeys = new Set([
      ...Object.keys(udIndex),
      ...Object.keys(ppIndex),
      ...Object.keys(plpIndex),
    ]);

    for (const key of allKeys) {
      const udEntries = udIndex[key] || [];
      const ppEntries = ppIndex[key] || [];
      const plpEntries = plpIndex[key] || [];

      // Determine the "best" representative from each platform
      const ud = udEntries[0] || null;
      const pp = ppEntries[0] || null;
      const plp = plpEntries[0] || null;

      // Pick player/team/match/scheduled from whichever platform has data
      const rep = ud || pp || plp;
      const hasMultiple = (ud ? 1 : 0) + (pp ? 1 : 0) + (plp ? 1 : 0) >= 2;

      const udPpDiff = (ud && pp) ? Math.round((ud.line - pp.line) * 100) / 100 : null;

      comparisons.push({
        game,
        player: rep.player,
        team: ud?.team || pp?.team || plp?.team || "",
        stat: rep.stat,
        match: ud?.match || pp?.match || plp?.match || "",
        scheduled: ud?.scheduled || pp?.scheduled || plp?.scheduled || "",
        underdog_line: ud ? ud.line : null,
        underdog_higher: ud?.higher_price || "",
        underdog_lower: ud?.lower_price || "",
        prizepicks_line: pp ? pp.line : null,
        prizepicks_flash: pp?.flash_sale_line || null,
        prizepicks_promo: pp?.is_promo || false,
        parlayplay_line: plp ? plp.line : null,
        parlayplay_multiplier: plp?.over_multiplier || null,
        diff: udPpDiff,
        matched: hasMultiple,
      });

      // If a platform has multiple distinct lines for the same key,
      // add the extra entries as separate rows
      for (const extraUd of udEntries.slice(1)) {
        comparisons.push({
          game,
          player: extraUd.player,
          team: extraUd.team || "",
          stat: extraUd.stat,
          match: extraUd.match || "",
          scheduled: extraUd.scheduled || "",
          underdog_line: extraUd.line,
          underdog_higher: extraUd.higher_price || "",
          underdog_lower: extraUd.lower_price || "",
          prizepicks_line: null,
          prizepicks_flash: null,
          prizepicks_promo: false,
          parlayplay_line: null,
          parlayplay_multiplier: null,
          diff: null,
          matched: false,
        });
      }
      for (const extraPp of ppEntries.slice(1)) {
        comparisons.push({
          game,
          player: extraPp.player,
          team: extraPp.team || "",
          stat: extraPp.stat,
          match: extraPp.match || "",
          scheduled: extraPp.scheduled || "",
          underdog_line: null,
          underdog_higher: null,
          underdog_lower: null,
          prizepicks_line: extraPp.line,
          prizepicks_flash: extraPp.flash_sale_line || null,
          prizepicks_promo: extraPp.is_promo || false,
          parlayplay_line: null,
          parlayplay_multiplier: null,
          diff: null,
          matched: false,
        });
      }
      for (const extraPlp of plpEntries.slice(1)) {
        comparisons.push({
          game,
          player: extraPlp.player,
          team: extraPlp.team || "",
          stat: extraPlp.stat,
          match: extraPlp.match || "",
          scheduled: extraPlp.scheduled || "",
          underdog_line: null,
          underdog_higher: null,
          underdog_lower: null,
          prizepicks_line: null,
          prizepicks_flash: null,
          prizepicks_promo: false,
          parlayplay_line: extraPlp.line,
          parlayplay_multiplier: extraPlp.over_multiplier || null,
          diff: null,
          matched: false,
        });
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
    parlayplay_count: parlayplayLines.length,
    parlayplay_available: plpResult.available,
    matched_count: comparisons.filter((c) => c.matched).length,
    games: Object.keys(byGame).sort(),
    fetched_at: new Date().toISOString(),
  };

  return new Response(
    JSON.stringify({ summary, comparisons }),
    { status: 200, headers }
  );
}
