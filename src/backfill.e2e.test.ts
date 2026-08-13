import { beforeAll, describe, expect, it } from 'vitest'
import { questdb, questdbAvailable, QUESTDB_URL } from './e2e.test-utils.js'

/**
 * QuestDB as a backfill source.
 *
 * The unit suite stubs `getHistoryApi`, which proves the plugin's own parsing
 * but says nothing about whether a real provider's storage fits it. These
 * queries run against a live QuestDB — the store signalk-questdb writes into —
 * so a change on either side shows up here.
 *
 * Read-only against the real rows. QuestDB has no row-level DELETE (it drops
 * whole time partitions instead), so a fixture context could not be cleaned up
 * afterwards; asserting against what is genuinely recorded avoids leaving
 * synthetic vessels behind in the table.
 *
 * Skips cleanly when QuestDB is not reachable, so `npm run test:e2e` still runs
 * the server tier without it.
 */

let available = false

beforeAll(async () => {
  available = await questdbAvailable()
  if (!available) {
    console.warn(`QuestDB not reachable at ${QUESTDB_URL}; backfill tests skipped`)
  }
}, 60_000)

describe('QuestDB as a history source', () => {
  it('stores navigation.position in its own table', async () => {
    if (!available) return
    // The schema the History API bootstrap ultimately reads through. A rename
    // here is what would silently empty a backfilled track.
    const res = await questdb(`SELECT "column", type FROM table_columns('signalk_position')`)
    const columns = Object.fromEntries(res.dataset.map((row) => [row[0], row[1]]))

    expect(columns).toMatchObject({
      ts: 'TIMESTAMP',
      context: 'SYMBOL',
      lat: 'DOUBLE',
      lon: 'DOUBLE',
    })
  })

  it('has no path column: the whole table is navigation.position', async () => {
    if (!available) return
    // Worth pinning because it is the reason positions can be time-partitioned
    // separately from every other path, which is what makes a track query fast.
    const res = await questdb(`SELECT "column" FROM table_columns('signalk_position')`)
    expect(res.dataset.flat()).not.toContain('path')
  })

  it('records more than one vessel', async () => {
    if (!available) return
    // Not asserting a count, which grows: the point is that the backfill source
    // is genuinely multi-vessel, which is what makes the self/AIS split real.
    const res = await questdb('SELECT count(DISTINCT context) FROM signalk_position')
    expect(res.dataset[0]?.[0] as number).toBeGreaterThan(1)
  })

  it('answers a bounded time query, which is what a track backfill issues', async () => {
    if (!available) return
    const res = await questdb(`SELECT count() FROM signalk_position WHERE ts > dateadd('d', -1, now()) AND ts <= now()`)
    expect(res.dataset[0]?.[0] as number).toBeGreaterThanOrEqual(0)
  })

  it('returns positions oldest-first when ordered by ts', async () => {
    if (!available) return
    // The bootstrap appends rows in the order it receives them, so a provider
    // returning them unordered would produce a track that doubles back.
    const res = await questdb(`SELECT ts FROM signalk_position WHERE ts > dateadd('d', -7, now()) ORDER BY ts LIMIT 50`)
    const timestamps = res.dataset.map((row) => Date.parse(String(row[0])))
    if (timestamps.length < 2) return
    const sorted = [...timestamps].sort((a, b) => a - b)
    expect(timestamps).toEqual(sorted)
  })

  it('has no source column, so interleaved sources are indistinguishable', async () => {
    if (!available) return
    // Pins the gap behind the multi-source warning: once recorded, fixes from
    // several receivers cannot be told apart or filtered after the fact.
    const res = await questdb(`SELECT "column" FROM table_columns('signalk_position')`)
    const columns = res.dataset.flat()
    expect(columns).not.toContain('source')
    expect(columns).not.toContain('$source')
  })
})
