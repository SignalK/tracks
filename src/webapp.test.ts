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
  href?: string
  rel?: string
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

async function render(
  response: { status?: number; ok?: boolean; body?: unknown } | Error | 'stall' | 'stall-body',
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
  // The page's own deadline is left alone; only the clock behind it is
  // substituted, so nothing here depends on how the constant is spelled.
  const abortSignal =
    options.timeoutMs === undefined ? AbortSignal : { timeout: () => AbortSignal.timeout(options.timeoutMs!) }
  const run = new Function(
    'document',
    'fetch',
    'AbortSignal',
    `return (async () => { ${source.replace(/^void load\(\)$/m, '')} await load() })()`,
  ) as (d: unknown, f: unknown, a: unknown) => Promise<void>

  const requested: string[] = []
  await run(
    document,
    (url: string, init: { signal?: AbortSignal }) => {
      requested.push(url)
      if (response === 'stall-body') {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        })
      }
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
    },
    abortSignal,
  )

  return { status, tbody, table, requested }
}

const feature = (properties: Record<string, unknown>) => ({ type: 'Feature', geometry: null, properties })

// The request the page makes is a contract with the v2 API, and the e2e tier
// that proves it end to end is opt-in -- so it is pinned here too, where CI
// actually runs it. The duration is load-bearing: without it the API rejects
// an unbounded multi-context query and the page shows an error.
describe('the webapp asks the API for the right thing', () => {
  const requestedUrl = async () => {
    const { requested } = await render({ body: { type: 'FeatureCollection', features: [] } })
    expect(requested).toHaveLength(1)
    // Resolved against where the server mounts the page, which is what makes
    // the relative path meaningful.
    return new URL(requested[0]!, 'http://localhost/@signalk/tracks-plugin/index.html')
  }

  it('climbs out of the scoped mount to the v2 endpoint', async () => {
    expect((await requestedUrl()).pathname).toBe('/signalk/v2/api/tracks')
  })

  it('asks for metadata only, over a bounded window', async () => {
    const { searchParams } = await requestedUrl()

    expect(searchParams.get('geometry')).toBe('false')
    expect(searchParams.get('duration')).toBe('P30D')
  })
})

// The page is served from a scoped path, so an absolute or wrongly-relative
// asset reference resolves outside the mount and silently loads nothing.
describe('the page references its assets relatively', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  const mount = 'http://localhost/@signalk/tracks-plugin/index.html'

  it.each([
    ['stylesheet', /<link[^>]+href="([^"]+)"/],
    ['script', /<script[^>]+src="([^"]+)"/],
  ])('resolves the %s inside the mount', (_what, pattern) => {
    const href = pattern.exec(html)?.[1]
    expect(href).toBeDefined()

    expect(new URL(href!, mount).pathname).toMatch(/^\/@signalk\/tracks-plugin\//)
  })
})

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

  // The deadline stays armed through json(), so a response whose headers
  // arrive and whose body then stops mid-stream is caught too -- stalling only
  // the fetch would leave that path uncovered.
  it('gives up on a response whose body never finishes', async () => {
    const { status, table } = await render('stall-body', { timeoutMs: 20 })

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

// The export link is a plain <a>, so the browser handles saving and the page
// never holds a whole track in memory.
describe('the webapp offers a GPX download', () => {
  it('links the own vessel through the self alias', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            context: SELF,
            isSelf: true,
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T02:00:00Z',
            pointCount: 2,
          }),
        ],
      },
    })

    const link = tbody.children[0]!.children[4]!.children[0]!
    expect(link.href).toContain('/self/track.gpx')
  })

  it('links another vessel by its context', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            context: OTHER,
            contextName: 'Ariadne',
            isSelf: false,
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T02:00:00Z',
            pointCount: 2,
          }),
        ],
      },
    })

    const link = tbody.children[0]!.children[4]!.children[0]!
    expect(link.href).toContain(encodeURIComponent(OTHER))
    expect(link.href).toContain('track.gpx')
  })

  // The list shows a bounded window, and the export must not quietly differ
  // from what the row says it contains.
  it('exports the same window the list shows', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            context: SELF,
            isSelf: true,
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T02:00:00Z',
            pointCount: 2,
          }),
        ],
      },
    })

    expect(tbody.children[0]!.children[4]!.children[0]!.href).toContain('duration=P30D')
  })
})
