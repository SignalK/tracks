import { describe, expect, it } from 'vitest'
import { resolveSource } from './index.js'

/**
 * `source` replaces the `bootstrapFromHistory` boolean. Every installed plugin
 * has that boolean saved in its config, so these pin the migration: an existing
 * install must keep behaving exactly as it did before the setting changed.
 */
describe('resolveSource', () => {
  it('defaults to history, matching the old default of bootstrapFromHistory: true', () => {
    expect(resolveSource({})).toBe('history')
  })

  it('honours an explicit source', () => {
    expect(resolveSource({ source: 'sqlite' })).toBe('sqlite')
    expect(resolveSource({ source: 'memory' })).toBe('memory')
    expect(resolveSource({ source: 'history' })).toBe('history')
  })

  it('maps a saved bootstrapFromHistory: false to memory', () => {
    // Someone who turned the bootstrap off did not want the History API
    // touched; that must survive the upgrade.
    expect(resolveSource({ bootstrapFromHistory: false })).toBe('memory')
  })

  it('maps a saved bootstrapFromHistory: true to history', () => {
    expect(resolveSource({ bootstrapFromHistory: true })).toBe('history')
  })

  it('prefers source over the setting it replaced', () => {
    // Both present: the new setting wins, so choosing sqlite in the UI is not
    // silently overridden by the leftover boolean.
    expect(resolveSource({ source: 'sqlite', bootstrapFromHistory: true })).toBe('sqlite')
    expect(resolveSource({ source: 'history', bootstrapFromHistory: false })).toBe('history')
  })
})
