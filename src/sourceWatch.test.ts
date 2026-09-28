import { describe, expect, it, vi } from 'vitest'
import { createHarness } from './harness.test-utils.js'
import { SourceWatch } from './sourceWatch.js'
import type { Context } from './types.js'

const SELF = 'vessels.urn:mrn:imo:mmsi:123456789' as Context
const OTHER = 'vessels.urn:mrn:imo:mmsi:987654321' as Context

/**
 * Feed two sources alternating on one context, which is what unfiltered
 * sources do and what the watcher reports. A single handover is a failover
 * and deliberately says nothing, so a fixture that wants a warning has to
 * alternate rather than simply name two sources.
 */
const competing = (w: SourceWatch, context: Context, a: string, b: string, from = Date.now()): void => {
  for (const [i, source] of [a, b, a, b].entries()) {
    w.add(context, source, from + i * 100)
  }
}

describe('SourceWatch', () => {
  it('says nothing when every context has a single source', () => {
    const w = new SourceWatch()
    w.add(SELF, 'gps.0')
    w.add(SELF, 'gps.0')
    w.add(OTHER, 'ais.0')

    expect(w.conflicted()).toEqual([])
    expect(w.warning(SELF)).toBeUndefined()
  })

  it('names the sources when the own vessel has more than one', () => {
    const w = new SourceWatch()
    // Alternating, which is what unfiltered sources do; a single handover
    // would be a failover transition rather than competition.
    competing(w, SELF, 'gps.0', 'n2k.1')

    const warning = w.warning(SELF)
    expect(warning).toContain('gps.0')
    expect(warning).toContain('n2k.1')
    expect(warning).toContain('source priority')
  })

  it('counts other vessels rather than naming them', () => {
    // AIS targets legitimately arrive via several receivers; that is not a
    // misconfiguration the user needs to fix, so it is not worth naming each.
    const w = new SourceWatch()
    competing(w, OTHER, 'ais.0', 'ais.1')

    const warning = w.warning(SELF)
    expect(warning).toContain('1 vessel')
    expect(warning).not.toContain(OTHER)
  })

  it('mentions both the own vessel and the count of others', () => {
    const w = new SourceWatch()
    competing(w, SELF, 'gps.0', 'n2k.1')
    competing(w, OTHER, 'ais.0', 'ais.1')

    const warning = w.warning(SELF)
    expect(warning).toContain('own vessel')
    expect(warning).toContain('1 other vessel')
  })

  it('pluralises the count of other vessels', () => {
    const w = new SourceWatch()
    for (const [i, mmsi] of ['111', '222'].entries()) {
      const context = `vessels.urn:mrn:imo:mmsi:${mmsi}` as Context
      competing(w, context, `ais.${i}`, `n2k.${i}`)
    }

    expect(w.warning(SELF)).toContain('2 vessels')
  })

  it('ignores a delta with no source', () => {
    // A source-less delta says nothing about whether priority is configured,
    // so counting it would warn about a setup that is actually fine.
    const w = new SourceWatch()
    w.add(SELF, 'gps.0')
    w.add(SELF, undefined)

    expect(w.warning(SELF)).toBeUndefined()
    expect(w.sourcesFor(SELF)).toEqual(['gps.0'])
  })

  it('reports sources in the order they first appeared', () => {
    const w = new SourceWatch()
    w.add(SELF, 'n2k.1')
    w.add(SELF, 'gps.0')
    w.add(SELF, 'n2k.1')

    expect(w.sourcesFor(SELF)).toEqual(['n2k.1', 'gps.0'])
  })

  it('warns without a self context, treating everything as another vessel', () => {
    const w = new SourceWatch()
    competing(w, SELF, 'gps.0', 'n2k.1')

    expect(w.warning(undefined)).toContain('1 vessel')
  })

  it('stays quiet when the server has already picked a winner', () => {
    // The premise the warning rests on: getBus() is fed from `delta`, which the
    // server emits *after* applying toPreferredDelta. With a priority rule in
    // place only the winning source arrives, so a correctly configured boat
    // never sees this warning however many receivers it has.
    const w = new SourceWatch()
    for (let i = 0; i < 100; i++) {
      w.add(SELF, 'gps.0')
    }

    expect(w.conflicted()).toEqual([])
    expect(w.warning(SELF)).toBeUndefined()
  })

  it('forgets what it saw when cleared', () => {
    const w = new SourceWatch()
    w.add(SELF, 'gps.0')
    w.add(SELF, 'n2k.1')
    w.clear()

    expect(w.warning(SELF)).toBeUndefined()
  })
})

// The watcher wired into the plugin: positions arrive on the bus and the
// warning reaches the server dashboard.
describe('source warning through the plugin', () => {
  it('warns on the dashboard when the own vessel has two position sources', async () => {
    vi.useFakeTimers()
    const h = createHarness({ selfPosition: [60, 24] })
    try {
      for (const [i, source] of ['gps.0', 'n2k.1', 'gps.0', 'n2k.1'].entries()) {
        h.emit(SELF, [60.1, 24.9 + i * 0.01], undefined, source)
      }

      expect(h.statuses).toEqual([])
      vi.advanceTimersByTime(30_000)

      expect(h.statuses).toHaveLength(1)
      expect(h.statuses[0]).toContain('gps.0')
      expect(h.statuses[0]).toContain('n2k.1')
    } finally {
      await h.stop()
      vi.useRealTimers()
    }
  })

  it('stays quiet with a single source', async () => {
    vi.useFakeTimers()
    const h = createHarness({ selfPosition: [60, 24] })
    try {
      h.emit(SELF, [60.1, 24.9], undefined, 'gps.0')
      h.emit(SELF, [60.1, 24.91], undefined, 'gps.0')
      vi.advanceTimersByTime(120_000)

      // A healthy status is still pushed; what matters is that none of them
      // warns about sources.
      expect(h.statuses.some((s) => s.includes('navigation.position'))).toBe(false)
    } finally {
      await h.stop()
      vi.useRealTimers()
    }
  })

  it('stops reporting once the plugin is stopped', async () => {
    vi.useFakeTimers()
    const h = createHarness({ selfPosition: [60, 24] })
    try {
      h.emit(SELF, [60.1, 24.9], undefined, 'gps.0')
      h.emit(SELF, [60.1, 24.91], undefined, 'n2k.1')
      await h.stop()
      vi.advanceTimersByTime(120_000)

      expect(h.statuses).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not warn when a source only replaced another after it went quiet', () => {
    // A priority rule fails over when the top source drops out, so several
    // sources reach this bus over a long run even though only one is live at
    // a time. Counting every source ever seen would nag a correctly
    // configured boat whose GPS blinks.
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    // The server's default failover delay: the primary is silent for 15s
    // before the backup is promoted, so the two are never live together.
    watch.add(SELF, 'gps.primary', start)
    watch.add(SELF, 'gps.backup', start + 15 * 1000)

    expect(watch.warning(SELF, start + 15 * 1000)).toBeUndefined()
  })

  it('still warns when two sources are live at the same time', () => {
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    competing(watch, SELF, 'gps.primary', 'gps.secondary', start)

    expect(watch.warning(SELF, start + 1000)).toMatch(/arriving from 2 sources/)
  })

  it('treats a failback as a transition rather than a conflict', () => {
    // The primary goes quiet, the backup is promoted after the failover
    // delay, then the primary returns and the server restores it at once.
    // Two sources a second apart, and nothing wrong.
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    watch.add(SELF, 'gps.primary', start)
    watch.add(SELF, 'gps.backup', start + 15_000)
    watch.add(SELF, 'gps.primary', start + 16_000)

    expect(watch.warning(SELF, start + 17_000)).toBeUndefined()
  })

  it('treats one hand-back inside the window as a transition', () => {
    // A source can drop a fix, the backup fill it, and the primary resume --
    // three reports, two changes, all within seconds. That is the engine
    // covering a gap, not two sources competing for the path.
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    watch.add(SELF, 'gps.primary', start)
    watch.add(SELF, 'gps.backup', start + 500)
    watch.add(SELF, 'gps.primary', start + 1000)

    expect(watch.warning(SELF, start + 1500)).toBeUndefined()
  })

  it('does not carry an alternation across a quiet gap', () => {
    // Two changes, then silence, then a single change much later. Neither
    // episode is competition and they must not add up to one.
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    watch.add(SELF, 'gps.a', start)
    watch.add(SELF, 'gps.b', start + 500)
    watch.add(SELF, 'gps.a', start + 1000)
    // Well past the alternation window.
    watch.add(SELF, 'gps.a', start + 60_000)
    watch.add(SELF, 'gps.b', start + 60_500)

    expect(watch.warning(SELF, start + 61_000)).toBeUndefined()
  })

  it('names every source in a three-way alternation', () => {
    // The reported case had three receivers trading the path; naming only
    // the last two to report sends the user after the wrong hardware.
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    for (const [i, source] of ['gps.a', 'gps.b', 'gps.c', 'gps.a'].entries()) {
      watch.add(SELF, source, start + i * 100)
    }

    const warning = watch.warning(SELF, start + 500)
    expect(warning).toMatch(/gps\.a/)
    expect(warning).toMatch(/gps\.b/)
    expect(warning).toMatch(/gps\.c/)
    expect(warning).toMatch(/from 3 sources/)
  })

  it('forgets a source that drops out of an ongoing alternation', () => {
    // Three trade the path, then one stops while the other two carry on. The
    // warning should stop naming the one that left rather than keeping it
    // alive on the others' reports.
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    for (const [i, source] of ['gps.a', 'gps.b', 'gps.c', 'gps.a'].entries()) {
      watch.add(SELF, source, start + i * 100)
    }
    expect(watch.warning(SELF, start + 500)).toMatch(/gps\.c/)

    // a and b keep alternating well past the retention window; c never
    // reports again.
    for (let i = 0; i < 40; i += 1) {
      watch.add(SELF, i % 2 === 0 ? 'gps.b' : 'gps.a', start + 1000 + i * 5000)
    }

    const warning = watch.warning(SELF, start + 1000 + 40 * 5000)
    expect(warning).not.toMatch(/gps\.c/)
    expect(warning).toMatch(/gps\.a/)
  })

  it('does not resume an old alternation after one source settles', () => {
    // Two changes, then the primary holds the path for a long run, then a
    // single later handover. The old count must not carry over and turn that
    // handover into a conflict.
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    watch.add(SELF, 'gps.a', start)
    watch.add(SELF, 'gps.b', start + 100)
    watch.add(SELF, 'gps.a', start + 200)
    // One source holding the path, which is the healthy state.
    for (let i = 1; i <= 20; i += 1) {
      watch.add(SELF, 'gps.a', start + 200 + i * 1000)
    }
    watch.add(SELF, 'gps.b', start + 21_000)

    expect(watch.warning(SELF, start + 21_500)).toBeUndefined()
  })

  it('counts an alternation interrupted by a repeated fix', () => {
    // A, B, A, A, B, A -- the duplicate is the winner reporting twice, which
    // is not a transition and must not wipe the sequence either.
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    for (const [i, source] of ['gps.a', 'gps.b', 'gps.a', 'gps.a', 'gps.b', 'gps.a'].entries()) {
      watch.add(SELF, source, start + i * 100)
    }

    expect(watch.warning(SELF, start + 700)).toMatch(/arriving from 2 sources/)
  })

  it('clears the warning once the conflict stops recurring', () => {
    // The reported symptom: priorities are fixed, one source stops competing,
    // and the message has to go away on its own rather than needing a
    // restart.
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    competing(watch, SELF, 'gps.a', 'gps.b', start)
    expect(watch.warning(SELF, start + 1000)).toMatch(/arriving from 2 sources/)

    // Only the winner keeps reporting, well past the retention window.
    watch.add(SELF, 'gps.a', start + 5 * 60 * 1000)

    expect(watch.warning(SELF, start + 5 * 60 * 1000)).toBeUndefined()
  })

  it('names only the sources still live', () => {
    // A source superseded hours ago is not part of the problem and naming it
    // sends the user hunting for a receiver that is no longer competing.
    const watch = new SourceWatch()
    const start = Date.UTC(2026, 0, 1)

    watch.add(SELF, 'gps.ancient', start)
    competing(watch, SELF, 'gps.a', 'gps.b', start + 60 * 60 * 1000)

    const warning = watch.warning(SELF, start + 60 * 60 * 1000 + 1000)

    // Order follows when each was found competing, which is not worth pinning.
    expect(warning).toMatch(/gps\.a/)
    expect(warning).toMatch(/gps\.b/)
    expect(warning).not.toMatch(/ancient/)
  })
})
