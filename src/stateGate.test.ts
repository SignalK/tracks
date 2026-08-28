import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createHarness } from './harness.test-utils.js'
import { DEFAULT_PAUSE_STATES, PAUSABLE_STATES, StateGate } from './stateGate.js'
import type { Context, LatLngTuple } from './types.js'

const SELF = 'vessels.urn:mrn:imo:mmsi:123456789' as Context
const OTHER = 'vessels.urn:mrn:imo:mmsi:987654321' as Context

const gate = (states: readonly string[] = ['moored']) => new StateGate(SELF, states)

describe('StateGate', () => {
  it('is off by default, so nothing changes for an install that has not opted in', () => {
    expect(DEFAULT_PAUSE_STATES).toEqual([])
    const g = new StateGate(SELF, DEFAULT_PAUSE_STATES)
    expect(g.enabled).toBe(false)
    expect(g.accept(SELF, 'moored')).toBe(true)
  })

  it('pauses on a configured state', () => {
    expect(gate().accept(SELF, 'moored')).toBe(false)
  })

  it('records in any state that is not configured', () => {
    const g = gate(['moored'])
    for (const state of ['sailing', 'motoring', 'anchored', 'fishing']) {
      expect(g.accept(SELF, state)).toBe(true)
    }
  })

  it('records when the vessel reports no state at all', () => {
    // Most boats do not set navigation.state. Treating absent as "paused"
    // would silently stop recording for them.
    expect(gate().accept(SELF, undefined)).toBe(true)
  })

  it('leaves AIS targets alone whatever they report', () => {
    // Their navigational status is operator-set on the transponder and often
    // stale; a vessel under way still reporting 'moored' is ordinary.
    const g = gate(['moored'])
    expect(g.accept(OTHER, 'moored')).toBe(true)
  })

  it('does not offer anchored as a default', () => {
    // An anchor alarm watches exactly the track a vessel makes while anchored.
    expect(DEFAULT_PAUSE_STATES).not.toContain('anchored')
  })

  it('pauses on anchored only when explicitly asked', () => {
    expect(gate(['moored']).accept(SELF, 'anchored')).toBe(true)
    expect(gate(['anchored']).accept(SELF, 'anchored')).toBe(false)
  })

  it('honours several configured states', () => {
    const g = gate(['moored', 'not-under-way', 'aground'])
    expect(g.accept(SELF, 'moored')).toBe(false)
    expect(g.accept(SELF, 'not-under-way')).toBe(false)
    expect(g.accept(SELF, 'aground')).toBe(false)
    expect(g.accept(SELF, 'sailing')).toBe(true)
  })

  it('offers only states a boat is plausibly parked in', () => {
    expect(PAUSABLE_STATES).toContain('moored')
    expect(PAUSABLE_STATES).toContain('anchored')
    // The wider navigation.state enum is mostly AIS status; offering
    // 'trawling-hauling' as a reason to stop recording would be noise.
    expect(PAUSABLE_STATES).not.toContain('trawling-hauling')
    expect(PAUSABLE_STATES.length).toBeLessThan(6)
  })

  it('counts what it skipped', () => {
    const g = gate()
    g.accept(SELF, 'moored')
    g.accept(SELF, 'moored')
    g.accept(SELF, 'sailing')
    expect(g.skipped).toBe(2)
  })

  it('reports the last state seen', () => {
    const g = gate()
    g.accept(SELF, 'sailing')
    expect(g.state).toBe('sailing')
  })

  it('does not let an AIS target overwrite the reported state', () => {
    const g = gate()
    g.accept(SELF, 'sailing')
    g.accept(OTHER, 'moored')
    expect(g.state).toBe('sailing')
  })

  describe('status line', () => {
    it('says nothing while recording', () => {
      const g = gate()
      g.accept(SELF, 'sailing')
      expect(g.status()).toBeUndefined()
    })

    it('says nothing when the gate is off', () => {
      const g = new StateGate(SELF, [])
      g.accept(SELF, 'moored')
      expect(g.status()).toBeUndefined()
    })

    it('says nothing before any position has been seen', () => {
      expect(gate().status()).toBeUndefined()
    })

    it('names the state and the count while paused', () => {
      const g = gate()
      g.accept(SELF, 'moored')
      g.accept(SELF, 'moored')
      const status = g.status()
      expect(status).toContain('moored')
      expect(status).toContain('2')
    })

    it('stops reporting once the vessel moves again', () => {
      const g = gate()
      g.accept(SELF, 'moored')
      expect(g.status()).toBeDefined()
      g.accept(SELF, 'sailing')
      expect(g.status()).toBeUndefined()
    })
  })

  it('forgets everything when cleared', () => {
    const g = gate()
    g.accept(SELF, 'moored')
    g.clear()
    expect(g.skipped).toBe(0)
    expect(g.state).toBeUndefined()
    expect(g.status()).toBeUndefined()
  })
})

// The gate wired into the plugin: a position arriving while paused must not
// reach the store, and one arriving while under way must.
describe('state gating through the plugin', () => {
  const API = '/signalk/v1/api'
  const SELF_ID = SELF.replace('vessels.', '')
  const MINUTE = 60_000
  const HELSINKI: LatLngTuple = [60.1, 24.9]
  const NEARBY: LatLngTuple = [60.11, 24.9]

  const coordinatesFor = async (h: ReturnType<typeof createHarness>) => {
    const res = await request(h.app).get(`${API}/vessels/${SELF_ID}/track`)
    return res.status === 200 ? (res.body.coordinates as [number, number][][]).flat() : []
  }

  /**
   * Feed two positions, changing state between them, so both reach the store.
   *
   * `throttleTime` thins on the leading edge against the wall clock, so two
   * synchronous emits arrive as a single point regardless of what the gate
   * decides — which would make these assertions pass with the gate removed.
   */
  const feedAcrossStateChange = async (
    h: ReturnType<typeof createHarness>,
    secondState: string | undefined,
  ): Promise<[number, number][]> => {
    const t0 = Date.now() - 10 * MINUTE
    h.emit(SELF, HELSINKI, t0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    h.setSelfState(secondState)
    h.emit(SELF, NEARBY, t0 + MINUTE)
    return coordinatesFor(h)
  }

  it('stops recording once the vessel reports a paused state', async () => {
    const h = createHarness({
      selfPosition: [60, 24],
      selfState: 'sailing',
      config: { resolution: 0, pauseWhenState: ['moored'] },
    })
    try {
      const coordinates = await feedAcrossStateChange(h, 'moored')

      expect(coordinates).toContainEqual([24.9, 60.1])
      expect(coordinates).not.toContainEqual([24.9, 60.11])
    } finally {
      h.stop()
    }
  })

  it('keeps recording while under way', async () => {
    const h = createHarness({
      selfPosition: [60, 24],
      selfState: 'sailing',
      config: { resolution: 0, pauseWhenState: ['moored'] },
    })
    try {
      const coordinates = await feedAcrossStateChange(h, 'motoring')

      expect(coordinates).toContainEqual([24.9, 60.1])
      expect(coordinates).toContainEqual([24.9, 60.11])
    } finally {
      h.stop()
    }
  })

  it('keeps recording at anchor, which an anchor alarm depends on', async () => {
    const h = createHarness({
      selfPosition: [60, 24],
      selfState: 'sailing',
      config: { resolution: 0, pauseWhenState: ['moored'] },
    })
    try {
      const coordinates = await feedAcrossStateChange(h, 'anchored')

      expect(coordinates).toContainEqual([24.9, 60.11])
    } finally {
      h.stop()
    }
  })

  it('records everything when no states are configured', async () => {
    const h = createHarness({
      selfPosition: [60, 24],
      selfState: 'sailing',
      config: { resolution: 0 },
    })
    try {
      const coordinates = await feedAcrossStateChange(h, 'moored')

      expect(coordinates).toContainEqual([24.9, 60.1])
      expect(coordinates).toContainEqual([24.9, 60.11])
    } finally {
      h.stop()
    }
  })

  it('reports being paused on the dashboard', async () => {
    vi.useFakeTimers()
    const h = createHarness({
      selfPosition: [60, 24],
      selfState: 'moored',
      config: { resolution: 0, pauseWhenState: ['moored'] },
    })
    try {
      h.emit(SELF, HELSINKI, Date.now())
      vi.advanceTimersByTime(30_000)

      expect(h.statuses.some((s) => s.includes('moored'))).toBe(true)
    } finally {
      h.stop()
      vi.useRealTimers()
    }
  })
})
