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
 * Driven through `render()` below, which evaluates the script against a stub
 * document -- reading a rendered row rather than the source, so a refactor of
 * how the label is produced does not fail a test about what it says.
 */
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
    it(`agrees for ${JSON.stringify(properties)}`, async () => {
      const lookup = (path: string) =>
        properties.contextName !== undefined && path === `${properties.context}.name`
          ? properties.contextName
          : undefined

      // Read off a rendered row rather than out of the source, so a refactor
      // of how the label is produced does not fail a test about what it says.
      const { tbody } = await render({
        body: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: null,
              properties: { ...properties, from: '2026-09-01T00:00:00Z', to: '2026-09-01T01:00:00Z', pointCount: 2 },
            },
          ],
        },
      })

      expect(tbody.children[0]!.children[0]!.textContent).toBe(
        trackLabel(properties.context, properties.isSelf ? properties.context : SELF, lookup),
      )
    })
  }
})

/**
 * The render path, driven end to end against a stub DOM.
 *
 * `label()` being right does not mean a row reaches the table: parsing the
 * FeatureCollection, mapping properties, sorting and appending are all
 * untested by the agreement suite above, and a regression in any of them
 * leaves the page blank while every other test passes.
 */
interface StubElement {
  tagName: string
  textContent: string
  className: string
  hidden: boolean
  dataset: Record<string, string>
  children: StubElement[]
}

const element = (tagName: string): StubElement => {
  const el: StubElement = {
    tagName,
    textContent: '',
    className: '',
    hidden: false,
    dataset: {},
    children: [],
  }
  return Object.assign(el, {
    append: (...kids: StubElement[]) => el.children.push(...kids),
    replaceChildren: (...kids: StubElement[]) => {
      el.children.length = 0
      el.children.push(...kids)
    },
  })
}

/** Loads public/tracks.js against a stub document and a scripted fetch. */
async function render(
  response: { status?: number; ok?: boolean; body?: unknown } | Error | 'stall',
  options: { timeoutMs?: number } = {},
) {
  const status = element('p')
  const tbody = element('tbody')
  const table = element('table')
  table.hidden = true

  const document = {
    getElementById: (id: string) => (id === 'status' ? status : table),
    createElement: element,
  }
  Object.assign(table, { querySelector: () => tbody })

  const source = readFileSync(new URL('../public/tracks.js', import.meta.url), 'utf8')
  const script =
    options.timeoutMs === undefined
      ? source
      : source.replace(/const REQUEST_TIMEOUT_MS = [\d_]+/, `const REQUEST_TIMEOUT_MS = ${options.timeoutMs}`)
  const run = new Function(
    'document',
    'fetch',
    `return (async () => { ${script.replace(/^void load\(\)$/m, 'await load()')} })()`,
  ) as (d: unknown, f: unknown) => Promise<void>

  await run(document, (_url: string, init: { signal?: AbortSignal }) => {
    if (response === 'stall') {
      // Never settles on its own: only the page's own deadline ends it, which
      // is the thing under test.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    if (response instanceof Error) {
      return Promise.reject(response)
    }
    return Promise.resolve({
      status: response.status ?? 200,
      ok: response.ok ?? true,
      json: () => (response.body instanceof Error ? Promise.reject(response.body) : Promise.resolve(response.body)),
    })
  })

  return { status, tbody, table }
}

const feature = (properties: Record<string, unknown>) => ({ type: 'Feature', geometry: null, properties })

describe('the webapp renders what the API returns', () => {
  it('puts a row in the table for each track', async () => {
    const { tbody, table, status } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            context: SELF,
            isSelf: true,
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T02:00:00Z',
            pointCount: 12,
          }),
          feature({
            context: OTHER,
            contextName: 'Ariadne',
            isSelf: false,
            from: '2026-09-02T00:00:00Z',
            to: '2026-09-02T01:00:00Z',
            pointCount: 7,
          }),
        ],
      },
    })

    expect(table.hidden).toBe(false)
    expect(tbody.children).toHaveLength(2)
    expect(status.textContent).toContain('2 tracks')
  })

  // Newest first: the track someone came to look at is the one that just
  // finished, and a list ordered by whatever the store returned buries it.
  it('sorts newest first', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            context: SELF,
            isSelf: true,
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T02:00:00Z',
            pointCount: 1,
          }),
          feature({
            context: OTHER,
            contextName: 'Ariadne',
            isSelf: false,
            from: '2026-09-05T00:00:00Z',
            to: '2026-09-05T01:00:00Z',
            pointCount: 1,
          }),
        ],
      },
    })

    expect(tbody.children[0]!.children[0]!.textContent).toBe('AIS Ariadne')
    expect(tbody.children[1]!.children[0]!.textContent).toBe('Own Ship')
  })

  it('renders the point count', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            context: SELF,
            isSelf: true,
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T02:00:00Z',
            pointCount: 4321,
          }),
        ],
      },
    })

    expect(tbody.children[0]!.children[3]!.textContent).toBe('4321')
  })

  it('says so when there is nothing recorded', async () => {
    const { status, table } = await render({ body: { type: 'FeatureCollection', features: [] } })

    expect(table.hidden).toBe(true)
    expect(status.textContent).toContain('No tracks')
  })

  // 501 is the server saying no provider is registered, which is a different
  // thing from a failure and worth saying plainly.
  it('distinguishes a missing provider from an error', async () => {
    const { status } = await render({ status: 501, ok: false })

    expect(status.textContent).toContain('No track provider')
    expect(status.dataset.state).toBe('error')
  })

  // Every other failure ends in a message; a request that never settles is
  // the one that leaves the page on "Loading…" indefinitely, which reads as a
  // hang rather than a failure.
  it('gives up on a request that never answers', async () => {
    // AbortSignal.timeout runs on a real timer that fake timers do not drive,
    // so the page's own constant is overridden rather than waited out.
    const { status, table } = await render('stall', { timeoutMs: 20 })

    expect(table.hidden).toBe(true)
    expect(status.dataset.state).toBe('error')
    expect(status.textContent).toContain('in time')
  })

  it('reports an unreachable server', async () => {
    const { status, table } = await render(new Error('offline'))

    expect(table.hidden).toBe(true)
    expect(status.dataset.state).toBe('error')
  })

  // `void load()` means nothing catches a rejection, so an unhandled one
  // leaves the page on "Loading…" -- indistinguishable from a hang.
  it('reports a 200 whose body is not JSON', async () => {
    const { status, table } = await render({ body: new Error('Unexpected token <') })

    expect(table.hidden).toBe(true)
    expect(status.dataset.state).toBe('error')
    expect(status.textContent).not.toContain('Loading')
  })

  it('skips a malformed feature rather than blanking the list', async () => {
    const { tbody, table } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          null,
          { type: 'Feature', geometry: null },
          feature({
            context: SELF,
            isSelf: true,
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T02:00:00Z',
            pointCount: 3,
          }),
        ],
      },
    })

    expect(table.hidden).toBe(false)
    expect(tbody.children).toHaveLength(1)
  })

  // A feature with a context but no pointCount would render "undefined" in
  // the Points column, which looks like a bug in the recorder rather than a
  // bad response.
  it('skips a feature with no point count', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            context: OTHER,
            contextName: 'Ariadne',
            isSelf: false,
            from: '2026-09-02T00:00:00Z',
            to: '2026-09-02T01:00:00Z',
          }),
          feature({
            context: SELF,
            isSelf: true,
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T02:00:00Z',
            pointCount: 3,
          }),
        ],
      },
    })

    expect(tbody.children).toHaveLength(1)
    expect(tbody.children[0]!.children[0]!.textContent).toBe('Own Ship')
  })

  it('shows the empty state when every feature is malformed', async () => {
    const { status, table } = await render({
      body: { type: 'FeatureCollection', features: [null, { type: 'Feature' }] },
    })

    expect(table.hidden).toBe(true)
    expect(status.textContent).toContain('No tracks')
  })

  // An error object or a login page is a failure, not an empty list; saying
  // "no tracks" for it tells the user the opposite of what happened.
  it('reports a response that is not a FeatureCollection', async () => {
    const { status, table } = await render({ body: { error: 'failed' } })

    expect(table.hidden).toBe(true)
    expect(status.dataset.state).toBe('error')
    expect(status.textContent).not.toContain('No tracks')
  })
})
