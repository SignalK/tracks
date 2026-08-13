import { describe, expect, it, vi } from 'vitest'
import { createHarness } from './harness.test-utils.js'
import { SourceWatch } from './sourceWatch.js'
import type { Context } from './types.js'

const SELF = 'vessels.urn:mrn:imo:mmsi:123456789' as Context
const OTHER = 'vessels.urn:mrn:imo:mmsi:987654321' as Context

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
    w.add(SELF, 'gps.0')
    w.add(SELF, 'n2k.1')

    const warning = w.warning(SELF)
    expect(warning).toContain('gps.0')
    expect(warning).toContain('n2k.1')
    expect(warning).toContain('source priority')
  })

  it('counts other vessels rather than naming them', () => {
    // AIS targets legitimately arrive via several receivers; that is not a
    // misconfiguration the user needs to fix, so it is not worth naming each.
    const w = new SourceWatch()
    w.add(OTHER, 'ais.0')
    w.add(OTHER, 'ais.1')

    const warning = w.warning(SELF)
    expect(warning).toContain('1 vessel')
    expect(warning).not.toContain(OTHER)
  })

  it('mentions both the own vessel and the count of others', () => {
    const w = new SourceWatch()
    w.add(SELF, 'gps.0')
    w.add(SELF, 'n2k.1')
    w.add(OTHER, 'ais.0')
    w.add(OTHER, 'ais.1')

    const warning = w.warning(SELF)
    expect(warning).toContain('own vessel')
    expect(warning).toContain('1 other vessel')
  })

  it('pluralises the count of other vessels', () => {
    const w = new SourceWatch()
    for (const [i, mmsi] of ['111', '222'].entries()) {
      const context = `vessels.urn:mrn:imo:mmsi:${mmsi}` as Context
      w.add(context, `ais.${i}`)
      w.add(context, `n2k.${i}`)
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
    w.add(SELF, 'gps.0')
    w.add(SELF, 'n2k.1')

    expect(w.warning(undefined)).toContain('1 vessel')
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
  it('warns on the dashboard when the own vessel has two position sources', () => {
    vi.useFakeTimers()
    const h = createHarness({ selfPosition: [60, 24] })
    try {
      h.emit(SELF, [60.1, 24.9], undefined, 'gps.0')
      h.emit(SELF, [60.1, 24.91], undefined, 'n2k.1')

      expect(h.statuses).toEqual([])
      vi.advanceTimersByTime(30_000)

      expect(h.statuses).toHaveLength(1)
      expect(h.statuses[0]).toContain('gps.0')
      expect(h.statuses[0]).toContain('n2k.1')
    } finally {
      h.stop()
      vi.useRealTimers()
    }
  })

  it('stays quiet with a single source', () => {
    vi.useFakeTimers()
    const h = createHarness({ selfPosition: [60, 24] })
    try {
      h.emit(SELF, [60.1, 24.9], undefined, 'gps.0')
      h.emit(SELF, [60.1, 24.91], undefined, 'gps.0')
      vi.advanceTimersByTime(120_000)

      expect(h.statuses).toEqual([])
    } finally {
      h.stop()
      vi.useRealTimers()
    }
  })

  it('stops reporting once the plugin is stopped', () => {
    vi.useFakeTimers()
    const h = createHarness({ selfPosition: [60, 24] })
    try {
      h.emit(SELF, [60.1, 24.9], undefined, 'gps.0')
      h.emit(SELF, [60.1, 24.91], undefined, 'n2k.1')
      h.stop()
      vi.advanceTimersByTime(120_000)

      expect(h.statuses).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
