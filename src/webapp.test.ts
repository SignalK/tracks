import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackLabel } from './utils.js'
import { parseDuration } from './timeWindow.js'
// @ts-expect-error -- plain JavaScript shipped as-is, with no declarations
import { deletedPart, label as binLabel, localInput, refusal, spanQuery } from '../public/bin.js'
// @ts-expect-error -- plain JavaScript shipped as-is, with no declarations
import { imported, importQuery, start as startImport } from '../public/import.js'
// @ts-expect-error -- plain JavaScript shipped as-is, with no declarations
import { confirmed, start as startDanger } from '../public/danger.js'
// @ts-expect-error -- plain JavaScript shipped as-is, with no declarations
import { historyView, POLL_MS, start as startHistory } from '../public/history.js'

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

/**
 * The plugin's icon, which two different consumers resolve differently.
 *
 * The admin UI composes the webapp's mount root with `signalk.appIcon`, and
 * that mount root *is* `public/` — so a declaration of `./public/app-icon.svg`
 * points a level too deep and 404s, while the file still serves fine at the
 * URL a human would try. That is exactly how this shipped broken: the asset
 * was verified at a path nothing actually requests.
 *
 * The page links the same file as its favicon, relative to the same root, so
 * one declaration has to satisfy both.
 */
describe('the app icon', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    signalk?: { appIcon?: string }
    files?: string[]
  }

  it('declares an icon that exists under the webapp root', () => {
    const declared = pkg.signalk?.appIcon
    expect(declared).toBeDefined()

    // Resolved the way the admin UI resolves it: against public/, which is
    // what the server mounts at the webapp's URL root.
    const onDisk = `public/${declared!.replace(/^\.\//, '')}`

    expect(existsSync(onDisk)).toBe(true)
  })

  it('links the same file as the page favicon', () => {
    const declared = pkg.signalk?.appIcon!.replace(/^\.\//, '')
    const html = readFileSync('public/index.html', 'utf8')
    const href = /<link[^>]+rel="icon"[^>]+href="([^"]+)"/.exec(html)?.[1]

    expect(href).toBeDefined()
    expect(href!.replace(/^\.\//, '')).toBe(declared)
  })

  // Two consumers resolve the same declaration differently, so the file ships
  // at both paths rather than betting on one of them.
  //
  // The admin UI composes the webapp's mount root -- which *is* public/ --
  // with appIcon. The App Store resolves it package-relative against the CDN,
  // and only finds public/ by falling back through a candidate list after the
  // primary URL 404s. A root copy costs 1.7 kB, spares that round-trip, and
  // stops the packaging check warning on every release.
  it('ships the icon at both paths every consumer resolves', () => {
    const basename = pkg.signalk!.appIcon!.replace(/^\.\//, '')

    // Package-relative: what the App Store asks the CDN for first.
    expect(pkg.files).toContain(basename)
    expect(existsSync(basename)).toBe(true)

    // Webapp root: what the admin UI and the page favicon resolve.
    expect(pkg.files).toContain('public')
    expect(existsSync(`public/${basename}`)).toBe(true)
  })

  // Same discipline as the icon, applied before it can break: the App Store
  // reads these package-relative, so a path that does not ship is a real 404
  // rather than the advisory warning a mislocated icon produces.
  it('declares screenshots that actually ship', () => {
    const shots = (pkg.signalk as { screenshots?: string[] }).screenshots
    expect(shots).toBeDefined()
    expect(shots!.length).toBeGreaterThan(0)

    for (const shot of shots!) {
      const relative = shot.replace(/^\.\//, '')
      expect(existsSync(relative), relative).toBe(true)
      // The files allowlist is what decides whether it reaches the tarball.
      const top = relative.split('/')[0]!
      expect(pkg.files, `${relative} needs "${top}" in files`).toContain(top)
    }
  })

  it('keeps the two copies identical', () => {
    // A stale root copy would show the old icon in the App Store while the
    // plugin list showed the new one.
    const basename = pkg.signalk!.appIcon!.replace(/^\.\//, '')

    expect(readFileSync(basename, 'utf8')).toBe(readFileSync(`public/${basename}`, 'utf8'))
  })
})

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
  attributes: Record<string, string>
}

const element = (tagName: string): StubElement => {
  const el: StubElement = {
    tagName,
    textContent: '',
    className: '',
    hidden: false,
    dataset: {},
    children: [],
    attributes: {},
  }
  return Object.assign(el, {
    addEventListener: () => {},
    setAttribute: (name: string, value: string) => {
      el.attributes[name] = value
    },
    append: (...kids: StubElement[]) => el.children.push(...kids),
    replaceChildren: (...kids: StubElement[]) => {
      el.children.length = 0
      el.children.push(...kids)
    },
  })
}

/** A response, or a failure. */
type Answer = { status?: number; ok?: boolean; body?: unknown } | Error | 'stall' | 'stall-body'

/** What a server answers for the own vessel alone, given its answer for every vessel. */
const ownPart = (response: Answer): Answer => {
  if (typeof response !== 'object' || response instanceof Error) return response
  const body = response.body as { type?: string; features?: { properties?: { isSelf?: boolean } }[] } | undefined
  return body?.type === 'FeatureCollection' && Array.isArray(body.features)
    ? { ...response, body: { ...body, features: body.features.filter((f) => f?.properties?.isSelf) } }
    : response
}

async function render(
  response: Answer,
  /**
   * `own` answers the request for the own vessel's tracks alone, which otherwise gets `response`.
   * `timeoutMs` sets every timeout the page starts; `speedUp` runs them that many times faster,
   * keeping how they compare.
   */
  options: {
    timeoutMs?: number
    speedUp?: number
    imports?: unknown[]
    byId?: boolean
    own?: Answer
    /** What the plugin's settings route answers; by default it is missing, as on a server keeping it to administrators. */
    settings?: unknown
  } = {},
) {
  const status = element('p')
  // Every status the page showed, in order, since the last one overwrites the rest.
  const shown: string[] = []
  Object.defineProperty(status, 'textContent', {
    get: () => shown[shown.length - 1] ?? '',
    set: (text: string) => shown.push(text),
  })
  const listOf = () => {
    const table = element('table')
    const tbody = element('tbody')
    table.hidden = true
    Object.assign(table, { querySelector: () => tbody })
    return { table, tbody, note: element('p') }
  }
  const lists = { own: listOf(), others: listOf(), imported: listOf() }
  const elements: Record<string, StubElement> = {
    status,
    'own-tracks': lists.own.table,
    'other-tracks': lists.others.table,
    'imported-tracks': lists.imported.table,
    'own-note': lists.own.note,
    'others-note': lists.others.note,
    'imported-note': lists.imported.note,
  }
  // Every row of the three lists, own vessel first, for the tests that do not
  // care which list a row is in; `table` is hidden while all three are.
  const tbody = {
    get children() {
      return [...lists.own.tbody.children, ...lists.others.tbody.children, ...lists.imported.tbody.children]
    },
  }
  const table = {
    get hidden() {
      return Object.values(lists).every(({ table }) => table.hidden)
    },
  }

  const document = {
    getElementById: (id: string) => elements[id],
    createElement: element,
  }

  const source = readFileSync(new URL('../public/tracks.js', import.meta.url), 'utf8')
  // The page's own deadline is left alone; only the clock behind it is
  // substituted, so nothing here depends on how the constant is spelled.
  const abortSignal =
    options.timeoutMs !== undefined
      ? { timeout: () => AbortSignal.timeout(options.timeoutMs!) }
      : options.speedUp !== undefined
        ? { timeout: (ms: number) => AbortSignal.timeout(ms / options.speedUp!) }
        : AbortSignal
  const run = new Function(
    'document',
    'fetch',
    'AbortSignal',
    `return (async () => { ${source.replace(/^void load\(\)$/m, '')} await load() })()`,
  ) as (d: unknown, f: unknown, a: unknown) => Promise<void>

  const requested: string[] = []
  // What happened to the two track requests, in order: asked, read or aborted.
  const events: string[] = []
  await run(
    document,
    (url: string, init: { signal?: AbortSignal }) => {
      // As a real fetch does: a request sent after the deadline fails at once,
      // rather than waiting for an abort that has already happened.
      if (init.signal?.aborted) {
        return Promise.reject(init.signal.reason)
      }
      if (url.endsWith('/plugins/tracks/settings')) {
        return Promise.resolve(
          options.settings === undefined
            ? { status: 404, ok: false, json: () => Promise.reject(new Error('not JSON')) }
            : { status: 200, ok: true, json: () => Promise.resolve(options.settings) },
        )
      }
      // Every import, from the plugin's own route; a server without it answers 404.
      if (url.endsWith('/plugins/tracks/imports')) {
        return Promise.resolve(
          options.imports === undefined
            ? { status: 404, ok: false, json: () => Promise.reject(new Error('not JSON')) }
            : { status: 200, ok: true, json: () => Promise.resolve(options.imports) },
        )
      }
      // One track by its id, which only a server with the write routes serves.
      if (url.includes('/signalk/v2/api/tracks/')) {
        const ok = options.byId ?? true
        return Promise.resolve({ status: ok ? 200 : 404, ok, json: () => Promise.resolve({}) })
      }
      requested.push(url)
      const kind = url.includes('contexts=vessels.self') ? 'own' : 'list'
      events.push(`asked ${kind}`)
      const aborted = (reject: (error: Error) => void) => () => {
        events.push(`aborted ${kind}`)
        reject(new Error('aborted'))
      }
      // The own vessel's request is answered from the list's answer, as the
      // server answers it: with the own vessel's tracks alone.
      const answer = kind === 'own' ? (options.own ?? ownPart(response)) : response
      if (answer === 'stall-body') {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', aborted(reject))
            }),
        })
      }
      if (answer === 'stall') {
        // Never settles on its own: only the page's own deadline ends it, which
        // is the thing under test.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', aborted(reject))
        })
      }
      if (answer instanceof Error) {
        return Promise.reject(answer)
      }
      return Promise.resolve({
        status: answer.status ?? 200,
        ok: answer.ok ?? true,
        json: () => {
          events.push(`read ${kind}`)
          return answer.body instanceof Error ? Promise.reject(answer.body) : Promise.resolve(answer.body)
        },
      })
    },
    abortSignal,
  )

  return { status, tbody, table, lists, requested, shown, events }
}

const feature = (properties: Record<string, unknown>) => ({ type: 'Feature', geometry: null, properties })

// The request the page makes is a contract with the v2 API, and the e2e tier
// that proves it end to end is opt-in -- so it is pinned here too, where CI
// actually runs it. The duration is load-bearing: without it the API rejects
// an unbounded multi-context query and the page shows an error.
describe('the webapp asks the API for the right thing', () => {
  /** The list request, or with `own` the one for the own vessel's tracks alone. */
  const requestedUrl = async (own = false) => {
    const { requested } = await render({ body: { type: 'FeatureCollection', features: [] } })
    expect(requested).toHaveLength(2)
    // Resolved against where the server mounts the page, which is what makes
    // the relative path meaningful.
    const urls = requested.map((url) => new URL(url, 'http://localhost/@signalk/tracks-plugin/index.html'))
    return urls.find(({ searchParams }) => searchParams.has('contexts') === own)!
  }

  it('climbs out of the scoped mount to the v2 endpoint', async () => {
    expect((await requestedUrl()).pathname).toBe('/signalk/v2/api/tracks')
  })

  it('asks for metadata only, over a bounded window', async () => {
    const { searchParams } = await requestedUrl()

    expect(searchParams.get('geometry')).toBe('false')
    expect(searchParams.get('duration')).toBe('P30D')
  })

  it('asks for the own vessel’s tracks alone', async () => {
    const { pathname, searchParams } = await requestedUrl(true)

    expect(pathname).toBe('/signalk/v2/api/tracks')
    expect(searchParams.get('contexts')).toBe('vessels.self')
    expect(searchParams.get('geometry')).toBe('false')
    // Its whole recording: one vessel needs no window.
    expect(searchParams.has('duration')).toBe(false)
  })

  // The list reaches back as far as the plugin keeps other vessels, so it
  // never says a month where it keeps a week.
  it.each([
    [7, 'P7D'],
    [0, 'P30D'],
    [undefined, 'P30D'],
  ])('asks for other vessels as far back as the plugin keeps them (%s days)', async (days, duration) => {
    const { requested } = await render(
      { body: { type: 'FeatureCollection', features: [] } },
      days === undefined ? {} : { settings: { aisRetentionDays: days } },
    )
    const list = requested
      .map((url) => new URL(url, 'http://localhost/@signalk/tracks-plugin/index.html'))
      .find(({ searchParams }) => !searchParams.has('contexts'))!

    expect(list.searchParams.get('duration')).toBe(duration)
  })

  // The store answers one query at a time, so the own vessel's, asked beside
  // the list, waited behind it.
  it('asks for the others only once the own vessel’s tracks are in', async () => {
    const { events } = await render(
      { body: { type: 'FeatureCollection', features: [] } },
      { own: { body: { type: 'FeatureCollection', features: [] } } },
    )

    expect(events).toEqual(['asked own', 'read own', 'asked list', 'read list'])
  })

  // A request can stall on its way while a new one gets through; waiting for
  // it until the deadline would leave the list no time at all.
  it('asks for the others anyway when the own vessel’s request stalls', async () => {
    const { events, tbody, status, shown } = await render(
      {
        body: {
          type: 'FeatureCollection',
          features: [
            feature({ context: SELF, isSelf: true, to: '2026-09-01T02:00:00Z', pointCount: 12 }),
            feature({
              context: OTHER,
              contextName: 'Ariadne',
              isSelf: false,
              to: '2026-09-02T01:00:00Z',
              pointCount: 7,
            }),
          ],
        },
      },
      { own: 'stall', speedUp: 500 },
    )

    expect(events).toEqual(['asked own', 'aborted own', 'asked list', 'read list'])
    expect(shown.some((text) => text.startsWith('Loading the other vessels…'))).toBe(false)
    expect(tbody.children).toHaveLength(2)
    expect(status.textContent).toBe('')
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
  it('puts each track in its list: the own vessel, other vessels, imports', async () => {
    const { lists, table, status } = await render({
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
    expect(lists.own.tbody.children.map((tr) => tr.children[0]!.textContent)).toEqual(['Own Ship'])
    expect(lists.others.tbody.children.map((tr) => tr.children[0]!.textContent)).toEqual(['AIS Ariadne'])
    expect(lists.imported.table.hidden).toBe(true)
    // Done: the lists say what they hold, and the status has nothing to add.
    expect(status.textContent).toBe('')
    expect(status.hidden).toBe(true)
  })

  // Newest first: the track someone came to look at is the one that just
  // finished, and a list ordered by whatever the store returned buries it.
  it('sorts newest first', async () => {
    const { lists } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            context: OTHER,
            contextName: 'Ariadne',
            isSelf: false,
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T02:00:00Z',
            pointCount: 1,
          }),
          feature({
            context: 'vessels.urn:mrn:imo:mmsi:111111111',
            contextName: 'Boreas',
            isSelf: false,
            from: '2026-09-05T00:00:00Z',
            to: '2026-09-05T01:00:00Z',
            pointCount: 1,
          }),
        ],
      },
    })

    expect(lists.others.tbody.children.map((tr) => tr.children[0]!.textContent)).toEqual(['AIS Boreas', 'AIS Ariadne'])
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
    const { lists, table } = await render({ body: { type: 'FeatureCollection', features: [] } })

    expect(table.hidden).toBe(true)
    expect(lists.own.note.textContent).toBe('Nothing recorded yet.')
    expect(lists.others.note.textContent).toBe('None in the last 30 days.')
    expect(lists.imported.note.textContent).toBe('No imported tracks.')
  })

  // The notes say how long other vessels are kept, as the plugin is set, so
  // the list never reads as though it kept them longer.
  it.each([
    [{ aisRetentionDays: 7 }, true, 'In the last 7 days. The plugin keeps them 7 days.'],
    [{ aisRetentionDays: 1 }, false, 'None in the last 1 day. The plugin keeps them 1 day.'],
    [{ aisRetentionDays: 0 }, true, 'In the last 30 days. The plugin keeps them indefinitely.'],
    [undefined, true, 'In the last 30 days.'],
  ])('says how long other vessels are kept (%j)', async (settings, any, note) => {
    const { lists } = await render(
      {
        body: {
          type: 'FeatureCollection',
          features: any ? [feature({ context: OTHER, isSelf: false, to: '2026-09-02T01:00:00Z', pointCount: 7 })] : [],
        },
      },
      settings === undefined ? {} : { settings },
    )

    expect(lists.others.note.textContent).toBe(note)
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
    const { status, table } = await render('stall', {
      timeoutMs: 20,
      own: { body: { type: 'FeatureCollection', features: [] } },
    })

    expect(table.hidden).toBe(true)
    expect(status.dataset.state).toBe('error')
    expect(status.textContent).toContain('in time')
  })

  // The deadline stays armed through json(), so a response whose headers
  // arrive and whose body then stops mid-stream is caught too -- stalling only
  // the fetch would leave that path uncovered.
  it('gives up on a response whose body never finishes', async () => {
    const { status, table } = await render('stall-body', {
      timeoutMs: 20,
      own: { body: { type: 'FeatureCollection', features: [] } },
    })

    expect(table.hidden).toBe(true)
    expect(status.dataset.state).toBe('error')
    expect(status.textContent).toContain('in time')
  })

  // A month of AIS traffic can keep a busy store for many seconds, while the
  // own vessel alone answers at once.
  it('shows the own vessel while the others load, and keeps it if they never answer', async () => {
    const own = feature({
      context: SELF,
      isSelf: true,
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-01T02:00:00Z',
      pointCount: 12,
    })
    const { status, tbody, table, shown } = await render('stall', {
      timeoutMs: 50,
      own: { body: { type: 'FeatureCollection', features: [own] } },
    })

    expect(table.hidden).toBe(false)
    expect(tbody.children.map((tr) => tr.children[0]!.textContent)).toEqual(['Own Ship'])
    expect(shown.some((text) => text.startsWith('Loading the other vessels…'))).toBe(true)
    expect(status.dataset.state).toBe('error')
    expect(status.textContent).toContain('in time')
  })

  // A body still on the way is not an answer yet: the own vessel shows while
  // it comes, and stays if it never does.
  it('shows the own vessel while the list’s body is still on the way', async () => {
    const own = feature({
      context: SELF,
      isSelf: true,
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-01T02:00:00Z',
      pointCount: 12,
    })
    const { tbody, table, status } = await render('stall-body', {
      timeoutMs: 80,
      own: { body: { type: 'FeatureCollection', features: [own] } },
    })

    expect(table.hidden).toBe(false)
    expect(tbody.children.map((tr) => tr.children[0]!.textContent)).toEqual(['Own Ship'])
    expect(status.textContent).toContain('in time')
  })

  // The own vessel's request reads its whole recording, which reaches back
  // further than the list's window.
  it('keeps the own vessel’s whole recording when the list’s window has none of it', async () => {
    const own = feature({
      context: SELF,
      isSelf: true,
      from: '2024-09-01T00:00:00Z',
      to: '2024-09-01T02:00:00Z',
      pointCount: 12,
    })
    const { lists, shown } = await render(
      { body: { type: 'FeatureCollection', features: [] } },
      { own: { body: { type: 'FeatureCollection', features: [own] } } },
    )

    expect(shown.some((text) => text.startsWith('Loading the other vessels…'))).toBe(true)
    expect(lists.own.tbody.children.map((tr) => tr.children[0]!.textContent)).toEqual(['Own Ship'])
    expect(lists.own.note.textContent).toBe('Its whole recording.')
  })

  // The list's window of the own vessel is left out for its whole recording,
  // not shown beside it.
  it('shows the own vessel once', async () => {
    const own = (from: string, pointCount: number) =>
      feature({
        id: 'tracks:recorded:self',
        providerId: 'tracks',
        context: SELF,
        isSelf: true,
        from,
        to: '2026-09-01T02:00:00Z',
        pointCount,
      })
    const { lists } = await render(
      { body: { type: 'FeatureCollection', features: [own('2026-08-02T00:00:00Z', 12)] } },
      { own: { body: { type: 'FeatureCollection', features: [own('2024-01-01T00:00:00Z', 4321)] } } },
    )

    expect(lists.own.tbody.children.map((tr) => tr.children[3]!.textContent)).toEqual(['4321'])
  })

  // Without its own request, the own vessel's row is the list's window of
  // it, and the note says so rather than call it the whole recording.
  it.each([
    [true, 'In the last 30 days.'],
    [false, 'None in the last 30 days.'],
  ])('says the own vessel’s row is the list’s window when its own request fails (%s)', async (any, note) => {
    const { lists } = await render(
      {
        body: {
          type: 'FeatureCollection',
          features: any ? [feature({ context: SELF, isSelf: true, to: '2026-09-01T02:00:00Z', pointCount: 12 })] : [],
        },
      },
      { own: new Error('offline') },
    )

    expect(lists.own.note.textContent).toBe(note)
  })

  // Two providers can give a vessel's recording the same id after their prefix.
  it('lists the same track id from two providers twice', async () => {
    const recorded = (providerId: string) =>
      feature({
        id: `${providerId}:recorded:${OTHER}`,
        providerId,
        context: OTHER,
        isSelf: false,
        to: '2026-09-01T02:00:00Z',
        pointCount: 3,
      })
    const { lists } = await render({
      body: { type: 'FeatureCollection', features: [recorded('tracks'), recorded('history')] },
    })

    expect(lists.others.tbody.children).toHaveLength(2)
  })

  it('still lists every vessel when the own vessel’s request fails', async () => {
    const { tbody, table, status, shown } = await render(
      {
        body: {
          type: 'FeatureCollection',
          features: [
            feature({ context: SELF, isSelf: true, to: '2026-09-01T02:00:00Z', pointCount: 12 }),
            feature({
              context: OTHER,
              contextName: 'Ariadne',
              isSelf: false,
              to: '2026-09-02T01:00:00Z',
              pointCount: 7,
            }),
          ],
        },
      },
      { own: new Error('offline') },
    )

    expect(shown.some((text) => text.startsWith('Loading the other vessels…'))).toBe(false)
    expect(table.hidden).toBe(false)
    // The list's window of the own vessel stands in for its whole recording.
    expect(tbody.children).toHaveLength(2)
    expect(status.textContent).toBe('')
  })

  it('counts the wait up rather than sitting on Loading…', async () => {
    const { status, shown } = await render('stall', { timeoutMs: 1300 })

    // How many seconds a slow runner has counted by then is its own business.
    expect(shown.some((text) => /^Loading… \d+ s$/.test(text))).toBe(true)
    expect(status.attributes['aria-busy']).toBe('false')
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
    const { status, table, lists } = await render({
      body: { type: 'FeatureCollection', features: [null, { type: 'Feature' }] },
    })

    expect(table.hidden).toBe(true)
    expect(status.dataset.state).toBeUndefined()
    expect(lists.own.note.textContent).toBe('Nothing recorded yet.')
    expect(lists.others.note.textContent).toBe('None in the last 30 days.')
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

  // The export link goes to the *v1* route, whose duration is a number with a
  // unit suffix -- not the ISO 8601 form the v2 listing takes. Sharing one
  // constant between them sent `P30D` here and made every download a 400.
  // Users are told to keep this export before deleting anything, so it is
  // the whole recording, which the route writes a day at a time.
  it('exports the own vessel’s whole recording', async () => {
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

    const href = tbody.children[0]!.children[4]!.children[0]!.href!
    expect(new URL(href, 'http://localhost/').searchParams.has('duration')).toBe(false)
  })

  it('asks the export route for a duration it can parse', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [feature({ context: OTHER, isSelf: false, to: '2026-09-01T02:00:00Z', pointCount: 2 })],
      },
    })

    const link = tbody.children[0]!.children[4]!.children[0]!
    const duration = new URL(link.href!, 'http://localhost/').searchParams.get('duration')

    expect(duration).toBeTruthy()
    // Parsed by the route's own parser rather than pattern-matched, so this
    // keeps holding if the accepted spelling ever changes.
    expect(() => parseDuration(duration!)).not.toThrow()
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

  // Even when the import names a vessel: the vessel's recording is a
  // different track from the one on this row.
  it('exports an import as it was imported', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            id: 'tracks:imported:a b',
            providerId: 'tracks',
            context: SELF,
            isSelf: true,
            name: 'Race day',
            pointCount: 2,
          }),
        ],
      },
    })

    const link = tbody.children[0]!.children[4]!.children[0]!
    expect(link.href).toBe('../../plugins/tracks/imports/imported%3Aa%20b/track.gpx')
  })

  it('does not send another provider’s import to this plugin', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            id: 'other:imported:a',
            providerId: 'other',
            context: OTHER,
            isSelf: false,
            name: 'Race day',
            pointCount: 2,
          }),
        ],
      },
    })

    expect(tbody.children[0]!.children[4]!.children).toHaveLength(0)
  })

  it('exports an import the API names without its provider', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [feature({ id: 'imported:a', context: OTHER, isSelf: false, name: 'Race day', pointCount: 2 })],
      },
    })

    const link = tbody.children[0]!.children[4]!.children[0]!
    expect(link.href).toBe('../../plugins/tracks/imports/imported%3Aa/track.gpx')
  })

  // The list shows a bounded window, and the export must not quietly differ
  // from what the row says it contains.
  it('exports another vessel over the window its list shows', async () => {
    const { tbody, requested } = await render(
      {
        body: {
          type: 'FeatureCollection',
          features: [feature({ context: OTHER, isSelf: false, to: '2026-09-01T02:00:00Z', pointCount: 2 })],
        },
      },
      { settings: { aisRetentionDays: 7 } },
    )

    // Compared as a length of time rather than as a string: the two routes
    // spell a duration differently, and asserting the literal here is what
    // pinned the v2 spelling onto the v1 export route.
    const href = tbody.children[0]!.children[4]!.children[0]!.href!
    const exported = parseDuration(new URL(href, 'http://localhost/').searchParams.get('duration')!)
    const listed = requested
      .map((url) => new URL(url, 'http://localhost/').searchParams)
      .find((params) => !params.has('contexts'))!
      .get('duration')

    expect(listed).toBe('P7D')
    expect(exported).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

// The list reaches back 30 days through the Track API, which an old passage
// or an untimed track never matches; an imported file must still be findable.
describe('the webapp lists every import', () => {
  const old = {
    id: 'tracks:imported:old',
    providerId: 'tracks',
    name: 'Passage 2019',
    from: '2019-06-01T00:00:00Z',
    to: '2019-06-02T00:00:00Z',
    pointCount: 40,
  }

  it('adds an import the window misses', async () => {
    const { lists } = await render(
      {
        body: {
          type: 'FeatureCollection',
          features: [feature({ context: SELF, isSelf: true, to: '2026-09-01T00:00:00Z', pointCount: 2 })],
        },
      },
      { imports: [old] },
    )
    expect(lists.own.tbody.children).toHaveLength(1)
    expect(lists.imported.tbody.children.map((tr) => tr.children[0]!.textContent)).toEqual(['No vessel'])
  })

  it('lists an import the window also returned once', async () => {
    const recent = { ...old, from: '2026-09-01T00:00:00Z', to: '2026-09-01T01:00:00Z' }
    const { tbody, lists } = await render(
      { body: { type: 'FeatureCollection', features: [feature(recent)] } },
      { imports: [recent] },
    )
    expect(tbody.children).toHaveLength(1)
    expect(lists.imported.tbody.children).toHaveLength(1)
  })

  // A server without the Track API's write routes names a track without its
  // provider; the same import must still be listed once.
  it('lists an import once when the API names it without its provider', async () => {
    const recent = { ...old, from: '2026-09-01T00:00:00Z', to: '2026-09-01T01:00:00Z' }
    const { tbody } = await render(
      {
        body: {
          type: 'FeatureCollection',
          features: [feature({ ...recent, id: 'imported:old', providerId: undefined })],
        },
      },
      { imports: [recent] },
    )
    expect(tbody.children).toHaveLength(1)
  })

  // The v1 route exports a vessel's recording, which an import is not part of.
  it('exports an import that names a vessel as it was imported', async () => {
    const { tbody } = await render(
      { body: { type: 'FeatureCollection', features: [] } },
      { imports: [{ ...old, context: SELF, isSelf: true }] },
    )
    const link = tbody.children[0]!.children[4]!.children[0]!
    expect(link.href).toBe('../../plugins/tracks/imports/imported%3Aold/track.gpx')
  })

  // A server that names tracks without their provider cannot delete by id.
  it('offers no delete for an import on a server that names tracks without their provider', async () => {
    const { tbody } = await render(
      {
        body: {
          type: 'FeatureCollection',
          features: [
            feature({ id: `recorded:${SELF}`, context: SELF, isSelf: true, to: '2026-09-01T00:00:00Z', pointCount: 2 }),
          ],
        },
      },
      { imports: [old] },
    )
    expect(tbody.children[1]!.children.at(-1)!.children).toHaveLength(0)
  })

  // A provider id alone does not show the server names tracks by it.
  it('offers no delete for an import when listed ids carry no provider prefix', async () => {
    const { tbody } = await render(
      {
        body: {
          type: 'FeatureCollection',
          features: [
            feature({
              id: `recorded:${SELF}`,
              providerId: 'tracks',
              context: SELF,
              isSelf: true,
              to: '2026-09-01T00:00:00Z',
              pointCount: 2,
            }),
          ],
        },
      },
      { imports: [old] },
    )
    expect(tbody.children[1]!.children.at(-1)!.children).toHaveLength(0)
  })

  it('offers delete for an import on a server that names tracks by provider', async () => {
    const { tbody } = await render(
      {
        body: {
          type: 'FeatureCollection',
          features: [
            feature({
              id: `tracks:recorded:${SELF}`,
              providerId: 'tracks',
              context: SELF,
              isSelf: true,
              to: '2026-09-01T00:00:00Z',
              pointCount: 2,
            }),
          ],
        },
      },
      { imports: [old] },
    )
    expect(tbody.children[1]!.children.at(-1)!.children[0]!.textContent).toBe('Delete…')
  })

  // With nothing listed, the server is asked for one import by its full name.
  it('asks whether the server deletes by id when the window has nothing', async () => {
    const deletable = async (byId: boolean) => {
      const { tbody } = await render({ body: { type: 'FeatureCollection', features: [] } }, { imports: [old], byId })
      return tbody.children[0]!.children.at(-1)!.children.length
    }
    expect(await deletable(true)).toBe(1)
    expect(await deletable(false)).toBe(0)
  })

  it('shows an old import when the window has nothing', async () => {
    const { tbody } = await render({ body: { type: 'FeatureCollection', features: [] } }, { imports: [old] })
    expect(tbody.children).toHaveLength(1)
  })
})

describe('the webapp offers to delete a track', () => {
  const deleteButton = async (properties: Record<string, unknown>) => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [
          feature({
            context: OTHER,
            isSelf: false,
            from: '2026-09-01T00:00:00Z',
            to: '2026-09-01T01:00:00Z',
            pointCount: 2,
            ...properties,
          }),
        ],
      },
    })
    return tbody.children[0]!.children.at(-1)!.children[0]
  }

  it('for a track the API gave an id', async () => {
    expect((await deleteButton({ id: `tracks:recorded:${OTHER}`, providerId: 'tracks' }))?.textContent).toBe('Delete…')
  })

  // A server that predates `providerId:trackId` ids also predates deleting by them.
  it('not for a track without an id the server can route', async () => {
    expect(await deleteButton({})).toBeUndefined()
    expect(await deleteButton({ id: `recorded:${OTHER}`, providerId: 'tracks' })).toBeUndefined()
    expect(await deleteButton({ id: `tracks:recorded:${OTHER}` })).toBeUndefined()
  })

  it('tells an import from the vessel’s recording', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [feature({ context: OTHER, isSelf: false, name: 'Race day', pointCount: 2 })],
      },
    })
    const name = tbody.children[0]!.children[0]!
    expect(name.textContent).toBe('AIS 987654321')
    expect(name.children[0]!.textContent).toBe(' (imported: Race day)')
  })

  // An import may name no vessel. Listing it is the only way to reach it from
  // the page, to export or delete it.
  it('lists an import that names no vessel', async () => {
    const { tbody } = await render({
      body: {
        type: 'FeatureCollection',
        features: [feature({ id: 'tracks:imported:a', providerId: 'tracks', name: 'Race day', pointCount: 2 })],
      },
    })
    const cells = tbody.children[0]!.children
    expect(cells[0]!.textContent).toBe('No vessel')
    expect(cells.at(-2)!.children[0]!.textContent).toBe('GPX')
    expect(cells.at(-1)!.children[0]!.textContent).toBe('Delete…')
  })
})

describe('the recycle bin page', () => {
  it('labels a track as tracks.js and the server do', () => {
    for (const properties of [
      { context: SELF, isSelf: true },
      { context: OTHER, contextName: 'Ariadne', isSelf: false },
      { context: OTHER, isSelf: false },
    ]) {
      const lookup = (path: string) =>
        properties.contextName !== undefined && path === `${properties.context}.name`
          ? properties.contextName
          : undefined
      expect(binLabel(properties)).toBe(
        trackLabel(properties.context, properties.isSelf ? properties.context : SELF, lookup),
      )
    }
    expect(binLabel({ isSelf: false })).toBe('No vessel')
  })

  it('says what part was deleted', () => {
    expect(deletedPart({ whole: true })).toBe('The whole track')
    expect(deletedPart({ whole: false, to: '2026-09-01T00:00:00Z' })).toMatch(/^Everything up to /)
    expect(deletedPart({ whole: false, from: '2026-09-01T00:00:00Z' })).toMatch(/^Everything from /)
  })

  it('reaches the end of the second a span ends in, and refuses an empty span', () => {
    const query = new URLSearchParams(spanQuery('2026-09-01T10:00:00', '2026-09-01T11:00:00').slice(1))
    const from = Date.parse(query.get('from')!)
    expect(Date.parse(query.get('to')!) - from).toBe(60 * 60 * 1000 + 999)
    expect(spanQuery('', '')).toBeUndefined()
    expect(new URLSearchParams(spanQuery('', '2026-09-01T11:00:00').slice(1)).has('from')).toBe(false)
  })

  it('fills the inputs in the viewer’s zone, to the second', () => {
    const iso = '2026-09-01T10:20:30.400Z'
    expect(new Date(localInput(iso)).getTime()).toBe(Date.parse('2026-09-01T10:20:30Z'))
    expect(localInput('not a time')).toBe('')
  })

  it('asks for an administrator when refused', () => {
    expect(refusal(401)).toMatch(/administrator/)
    expect(refusal(403)).toMatch(/administrator/)
    expect(refusal(501)).toMatch(/cannot/)
  })
})

describe('the import form', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says how many tracks it imported, and any points it left out', () => {
    expect(imported({ ids: ['a'], skippedPoints: 0 })).toBe('Imported 1 track.')
    expect(imported({ ids: ['a', 'b'], skippedPoints: 3 })).toBe('Imported 2 tracks. 3 points without a time left out.')
    expect(imported({ ids: ['a'], skippedPoints: 0, overlappingPoints: 1 })).toBe(
      'Imported 1 track. 1 point left out where your vessel already has a track.',
    )
  })

  it('asks to replace a recording only for the own vessel', () => {
    expect(importQuery({ self: false, replace: true })).toBe('')
    expect(importQuery({ self: true, replace: false })).toBe('?self=true')
    expect(importQuery({ self: true, replace: true })).toBe('?self=true&onOverlap=replace')
  })

  it('offers to replace a recording only while the own vessel is chosen', () => {
    let changed = () => {}
    const self = {
      checked: false,
      addEventListener: (_type: string, handler: () => void) => {
        changed = handler
      },
    }
    const replace = { checked: false, disabled: false }
    const form = { elements: { self, replace }, querySelector: () => ({}), addEventListener: () => {} }
    vi.stubGlobal('document', { getElementById: (id: string) => (id === 'import-form' ? form : {}) })
    startImport()
    expect(replace.disabled).toBe(true)
    self.checked = true
    changed()
    expect(replace.disabled).toBe(false)
  })

  // Each upload stores the file anew, so a second submit would import it twice.
  it('sends one upload at a time, and allows another after a failure', async () => {
    const button = { disabled: false }
    const status = { textContent: '', hidden: true, dataset: {} as Record<string, string> }
    let submit: (event: { preventDefault: () => void }) => Promise<void> = async () => {}
    const form = {
      elements: {
        file: { files: [{ name: 'a.gpx' }] },
        self: { checked: false, addEventListener: () => {} },
        replace: { checked: false, disabled: false },
      },
      querySelector: () => button,
      addEventListener: (_type: string, handler: typeof submit) => {
        submit = handler
      },
    }
    let answer: (response: unknown) => void = () => {}
    const fetch = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    vi.stubGlobal('document', { getElementById: (id: string) => (id === 'import-form' ? form : status) })
    vi.stubGlobal('fetch', fetch)
    startImport()

    const event = { preventDefault: () => {} }
    const first = submit(event)
    await submit(event)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)

    answer({ ok: false, status: 400, json: () => Promise.resolve({ message: 'No track found' }) })
    await first
    expect(status.textContent).toBe('No track found')
    expect(button.disabled).toBe(false)
  })
})

describe('the history import section', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const running = {
    running: true,
    startedAt: '2026-06-11T00:00:00.000Z',
    firstDay: '2026-06-01T00:00:00.000Z',
    nextDay: '2026-06-05T00:00:00.000Z',
    filled: 1234,
  }

  it('offers an import only where a history provider is installed', () => {
    expect(historyView({ provider: false })).toBeUndefined()
    expect(historyView({ provider: true })).toEqual({ text: 'Not imported yet.', button: 'Import' })
  })

  it('says how far a running import got, and offers nothing meanwhile', () => {
    // West of UTC, where the UTC day the import got to begins the day before.
    const zone = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const view = historyView({ provider: true, state: running })
      const day = new Date(running.nextDay).toLocaleDateString(undefined, { timeZone: 'UTC' })
      expect(day).not.toBe(new Date(running.nextDay).toLocaleDateString())
      expect(view.text).toBe(`Importing: 40% done, up to ${day}. 1234 positions filled so far.`)
      expect(view.button).toBeUndefined()
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
    expect(historyView({ provider: true, state: { running: true, startedAt: running.startedAt, filled: 0 } })).toEqual({
      text: 'Importing: finding where the history begins…',
    })
  })

  it('offers to resume an import that stopped, and to import again once it finished', () => {
    const stopped = { ...running, running: false }
    const failed = historyView({ provider: true, state: { ...stopped, error: 'provider unavailable' } })
    expect(failed.text).toMatch(/^The import stopped at .+: provider unavailable\. 1234 positions filled\.$/)
    expect(failed).toMatchObject({ button: 'Resume', state: 'error' })
    expect(historyView({ provider: true, state: stopped }).button).toBe('Resume')
    const done = historyView({ provider: true, state: { ...stopped, finishedAt: '2026-06-11T01:00:00.000Z' } })
    expect(done.text).toMatch(/^Imported on .+: 1234 positions filled\.$/)
    expect(done.button).toBe('Import again')
    // Shown, but with nothing to read from there is nothing to offer.
    expect(
      historyView({ provider: false, state: { ...stopped, finishedAt: running.startedAt } }).button,
    ).toBeUndefined()
    expect(historyView({ provider: false, state: stopped }).button).toBeUndefined()
  })

  /** The section's elements, as stubs the script writes to. */
  const page = () => {
    let click: () => Promise<void> = async () => {}
    const section = { hidden: true }
    const status = { textContent: '', dataset: {} as Record<string, string> }
    const button = {
      hidden: true,
      textContent: '',
      disabled: false,
      addEventListener: (_type: string, handler: () => Promise<void>) => {
        click = handler
      },
    }
    const elements: Record<string, unknown> = { history: section, 'history-status': status, 'history-start': button }
    vi.stubGlobal('document', { getElementById: (id: string) => elements[id] })
    return { section, status, button, click: () => click() }
  }
  const answer = (status: number, body: unknown) => ({ ok: status < 300, status, json: () => Promise.resolve(body) })

  it('stays hidden from anyone but an administrator', async () => {
    const { section } = page()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(answer(401, { message: 'Unauthorized' }))),
    )
    await startHistory()
    expect(section.hidden).toBe(true)
  })

  it('starts the import, and follows it until it finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { section, status, button, click } = page()
    const answers = [
      answer(200, { provider: true }),
      answer(202, { state: { ...running, nextDay: running.firstDay, filled: 0 } }),
      answer(200, { provider: true, state: running }),
      answer(200, { provider: true, state: { ...running, running: false, finishedAt: running.startedAt } }),
    ]
    const fetch = vi.fn<(url: string, init?: { method?: string }) => Promise<unknown>>(() =>
      Promise.resolve(answers.shift()),
    )
    vi.stubGlobal('fetch', fetch)
    await startHistory()
    expect(section.hidden).toBe(false)
    expect(button).toMatchObject({ hidden: false, textContent: 'Import' })

    await click()
    expect(fetch.mock.calls[1]![1]?.method).toBe('POST')
    expect(status.textContent).toMatch(/^Importing: 40% done/)
    expect(button.hidden).toBe(true)

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(status.textContent).toMatch(/^Imported on /)
    expect(button).toMatchObject({ hidden: false, textContent: 'Import again' })
    await vi.advanceTimersByTimeAsync(10 * POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  // Between stop() and the next start() the route answers 404, as on a
  // config save; the progress shown must not freeze there.
  it('keeps following an import across a refused or unreadable answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { status } = page()
    const answers = [
      answer(200, { provider: true, state: running }),
      answer(404, { message: 'Tracks API not available because tracks plugin is not enabled' }),
      // A body that does not read, as a proxy's error page would be.
      { ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token <')) },
      answer(200, { provider: true, state: { ...running, running: false, finishedAt: running.startedAt } }),
    ]
    const fetch = vi.fn(() => Promise.resolve(answers.shift()))
    vi.stubGlobal('fetch', fetch)
    await startHistory()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(status.textContent).toMatch(/^Imported on /)
  })

  it('says why a start was refused, and allows another', async () => {
    const { status, button, click } = page()
    const answers = [
      answer(200, { provider: true }),
      answer(409, { message: 'No history provider is installed to import from' }),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(answers.shift())),
    )
    await startHistory()
    await click()
    expect(status).toMatchObject({
      textContent: 'No history provider is installed to import from',
      dataset: { state: 'error' },
    })
    expect(button.disabled).toBe(false)
  })
})

// Nothing it deletes comes back, so the button waits for the word, and a
// refusal says why rather than looking like nothing happened.
describe('the danger zone', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('takes DELETE, and nothing else, as confirming', () => {
    expect(confirmed('DELETE')).toBe(true)
    expect(confirmed(' DELETE ')).toBe(true)
    expect(confirmed('delete')).toBe(false)
    expect(confirmed('')).toBe(false)
  })

  it('deletes only once the word is typed, says why it was refused, and reloads once done', async () => {
    const handlers: Record<string, (event?: unknown) => unknown> = {}
    const on = (name: string) => (_type: string, handler: (event?: unknown) => unknown) => {
      handlers[name] = handler
    }
    const button = { disabled: true }
    const confirm = { value: '', addEventListener: on('input') }
    const form = { elements: { confirm }, querySelector: () => button, addEventListener: on('submit') }
    const dialog = { querySelector: () => form, showModal: vi.fn(), close: vi.fn() }
    const error = { textContent: '', hidden: true }
    const elements: Record<string, unknown> = {
      'reset-open': { addEventListener: on('click') },
      'reset-dialog': dialog,
      'reset-error': error,
    }
    const answers = [
      { ok: false, status: 403, json: () => Promise.reject(new Error('not JSON')) },
      { ok: true, status: 200, json: () => Promise.resolve({ deleted: true }) },
    ]
    const fetch = vi.fn(() => Promise.resolve(answers.shift()))
    const reload = vi.fn()
    vi.stubGlobal('document', { getElementById: (id: string) => elements[id] })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('location', { reload })
    startDanger()

    handlers.click!()
    expect(dialog.showModal).toHaveBeenCalled()
    for (const typed of ['delete', 'DELET']) {
      confirm.value = typed
      handlers.input!()
      expect(button.disabled).toBe(true)
    }
    confirm.value = 'DELETE'
    handlers.input!()
    expect(button.disabled).toBe(false)

    const submit = () => handlers.submit!({ submitter: { value: 'reset' }, preventDefault: () => {} })
    await submit()
    expect(fetch).toHaveBeenCalledWith(
      '../../plugins/tracks/database?confirm=DELETE',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(error.textContent).toBe('This needs an administrator login.')
    expect(error.hidden).toBe(false)
    expect(button.disabled).toBe(false)
    expect(reload).not.toHaveBeenCalled()

    await submit()
    expect(dialog.close).toHaveBeenCalled()
    expect(reload).toHaveBeenCalled()
  })
})
