import { useState, useEffect, useCallback } from 'react'

const API_URL = import.meta.env.VITE_API_URL || ''

interface Comparison {
  game: string
  player: string
  team: string
  stat: string
  match: string
  scheduled: string
  underdog_line: number | null
  underdog_higher: string | null
  underdog_lower: string | null
  prizepicks_line: number | null
  prizepicks_flash: number | null
  prizepicks_promo: boolean
  parlayplay_line: number | null
  parlayplay_multiplier: number | null
  diff: number | null
  matched: boolean
}

interface Summary {
  total_lines: number
  underdog_count: number
  prizepicks_count: number
  prizepicks_available: boolean
  parlayplay_count: number
  parlayplay_available: boolean
  matched_count: number
  games: string[]
  fetched_at: string
}

interface DashboardData {
  summary: Summary
  comparisons: Comparison[]
}

// All data fetching and matching is done server-side in /api/lines

const GAME_LABELS: Record<string, string> = {
  LOL: 'League of Legends',
  CS2: 'Counter-Strike 2',
  DOTA2: 'Dota 2',
  VAL: 'Valorant',
  COD: 'Call of Duty',
}

const GAME_COLORS: Record<string, string> = {
  LOL: 'bg-blue-500',
  CS2: 'bg-orange-500',
  DOTA2: 'bg-red-500',
  VAL: 'bg-violet-500',
  COD: 'bg-green-500',
}

const GAME_BORDER_COLORS: Record<string, string> = {
  LOL: 'border-blue-500',
  CS2: 'border-orange-500',
  DOTA2: 'border-red-500',
  VAL: 'border-violet-500',
  COD: 'border-green-500',
}

function formatStatDisplay(stat: string): string {
  // Display "Maps 1-2" as "Maps 1+2" and "Maps 1-3" as "Maps 1+2+3"
  return stat
    .replace(/(maps?)\s*1\s*-\s*3/gi, '$1 1+2+3')
    .replace(/(maps?)\s*1\s*-\s*2/gi, '$1 1+2')
}

function GameBadge({ game }: { game: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium text-white ${GAME_COLORS[game] || 'bg-gray-500'}`}>
      {GAME_LABELS[game] || game}
    </span>
  )
}

function DiffBadge({ diff }: { diff: number | null }) {
  if (diff === null) return <span className="text-gray-400">-</span>
  const abs = Math.abs(diff)
  let color = 'text-gray-500'
  let bg = 'bg-gray-50'
  if (abs >= 1) {
    color = 'text-amber-700'
    bg = 'bg-amber-50'
  }
  if (abs >= 2) {
    color = 'text-red-700'
    bg = 'bg-red-50'
  }
  const sign = diff > 0 ? '+' : ''
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${color} ${bg}`}>
      {sign}{diff.toFixed(1)}
    </span>
  )
}

function App() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeGame, setActiveGame] = useState<string>('ALL')
  const [showMatchedOnly, setShowMatchedOnly] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch(`${API_URL}/api/lines?t=${Date.now()}`)
      if (!resp.ok) throw new Error(`API returned HTTP ${resp.status}`)
      const dashboard: DashboardData = await resp.json()
      setData(dashboard)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const filteredComparisons = data?.comparisons.filter(c => {
    if (activeGame !== 'ALL' && c.game !== activeGame) return false
    if (showMatchedOnly && !c.matched) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      return c.player.toLowerCase().includes(q) ||
             c.team.toLowerCase().includes(q) ||
             c.stat.toLowerCase().includes(q) ||
             c.match.toLowerCase().includes(q)
    }
    return true
  }) || []

  // Dynamically compute game stats from the actual data
  const gameStats = data ? data.summary.games.map(game => ({
    game,
    total: data.comparisons.filter(c => c.game === game).length,
    matched: data.comparisons.filter(c => c.game === game && c.matched).length,
  })) : []

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white">
                Esports Lines Dashboard
              </h1>
              <p className="text-sm text-gray-400 mt-1">
                Compare Dota 2, CS2 &amp; LoL lines across PrizePicks and Underdog Fantasy
              </p>
            </div>
            <button
              onClick={fetchData}
              disabled={loading}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-800 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              {loading ? (
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              )}
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Error state */}
        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 text-red-200">
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* Summary cards */}
        {data && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
              <p className="text-sm text-gray-400">Total Lines</p>
              <p className="text-3xl font-bold text-white">{data.summary.total_lines}</p>
            </div>
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
              <p className="text-sm text-gray-400">Underdog</p>
              <p className="text-3xl font-bold text-emerald-400">{data.summary.underdog_count}</p>
            </div>
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
              <p className="text-sm text-gray-400">PrizePicks</p>
              <p className="text-3xl font-bold text-purple-400">{data.summary.prizepicks_count}</p>
              {!data.summary.prizepicks_available && (
                <p className="text-xs text-amber-400 mt-1">PrizePicks temporarily unavailable</p>
              )}
            </div>
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
              <p className="text-sm text-gray-400">ParlayPlay</p>
              <p className="text-3xl font-bold text-cyan-400">{data.summary.parlayplay_count}</p>
              {!data.summary.parlayplay_available && (
                <p className="text-xs text-amber-400 mt-1">ParlayPlay proxy not configured</p>
              )}
            </div>
          </div>
        )}

        {/* Game stats cards */}
        {data && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {gameStats.map(({ game, total, matched }) => (
              <div
                key={game}
                className={`bg-gray-900 rounded-lg p-4 border-l-4 cursor-pointer transition-all hover:bg-gray-800/80 ${GAME_BORDER_COLORS[game]} ${activeGame === game ? 'ring-1 ring-gray-600' : ''}`}
                onClick={() => setActiveGame(activeGame === game ? 'ALL' : game)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-lg font-semibold text-white">{GAME_LABELS[game]}</p>
                    <p className="text-sm text-gray-400">{total} lines</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-bold text-white">{matched}</p>
                    <p className="text-xs text-gray-500">matched</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-gray-900 rounded-lg p-1">
            {['ALL', ...(data?.summary.games || [])].map(g => (
              <button
                key={g}
                onClick={() => setActiveGame(g)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  activeGame === g
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`}
              >
                {g === 'ALL' ? 'All Games' : GAME_LABELS[g] || g}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showMatchedOnly}
              onChange={e => setShowMatchedOnly(e.target.checked)}
              className="rounded border-gray-600 bg-gray-800 text-indigo-600 focus:ring-indigo-500"
            />
            Matched only
          </label>
          <div className="flex-1 min-w-48">
            <input
              type="text"
              placeholder="Search player, team, stat..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <span className="text-sm text-gray-500">
            {filteredComparisons.length} results
          </span>
        </div>

        {/* Lines table */}
        {loading && !data ? (
          <div className="flex items-center justify-center py-20">
            <svg className="animate-spin h-8 w-8 text-indigo-500" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : (
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Game</th>
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Player</th>
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Team</th>
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Stat</th>
                    <th className="text-left px-4 py-3 text-gray-400 font-medium">Match</th>
                    <th className="text-right px-4 py-3 text-emerald-400 font-medium">Underdog</th>
                    <th className="text-center px-4 py-3 text-gray-500 font-medium text-xs">H / L</th>
                    <th className="text-right px-4 py-3 text-purple-400 font-medium">PrizePicks</th>
                    <th className="text-right px-4 py-3 text-cyan-400 font-medium">ParlayPlay</th>
                    <th className="text-center px-4 py-3 text-gray-400 font-medium">Diff</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {filteredComparisons.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-4 py-12 text-center text-gray-500">
                        {data?.summary.total_lines === 0
                          ? 'No esports lines currently available. Check back when games are scheduled.'
                          : 'No lines match your filters.'}
                      </td>
                    </tr>
                  ) : (
                    filteredComparisons.map((c, i) => (
                      <tr
                        key={`${c.player}-${c.stat}-${i}`}
                        className={`hover:bg-gray-800/50 transition-colors ${c.matched ? 'bg-gray-900' : 'bg-gray-900/50'}`}
                      >
                        <td className="px-4 py-2.5">
                          <GameBadge game={c.game} />
                        </td>
                        <td className="px-4 py-2.5 font-medium text-white whitespace-nowrap">
                          {c.player}
                          {c.prizepicks_promo && (
                            <span className="ml-1 text-xs text-yellow-400">PROMO</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">{c.team}</td>
                        <td className="px-4 py-2.5 text-gray-300 whitespace-nowrap">{formatStatDisplay(c.stat)}</td>
                        <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap max-w-48 truncate">
                          {c.match}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {c.underdog_line !== null ? (
                            <span className="text-emerald-400 font-semibold">{c.underdog_line}</span>
                          ) : (
                            <span className="text-gray-600">-</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center font-mono text-xs text-gray-500">
                          {c.underdog_higher && c.underdog_lower ? (
                            <span>{c.underdog_higher} / {c.underdog_lower}</span>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {c.prizepicks_line !== null ? (
                            <span className="text-purple-400 font-semibold">
                              {c.prizepicks_line}
                              {c.prizepicks_flash && (
                                <span className="text-yellow-400 text-xs ml-1">
                                  ({c.prizepicks_flash})
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-gray-600">-</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {c.parlayplay_line !== null ? (
                            <span className="text-cyan-400 font-semibold">
                              {c.parlayplay_line}
                              {c.parlayplay_multiplier && (
                                <span className="text-gray-500 text-xs ml-1">
                                  ({c.parlayplay_multiplier}x)
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-gray-600">-</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <DiffBadge diff={c.diff} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Footer */}
        {data && (
          <div className="text-center text-xs text-gray-600 pb-4">
            Last updated: {new Date(data.summary.fetched_at).toLocaleString()}
          </div>
        )}
      </main>
    </div>
  )
}

export default App
