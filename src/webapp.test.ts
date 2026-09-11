import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { trackLabel } from './utils.js'

/**
 * The webapp ships as plain static files with no build step, so it cannot
 * import from `src/`. Its label function therefore duplicates `trackLabel()`,
 * and the two must agree: the same track showing as `AIS Ariadne` on one
 * screen and `987654321` on another is the kind of thing nobody reports as a
 * bug but everybody notices.
 *
 * The script is loaded as text and evaluated rather than imported, because it
 * touches `document` at module scope.
 */
const source = readFileSync(new URL('../public/tracks.js', import.meta.url), 'utf8')

const labelFromWebapp = (properties: { context: string; contextName?: string; isSelf: boolean }): string => {
  const body = /function label\(\{[^}]*\}\) \{([\s\S]*?)\n\}/.exec(source)
  if (!body) {
    throw new Error('could not find label() in public/tracks.js')
  }
  const fn = new Function('properties', `const { context, contextName, isSelf } = properties;${body[1]}`) as (
    p: unknown,
  ) => string
  return fn(properties)
}

const SELF = 'vessels.urn:mrn:imo:mmsi:123456789'
const OTHER = 'vessels.urn:mrn:imo:mmsi:987654321'

describe('the webapp labels tracks as the server does', () => {
  const cases: { context: string; contextName?: string; isSelf: boolean }[] = [
    { context: SELF, isSelf: true },
    { context: OTHER, contextName: 'Ariadne', isSelf: false },
    { context: OTHER, isSelf: false },
    { context: 'vessels.urn:mrn:signalk:uuid:abc', isSelf: false },
  ]

  for (const properties of cases) {
    it(`agrees for ${JSON.stringify(properties)}`, () => {
      const lookup = (path: string) =>
        properties.contextName !== undefined && path === `${properties.context}.name`
          ? properties.contextName
          : undefined

      expect(labelFromWebapp(properties)).toBe(
        trackLabel(properties.context, properties.isSelf ? properties.context : SELF, lookup),
      )
    })
  }
})
