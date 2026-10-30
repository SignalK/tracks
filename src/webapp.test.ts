import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toGpx } from './gpx.js'
import { trackLabel } from './utils.js'
import { parseDuration } from './timeWindow.js'
// @ts-expect-error -- plain JavaScript shipped as-is, with no declarations
import { deletedPart, label as binLabel, localInput, refusal, spanQuery } from '../public/bin.js'
// @ts-expect-error -- plain JavaScript shipped as-is, with no declarations
import { imported, progress, start as startImport, trackChoice, uploaded } from '../public/import.js'
// @ts-expect-error -- plain JavaScript shipped as-is, with no declarations
import { fingerprintOf, scanGpx, SLICE_BYTES, uploadGpx } from '../public/upload.js'
import { GpxReader } from './gpxUpload.js'
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

  // The notes say how long other vessels are kept, and whether they are
  // recorded, as the plugin is set, so the list never reads as though it kept
  // them longer, or as though the receiver had heard no one.
  it.each([
    [{ aisRetentionDays: 7 }, true, 'In the last 7 days. The plugin keeps them 7 days.'],
    [{ aisRetentionDays: 1 }, false, 'None in the last 1 day. The plugin keeps them 1 day.'],
    [{ aisRetentionDays: 0 }, true, 'In the last 30 days. The plugin keeps them indefinitely.'],
    [
      { aisRetentionDays: 7, recordOtherVessels: false },
      false,
      "None in the last 7 days. The plugin keeps them 7 days. Recording them is turned off in the plugin's settings.",
    ],
    [
      { aisRetentionDays: 7, recordOtherVessels: false },
      true,
      "In the last 7 days. The plugin keeps them 7 days. Recording them is turned off in the plugin's settings.",
    ],
    [{ aisRetentionDays: 7, recordOtherVessels: true }, true, 'In the last 7 days. The plugin keeps them 7 days.'],
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

  it('says what an upload into the own recording came to, and how far one got', () => {
    expect(uploaded({ imported: 1200, overlapping: 0, untimed: 0 })).toBe(
      `Imported ${(1200).toLocaleString()} points into your vessel's track.`,
    )
    expect(uploaded({ imported: 1, overlapping: 2, untimed: 3 })).toBe(
      "Imported 1 point into your vessel's track. 3 points without a time left out. " +
        '2 points left out where your vessel already has a track.',
    )
    expect(progress({ received: 512 * 1024 * 1024, size: 1024 * 1024 * 1024 })).toBe('Importing: 50%, 512 of 1024 MB.')
  })

  it('offers a file’s tracks with times, and proposes those not named like an AIS target', () => {
    const from = '2023-08-29T21:57:38Z'
    expect(trackChoice({ name: 'Own', points: 2, from, to: '2023-09-02T10:00:00Z' })).toEqual({
      name: 'Own',
      label: 'Own: 2 points, 2023-08-29 to 2023-09-02',
      disabled: false,
      checked: true,
    })
    expect(trackChoice({ name: 'AIS Ariadne', points: 1, from, to: from })).toMatchObject({
      label: 'AIS Ariadne: 1 point, 2023-08-29',
      checked: false,
    })
    expect(trackChoice({ name: '987654321', points: 1, from, to: from })).toMatchObject({ checked: false })
    expect(trackChoice({ name: '', points: 3 })).toEqual({
      name: '',
      label: '(no name): 3 points, no times',
      disabled: true,
      checked: false,
    })
  })

  it('proposes no track plainly another vessel’s, and says what was seen of the others', () => {
    const from = '2023-08-29T21:57:38Z'
    const to = '2023-08-30T08:00:00Z'
    expect(trackChoice({ name: 'Passage', points: 40000, from, to, elsewhere: 'Own Ship', foreign: true })).toEqual({
      name: 'Passage',
      label: `Passage: ${(40000).toLocaleString()} points, 2023-08-29 to 2023-08-30, elsewhere than Own Ship at the same time`,
      disabled: false,
      checked: false,
    })
    expect(trackChoice({ name: '', points: 2, from, to, elsewhere: 'Eigenes Schiff' })).toMatchObject({
      label: expect.stringMatching(/^\(no name\): .*, elsewhere than Eigenes Schiff at the same time$/),
      checked: true,
    })
    expect(trackChoice({ name: 'Log', points: 2, from, to, elsewhere: 'Own Ship', partly: true })).toMatchObject({
      label: expect.stringMatching(/, partly elsewhere than Own Ship at the same time$/),
      checked: true,
    })
  })

  /** Stand-ins for the form's elements, enough for start() to wire up. */
  const formStub = (over: { self?: object; file?: object } = {}) => {
    const listening = () => ({ addEventListener: () => {} })
    const self = { checked: false, ...listening(), ...over.self }
    const replace = { checked: false, disabled: false }
    const button = { disabled: false }
    const status = { textContent: '', hidden: true, dataset: {} as Record<string, string> }
    let submit: (event: { preventDefault: () => void }) => Promise<void> = async () => {}
    const form = {
      elements: { file: { files: [], ...listening(), ...over.file }, self, replace },
      querySelector: () => button,
      addEventListener: (_type: string, handler: typeof submit) => {
        submit = handler
      },
    }
    const elements: Record<string, unknown> = {
      'import-form': form,
      'import-status': status,
      'import-tracks': { hidden: true, replaceChildren: () => {}, ...listening() },
      'import-stop': { hidden: true, ...listening() },
    }
    vi.stubGlobal('document', { getElementById: (id: string) => elements[id] })
    return { self, replace, button, status, submit: (event: { preventDefault: () => void }) => submit(event) }
  }

  it('offers to replace a recording only while the own vessel is chosen', () => {
    const handlers: (() => void)[] = []
    const { self, replace } = formStub({
      self: {
        addEventListener: (_type: string, handler: () => void) => {
          handlers.push(handler)
        },
      },
    })
    startImport()
    expect(replace.disabled).toBe(true)
    self.checked = true
    for (const handler of handlers) handler()
    expect(replace.disabled).toBe(false)
  })

  it('refuses a file of another vessel too large for one request, before sending any of it', async () => {
    const { status, submit } = formStub({ file: { files: [{ name: 'big.gpx', size: 25 * 1024 * 1024 + 1 }] } })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    startImport()
    await submit({ preventDefault: () => {} })
    expect(fetch).not.toHaveBeenCalled()
    expect(status.textContent).toMatch(/at most 25 MB/)
  })

  // Each upload stores the file anew, so a second submit would import it twice.
  it('sends one upload at a time, and allows another after a failure', async () => {
    const { button, status, submit } = formStub({ file: { files: [{ name: 'a.gpx', size: 100 }] } })
    let answer: (response: unknown) => void = () => {}
    const fetch = vi.fn(() => new Promise((resolve) => (answer = resolve)))
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

describe('a GPX file uploaded in slices', () => {
  const GPX = 'http://www.topografix.com/GPX/1/1'
  const trkpt = (time?: string) => `<trkpt lat="1" lon="2">${time === undefined ? '' : `<time>${time}</time>`}</trkpt>`
  const xml = [
    `<?xml version="1.0"?><gpx version="1.1" xmlns="${GPX}">`,
    `<trk><name> Ström &amp; Söhne ⛵ </name><extensions><name>vendor</name></extensions>`,
    `<trkseg>${trkpt('2023-08-29T21:57:38Z')}${trkpt('2023-08-30T08:00:00Z')}</trkseg></trk>`,
    `<trk><name>AIS Ariadne</name><trkseg>${trkpt('2023-08-29T22:00:00Z')}</trkseg></trk>`,
    `<trk><trkseg>${trkpt()}<trkpt lat="3" lon="4"/></trkseg><name>late</name></trk>`,
    `<trk><name>AIS Ariadne</name><trkseg>${trkpt('2023-08-31T00:00:00Z')}</trkseg></trk>`,
    '</gpx>',
  ].join('\n')
  const file = new Blob([xml])

  it.each([7, 64, 1 << 20])('lists the tracks by name, in chunks of %i bytes', async (chunk) => {
    expect(await scanGpx(file, () => {}, chunk)).toEqual([
      { name: 'Ström & Söhne ⛵', points: 2, from: '2023-08-29T21:57:38Z', to: '2023-08-30T08:00:00Z' },
      { name: 'AIS Ariadne', points: 2, from: '2023-08-29T22:00:00Z', to: '2023-08-31T00:00:00Z' },
      { name: '', points: 2 },
    ])
  })

  // The server chooses tracks by name; a name spelled differently here would import nothing.
  it('names the tracks as the server reads them', async () => {
    const names = (await scanGpx(file)).map(({ name }: { name: string }) => name)
    const read = await new GpxReader(new Set(names), { offset: 0, open: [], segments: 0 }).read(
      new TextEncoder().encode(xml),
      true,
    )
    expect(read.error).toBeUndefined()
    expect([...read.parts.keys()]).toEqual([1, 2, 4])
    expect(read.untimed).toBe(2)
  })

  it('reads a name in CDATA, beside references and a comment, as the server does', async () => {
    const cdata = `<gpx xmlns="${GPX}"><trk><name> <![CDATA[Own &amp; <Co>]]> &amp;<!-- not this --> Ship </name><trkseg>${trkpt('2023-08-29T21:57:38Z')}</trkseg></trk></gpx>`
    const names = (await scanGpx(new Blob([cdata]))).map(({ name }: { name: string }) => name)
    expect(names).toEqual(['Own &amp; <Co> & Ship'])
    // Cut inside the CDATA section and the comment as well.
    expect(await scanGpx(new Blob([cdata]), () => {}, 7)).toEqual(await scanGpx(new Blob([cdata])))
    const read = await new GpxReader(new Set(names), { offset: 0, open: [], segments: 0 }).read(
      new TextEncoder().encode(cdata),
      true,
    )
    expect([...read.parts.keys()]).toEqual([1])
  })

  it('reads a name across a Windows line end as the server does', async () => {
    const crlf = `<gpx xmlns="${GPX}"><trk><name>Leg\r\n2</name><trkseg>${trkpt('2023-08-29T21:57:38Z')}</trkseg></trk></gpx>`
    const names = (await scanGpx(new Blob([crlf]))).map(({ name }: { name: string }) => name)
    expect(names).toEqual(['Leg\n2'])
    const read = await new GpxReader(new Set(names), { offset: 0, open: [], segments: 0 }).read(
      new TextEncoder().encode(crlf),
      true,
    )
    expect([...read.parts.keys()]).toEqual([1])
  })

  const at = (lat: number | string, lon: number | string, time: string) =>
    `<trkpt lat="${lat}" lon="${lon}"><time>${time}</time></trkpt>`
  const track = (name: string, points: string[]) => `<trk><name>${name}</name><trkseg>${points.join('')}</trkseg></trk>`
  const gpxBy = (creator: string | undefined, ...tracks: string[]) =>
    new Blob([
      [
        `<?xml version="1.0"?><gpx version="1.1"${creator === undefined ? '' : ` creator="${creator}"`} xmlns="${GPX}">`,
        ...tracks,
        '</gpx>',
      ].join('\n'),
    ])
  // As TimeZero writes one: naming no creator.
  const gpxOf = (...tracks: string[]) => gpxBy(undefined, ...tracks)
  /** Steps of ten minutes from midnight UTC on 2023-03-01, and minutes on from there. */
  const msOf = (step: number, minutes = 0) => Date.UTC(2023, 2, 1) + (step * 10 + minutes) * 60_000
  const utc = (step: number, minutes = 0) => new Date(msOf(step, minutes)).toISOString().replace('.000Z', 'Z')
  /** The same instant written with an offset of two hours, or with no zone at all. */
  const offset = (step: number) => `${new Date(msOf(step) + 2 * 3_600_000).toISOString().slice(0, 19)}+02:00`
  const zoneless = (step: number) => new Date(msOf(step)).toISOString().slice(0, 19)
  const steps = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i)
  /** Under way at about 18 knots. */
  const ownAt = (step: number) => 60 + step * 0.05
  type Seen = { name: string; elsewhere?: string; partly?: boolean; foreign?: boolean }
  /** What the scan says of each track: left unticked, only noted, noted as partly so, or nothing. */
  const verdicts = async (file: Blob, chunk?: number) =>
    Object.fromEntries(
      (await scanGpx(file, () => {}, chunk)).map(({ name, elsewhere, partly, foreign }: Seen) => [
        name,
        elsewhere === undefined ? undefined : `${foreign ? 'unticked' : partly ? 'partly' : 'noted'}: ${elsewhere}`,
      ]),
    )

  // A chartplotter's export carries other boats' passages beside the own
  // track, under names of their own: written into the recording, each drew
  // lines across an ocean to wherever that boat was at the time.
  it.each([7, 64, 1 << 20])(
    'leaves unticked a track that was elsewhere than the own one at the same time, in chunks of %i bytes',
    async (chunk) => {
      // Three days of it, five minutes into each ten, and each fix three
      // minutes on gone astray: only the first in each ten minutes is compared.
      const own = steps(0, 432).flatMap((i) => [at(ownAt(i), 24, utc(i, 5)), at(0, 0, utc(i, 8))])
      const file = gpxOf(
        track('Own Ship', own),
        // Each fix after one in the same ten minutes whose time cannot be read.
        track(
          'Passage',
          steps(0, 3).flatMap((i) => [
            at(-30, -20, utc(i, 9.99).replace(/:\d\d(\.\d+)?Z$/, ':99Z')),
            at(-30, -20, utc(i)),
          ]),
        ),
        track(
          'Offset',
          steps(0, 3).map((i) => at(-30, -20, offset(i))),
        ),
        // Written with character references, which the server decodes.
        track(
          'Encoded',
          steps(46, 3).map((i) => at('&#45;30', '-20', utc(i))),
        ),
        // The same vessel on a second plotter five minutes earlier, kilometres
        // behind, with one fix gone astray.
        track('Second plotter', [
          at(ownAt(-0.5), 24, utc(0)),
          at(ownAt(0.5), 24, utc(1)),
          at(0, 0, utc(2)),
          at(ownAt(2.5), 24, utc(3)),
        ]),
        // Plotters 900 metres north and 800 metres east, at the same instants.
        track(
          'Twin',
          steps(4, 4).map((i) => at(ownAt(i) + 0.0081, 24, utc(i, 5))),
        ),
        track(
          'Twin east',
          steps(12, 4).map((i) => at(ownAt(i), 24.0144, utc(i, 5))),
        ),
        // A kilometre and a half off at the same instants: no stray fix.
        track(
          'Close by',
          steps(60, 3).map((i) => at(ownAt(i) + 0.0135, 24, utc(i, 5))),
        ),
        // Five kilometres off a minute later: further than a vessel sails in it.
        track(
          'Neighbour',
          steps(8, 4).map((i) => at(ownAt(i) + 0.045, 24, utc(i, 6))),
        ),
        // Nine kilometres behind five minutes earlier, which 30 m/s covers,
        // and eleven, which it does not.
        track(
          'Fast boat',
          steps(52, 3).map((i) => at(ownAt(i) - 0.081, 24, utc(i))),
        ),
        track(
          'Too fast',
          steps(56, 3).map((i) => at(ownAt(i) - 0.099, 24, utc(i))),
        ),
        // Together as often as not.
        track('Mostly together', [
          ...steps(20, 3).map((i) => at(ownAt(i), 24, utc(i, 5))),
          ...steps(23, 3).map((i) => at(0, 0, utc(i, 5))),
        ]),
        // Renamed as the own track ends, its first two fixes stale.
        track('Renamed', [
          at(0, 0, utc(430, 9)),
          at(0, 0, utc(431, 9)),
          at(ownAt(432), 24, utc(432, 5)),
          at(ownAt(433), 24, utc(433, 5)),
        ]),
        // Points the import would not date or place.
        track(
          'No coordinates',
          steps(30, 3).map((i) => at('', '', utc(i))),
        ),
        track(
          'Exponents',
          steps(64, 3).map((i) => at('-3e1', '-2e1', utc(i))),
        ),
        track(
          'Time in extensions',
          steps(33, 3).map((i) => `<trkpt lat="-30" lon="-20"><extensions><time>${utc(i)}</time></extensions></trkpt>`),
        ),
        // A segment's own extensions after its one point.
        `<trk><name>Segment extensions</name><trkseg>${at(ownAt(50), 24, utc(50, 5))}<extensions>${steps(120, 4)
          .map((i) => `<time>${utc(i, 5)}</time>`)
          .join('')}</extensions></trkseg></trk>`,
        track(
          'No zone',
          steps(36, 3).map((i) => at(-30, -20, zoneless(i))),
        ),
        track(
          'North of the pole',
          steps(39, 3).map((i) => at(91, 24, utc(i))),
        ),
        track(
          'East of the date line',
          steps(42, 3).map((i) => at(60, 181, utc(i))),
        ),
        // 2023-02-29, which Date.parse would roll into 1 March.
        track(
          'No such day',
          steps(72, 3).map((i) => at(-30, -20, utc(i).replace('2023-03-01', '2023-02-29'))),
        ),
        // After the own track, under the name the plotter gives it in German.
        track(
          'Eigenes Schiff',
          steps(440, 10).map((i) => at(ownAt(i), 24, utc(i, 5))),
        ),
        track(
          'After the switch',
          steps(440, 3).map((i) => at(-30, -20, utc(i))),
        ),
        track(
          'Later',
          steps(460, 3).map((i) => at(-30, -20, utc(i))),
        ),
        track(
          'AIS Ariadne',
          steps(0, 3).map((i) => at(0, 0, utc(i))),
        ),
      )

      expect(await verdicts(file, chunk)).toEqual({
        'Own Ship': undefined,
        Passage: 'unticked: Own Ship',
        Offset: 'unticked: Own Ship',
        Encoded: 'unticked: Own Ship',
        'Second plotter': undefined,
        Twin: undefined,
        'Twin east': undefined,
        'Close by': 'unticked: Own Ship',
        Neighbour: 'unticked: Own Ship',
        'Fast boat': undefined,
        'Too fast': 'unticked: Own Ship',
        'Mostly together': undefined,
        Renamed: undefined,
        'No coordinates': undefined,
        Exponents: undefined,
        'Time in extensions': undefined,
        'Segment extensions': undefined,
        'No zone': undefined,
        'North of the pole': undefined,
        'East of the date line': undefined,
        'No such day': undefined,
        'Eigenes Schiff': undefined,
        'After the switch': 'unticked: Eigenes Schiff',
        Later: undefined,
        'AIS Ariadne': undefined,
      })
    },
  )

  // A track of the own name that covers little beside one elsewhere that
  // covers much may be a plotter just installed beside a friend's year, or
  // a friend's passage beside the own tracks under other names: the note
  // says what was seen, and the choice is left as it was.
  it.each(['Own Ship', 'Eigenes Schiff'])(
    'only notes a track elsewhere than %s where that covers little',
    async (name) => {
      const file = gpxOf(
        track(
          name,
          steps(0, 4).map((i) => at(ownAt(i), 24, utc(i, 5))),
        ),
        track(
          'Year',
          steps(0, 144).map((i) => at(-30, -20, utc(i))),
        ),
      )

      expect(await verdicts(file)).toEqual({ [name]: undefined, Year: `noted: ${name}` })
    },
  )

  // Hours, not points or stretches: a passage logged every minute outnumbers
  // in both an own track logged every half hour over more time.
  it('leaves unticked a passage logged more densely than the own track', async () => {
    const file = gpxOf(
      track(
        'Own Ship',
        steps(0, 20).map((i) => at(ownAt(i * 3), 24, utc(i * 3, 5))),
      ),
      track(
        'Passage',
        steps(0, 240).map((i) => at(-30, -20, utc(0, i))),
      ),
    )

    expect(await verdicts(file)).toEqual({ 'Own Ship': undefined, Passage: 'unticked: Own Ship' })
  })

  // Leaving a track unticked takes the own name to cover twice the hours of
  // all others together, those of a second plotter beside it included.
  it.each([
    ['twice the hours of the passage', 12, [], 'unticked'],
    ['less than twice', 18, [], 'noted'],
    [
      'less than twice with a second plotter',
      6,
      [
        track(
          'Second plotter',
          steps(6, 12).map((i) => at(ownAt(i), 24, utc(i))),
        ),
      ],
      'noted',
    ],
  ])('leaves unticked a passage where the own track covers %s', async (_, passageSteps, more, verdict) => {
    const file = gpxOf(
      track(
        'Own Ship',
        steps(0, 24).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      track(
        'Passage',
        steps(0, passageSteps as number).map((i) => at(-30, -20, utc(i))),
      ),
      ...(more as string[]),
    )

    expect((await verdicts(file)).Passage).toBe(`${verdict}: Own Ship`)
  })

  // In a file of a program that does not name the own track so, a track of
  // that name was taken in from TimeZero: another boat's, as like as not.
  it.each([
    ['OpenCPN', 'noted'],
    ['OpenCPN TimeZero importer', 'noted'],
    ['&#84;imeZero', 'unticked'],
    ['TimeZero Professional', 'unticked'],
    ['@signalk/tracks-plugin', 'unticked'],
  ])('judges a passage in a file by %s: %s', async (creator, verdict) => {
    const file = gpxBy(
      creator,
      track(
        'Own Ship',
        steps(0, 144).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      track(
        'Passage',
        steps(0, 3).map((i) => at(-30, -20, utc(i))),
      ),
    )

    expect((await verdicts(file)).Passage).toBe(`${verdict}: Own Ship`)
  })

  // The page cannot import what writes the plugin's own export, so this ties
  // the name and the creator it looks for to what that writes.
  it('leaves unticked a passage beside the own track in this plugin’s own export', async () => {
    const xml = toGpx([
      {
        name: trackLabel(SELF, SELF, () => undefined),
        context: SELF,
        segments: [steps(0, 144).map((i) => ({ position: [ownAt(i), 24] as [number, number], timestamp: msOf(i, 5) }))],
      },
      {
        name: 'Passage',
        segments: [steps(0, 3).map((i) => ({ position: [-30, -20] as [number, number], timestamp: msOf(i) }))],
      },
    ])

    const choices = (await scanGpx(new Blob([xml]))).map(trackChoice)

    expect(choices.map(({ name, checked }: { name: string; checked: boolean }) => [name, checked])).toEqual([
      ['Own Ship', true],
      ['Passage', false],
    ])
  })

  // Quotes and `>` in a value, the creator's or one before it, hide no
  // other program's file as TimeZero's.
  it.each([`creator="Skipper's Log"`, `creator='Nav "Pro"'`, 'creator="A > B"', 'desc="a>b" creator="OpenCPN"'])(
    'takes a file whose <gpx> says %s for another program’s',
    async (said) => {
      const file = new Blob([
        `<?xml version="1.0"?><gpx version="1.1" ${said} xmlns="${GPX}">`,
        track(
          'Own Ship',
          steps(0, 144).map((i) => at(ownAt(i), 24, utc(i, 5))),
        ),
        track(
          'Passage',
          steps(0, 3).map((i) => at(-30, -20, utc(i))),
        ),
        '</gpx>',
      ])

      expect((await verdicts(file)).Passage).toBe('noted: Own Ship')
    },
  )

  it.each([7, 64, 1 << 20])(
    'takes a file whose <gpx> names no creator for TimeZero’s, whatever else its values hold, in chunks of %i bytes',
    async (chunk) => {
      const file = new Blob([
        `<?xml version="1.0"?><gpx version="1.1" desc="a>b" xmlns="${GPX}">`,
        track(
          'Own Ship',
          steps(0, 144).map((i) => at(ownAt(i), 24, utc(i, 5))),
        ),
        track(
          'Passage',
          steps(0, 3).map((i) => at(-30, -20, utc(i))),
        ),
        '</gpx>',
      ])

      expect((await verdicts(file, chunk)).Passage).toBe('unticked: Own Ship')
    },
  )

  // A point's position from its own attributes, read with their quotes,
  // whole when a `>` in a value puts the tag across two chunks of the scan.
  it.each<[string, number, (i: number) => string]>([
    ['in another attribute’s value', 1 << 20, (i: number) => `desc=' lat="${ownAt(i)}" lon="24"' lat="-30" lon="-20"`],
    ...[7, 64, 1 << 20].map((chunk): [string, number, (i: number) => string] => [
      'after a `>` in a value',
      chunk,
      () => 'desc="a>b" lat="-30" lon="-20"',
    ]),
  ])('reads a point’s position, with one %s, in chunks of %i bytes', async (_, chunk, attributes) => {
    const file = gpxOf(
      track(
        'Own Ship',
        steps(0, 144).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      track(
        'Passage',
        steps(0, 3).map((i) => `<trkpt ${attributes(i)}><time>${utc(i)}</time></trkpt>`),
      ),
    )

    expect((await verdicts(file, chunk)).Passage).toBe('unticked: Own Ship')
  })

  // As the server reads a point: in GPX's namespace, under whatever prefix
  // the root binds to it, or in none.
  it.each([
    [
      'prefixed with one bound to GPX’s namespace',
      `<?xml version="1.0"?><g:gpx version="1.1" xmlns:g="${GPX}">`,
      (i: number, lat: number, lon: number) =>
        `<g:trkpt lat="${lat}" lon="${lon}"><g:time>${utc(i)}</g:time></g:trkpt>`,
      'unticked: Own Ship',
    ],
    [
      'prefixed with one bound to another namespace',
      `<?xml version="1.0"?><gpx version="1.1" xmlns="${GPX}" xmlns:v="urn:v">`,
      (i: number, lat: number, lon: number) =>
        `<v:trkpt lat="${lat}" lon="${lon}"><v:time>${utc(i)}</v:time></v:trkpt>`,
      undefined,
    ],
    [
      'in another namespace by its own xmlns',
      `<?xml version="1.0"?><gpx version="1.1" xmlns="${GPX}">`,
      (i: number, lat: number, lon: number) =>
        `<trkpt xmlns="urn:v" lat="${lat}" lon="${lon}"><time>${utc(i)}</time></trkpt>`,
      undefined,
    ],
  ])('reads the position of a point %s as the server would', async (_, root, point, verdict) => {
    const named = (name: string) => (root.includes('<g:gpx') ? `g:${name}` : name)
    const trackOf = (name: string, points: string[]) =>
      `<${named('trk')}><${named('name')}>${name}</${named('name')}><${named('trkseg')}>${points.join('')}</${named('trkseg')}></${named('trk')}>`
    const own = steps(0, 144).map((i) =>
      root.includes('<g:gpx')
        ? `<g:trkpt lat="${ownAt(i)}" lon="24"><g:time>${utc(i, 5)}</g:time></g:trkpt>`
        : at(ownAt(i), 24, utc(i, 5)),
    )
    const file = new Blob([
      [
        root,
        trackOf('Own Ship', own),
        trackOf(
          'Passage',
          steps(0, 3).map((i) => point(i, -30, -20)),
        ),
        `</${named('gpx')}>`,
      ].join('\n'),
    ])

    expect((await verdicts(file)).Passage).toBe(verdict)
  })

  // Bound wherever the server looks: on the <trk>, the <trkseg> or the point.
  it.each([
    [
      'a prefix bound on its <trkseg>',
      `<trk><name>Passage</name><trkseg xmlns:g="${GPX}">${steps(0, 3)
        .map((i) => `<g:trkpt lat="-30" lon="-20"><g:time>${utc(i)}</g:time></g:trkpt>`)
        .join('')}</trkseg></trk>`,
      'unticked: Own Ship',
    ],
    [
      'no namespace, said on the point',
      track(
        'Passage',
        steps(0, 3).map((i) => `<trkpt xmlns="" lat="-30" lon="-20"><time>${utc(i)}</time></trkpt>`),
      ),
      'unticked: Own Ship',
    ],
    [
      'a <time> in another namespace',
      track(
        'Passage',
        steps(0, 3).map((i) => `<trkpt lat="-30" lon="-20"><v:time xmlns:v="urn:v">${utc(i)}</v:time></trkpt>`),
      ),
      undefined,
    ],
    [
      'GPX’s namespace written with a character reference',
      `<trk><name>Passage</name><trkseg xmlns:g="http&#58;//www.topografix.com/GPX/1/1">${steps(0, 3)
        .map((i) => `<g:trkpt lat="-30" lon="-20"><g:time>${utc(i)}</g:time></g:trkpt>`)
        .join('')}</trkseg></trk>`,
      'unticked: Own Ship',
    ],
    [
      'a <trk> under another prefix, its points under none',
      `<v:trk xmlns:v="urn:v"><v:name>Passage</v:name><trkseg>${steps(0, 3)
        .map((i) => at(-30, -20, utc(i)))
        .join('')}</trkseg></v:trk>`,
      undefined,
    ],
    [
      'an element named trkseg in a point before it',
      track('Passage', [
        `<trkpt lat="-30" lon="-20"><time>${utc(0)}</time><extensions><v:trkseg xmlns:v="urn:v"/></extensions></trkpt>`,
        ...steps(1, 2).map((i) => at(-30, -20, utc(i))),
      ]),
      'unticked: Own Ship',
    ],
    [
      'a <trk> in another namespace',
      `<trk xmlns="urn:v"><name>Passage</name><trkseg>${steps(0, 3)
        .map((i) => at(-30, -20, utc(i)))
        .join('')}</trkseg></trk>`,
      undefined,
    ],
  ])('reads the namespace of a point with %s as the server would', async (_, passage, verdict) => {
    const file = gpxOf(
      track(
        'Own Ship',
        steps(0, 144).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      passage,
    )

    expect((await verdicts(file)).Passage).toBe(verdict)
  })

  // An own track the server would not read is no own track to judge by.
  it('judges nothing by a track of the own name in another namespace', async () => {
    const file = gpxOf(
      `<trk xmlns="urn:v"><name>Own Ship</name><trkseg>${steps(0, 144)
        .map((i) => at(ownAt(i), 24, utc(i, 5)))
        .join('')}</trkseg></trk>`,
      track(
        'Leg',
        steps(0, 3).map((i) => at(-30, -20, utc(i))),
      ),
    )

    expect((await verdicts(file)).Leg).toBeUndefined()
  })

  // A track is named by its own <name>, in GPX's namespace, as the server names it.
  it('names a track by its <name> in GPX’s namespace', async () => {
    const file = gpxOf(
      track(
        'Own Ship',
        steps(0, 144).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      `<trk><v:name xmlns:v="urn:v">Own Ship</v:name><name>Passage</name><trkseg>${steps(0, 3)
        .map((i) => at(-30, -20, utc(i)))
        .join('')}</trkseg></trk>`,
    )

    expect((await verdicts(file)).Passage).toBe('unticked: Own Ship')
  })

  // More own <trk> in ten minutes than any plotter writes: none is trusted.
  it('only notes a passage beside a crowd of tracks of the own name in one stretch', async () => {
    const file = gpxOf(
      ...steps(0, 17).map(() =>
        track(
          'Own Ship',
          steps(0, 144).map((i) => at(ownAt(i), 24, utc(i, 5))),
        ),
      ),
      track(
        'Passage',
        steps(0, 3).map((i) => at(-30, -20, utc(i))),
      ),
    )

    expect((await verdicts(file)).Passage).toBe('noted: Own Ship')
  })

  // TimeZero writes the own track as many <trk>, each sharing a stretch with
  // the next where they meet, the next one's first fix stale.
  it('leaves unticked a passage beside the own name split into <trk> where they meet', async () => {
    const file = gpxOf(
      track(
        'Own Ship',
        steps(0, 50).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      track('Own Ship', [at(0, 0, utc(49, 7)), ...steps(50, 50).map((i) => at(ownAt(i), 24, utc(i, 5)))]),
      track(
        'Own Ship',
        steps(99, 50).map((i) => at(ownAt(i), 24, utc(i, 6))),
      ),
      track(
        'Passage',
        steps(47, 6).map((i) => at(-30, -20, utc(i))),
      ),
    )

    expect((await verdicts(file)).Passage).toBe('unticked: Own Ship')
  })

  // Every <trk> of the track, not one, apart from an own one not disputed.
  it('only notes a track one of whose <trk> was apart only from a disputed one of the own name', async () => {
    const file = gpxOf(
      track(
        'Own Ship',
        steps(0, 200).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      track(
        'Own Ship',
        steps(150, 10).map((i) => at(10, 10, utc(i, 5))),
      ),
      track(
        'Own Ship',
        steps(300, 100).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      track(
        'Log',
        steps(320, 4).map((i) => at(-30, -20, utc(i))),
      ),
      track(
        'Log',
        steps(152, 4).map((i) => at(-30, -20, utc(i))),
      ),
    )

    expect((await verdicts(file)).Log).toBe('noted: Own Ship')
  })

  // Two of the own name apart at the same time: one is not the own vessel's.
  it('leaves nothing unticked for a track of the own name another so named was apart from', async () => {
    const file = gpxOf(
      track(
        'Own Ship',
        steps(0, 120).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      track(
        'Own Ship',
        steps(150, 100).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      // A friend's export taken into the plotter, from the gap into the second.
      track(
        'Own Ship',
        steps(125, 50).map((i) => at(-30, -20 + i * 0.01, utc(i, 5))),
      ),
      // The own phone's log in the gap, and a passage away from the first.
      track(
        'Phone',
        steps(122, 25).map((i) => at(ownAt(i), 24, utc(i))),
      ),
      track(
        'Passage',
        steps(10, 3).map((i) => at(10, 10, utc(i))),
      ),
    )

    expect(await verdicts(file)).toEqual({
      'Own Ship': undefined,
      Phone: 'noted: Own Ship',
      Passage: 'unticked: Own Ship',
    })
  })

  // Nor do their hours make the own name cover enough to leave one unticked.
  it('counts no hours of a track of the own name another so named was apart from', async () => {
    const file = gpxOf(
      track(
        'Own Ship',
        steps(0, 24).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      track(
        'Own Ship',
        steps(100, 60).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      track(
        'Own Ship',
        steps(100, 60).map((i) => at(-30, -20, utc(i, 5))),
      ),
      track(
        'Passage',
        steps(0, 18).map((i) => at(10, 10, utc(i))),
      ),
    )

    expect((await verdicts(file)).Passage).toBe('noted: Own Ship')
  })

  // Tracks go into the recording by name, so one name holding the own
  // vessel's <trk> and another's is chosen as a whole.
  it('only notes a track partly elsewhere, and leaves alone one partly together', async () => {
    const file = gpxOf(
      track(
        'Own Ship',
        [...steps(0, 100), ...steps(130, 100)].map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
      // Another boat's log, then the own handheld's in a gap of the plotter's.
      track(
        'Log',
        steps(10, 4).map((i) => at(-30, -20, utc(i))),
      ),
      track(
        'Log',
        steps(110, 10).map((i) => at(ownAt(i), 24, utc(i))),
      ),
      // Another boat's log, then the own handheld's beside the plotter.
      track(
        'Handheld',
        steps(20, 4).map((i) => at(-30, -20, utc(i))),
      ),
      track(
        'Handheld',
        steps(40, 4).map((i) => at(ownAt(i), 24, utc(i, 5))),
      ),
    )

    expect(await verdicts(file)).toEqual({ 'Own Ship': undefined, Log: 'partly: Own Ship', Handheld: undefined })
  })

  // A file can hold another vessel's track under the own name too: a
  // friend's export taken into the plotter, in another language or not.
  it.each([
    [
      'a friend’s track under the German name',
      [
        track(
          'Own Ship',
          steps(0, 10).map((i) => at(ownAt(i), 24, utc(i, 5))),
        ),
        track(
          'Eigenes Schiff',
          steps(0, 10).map((i) => at(-30, -20, utc(i, 5))),
        ),
      ],
    ],
    [
      'a friend’s track under the same name, ahead of the own',
      [
        track(
          'Own Ship',
          steps(0, 10).map((i) => at(-30, -20, utc(i, 5))),
        ),
        track(
          'Own Ship',
          steps(0, 10).map((i) => at(ownAt(i), 24, utc(i, 5))),
        ),
      ],
    ],
  ])('leaves alone a track together with any named like the own one: %s', async (_, tracks) => {
    const file = gpxOf(
      ...tracks,
      // Together with the own in three stretches, the fewest that count.
      track(
        'Second plotter',
        steps(2, 3).map((i) => at(ownAt(i), 24, utc(i))),
      ),
      // Met the own in two stretches and left in a third: too few to count.
      track('Brief encounter', [at(ownAt(6), 24, utc(6, 5)), at(ownAt(7), 24, utc(7, 5)), at(10, 10, utc(8, 5))]),
      // With the own as often as away from it.
      track('Half with us', [
        ...steps(0, 3).map((i) => at(ownAt(i), 24, utc(i, 5))),
        ...steps(3, 3).map((i) => at(10, 10, utc(i, 5))),
      ]),
      track(
        'Passage',
        steps(2, 4).map((i) => at(10, 10, utc(i))),
      ),
    )

    expect(await verdicts(file)).toMatchObject({
      'Second plotter': undefined,
      'Brief encounter': expect.stringMatching(/^noted: /),
      'Half with us': expect.stringMatching(/^noted: /),
      Passage: expect.stringMatching(/^noted: /),
    })
  })

  // Which of two tracks apart at the same time is the own one does not show
  // in where and when they were.
  it.each([
    [
      'a plotter keeping a track a day beside a longer passage',
      [
        track(
          'Passage',
          steps(0, 30).map((i) => at(-30, -20, utc(i))),
        ),
        ...[0, 1, 2, 3, 4].map((day) =>
          track(
            `Day ${day}`,
            steps(day * 6, 5).map((i) => at(ownAt(i), 24, utc(i))),
          ),
        ),
      ],
    ],
    [
      'a plotter of years beside a passage',
      [
        track(
          'Track',
          steps(0, 144).map((i) => at(ownAt(i), 24, utc(i))),
        ),
        track(
          'Passage',
          steps(0, 3).map((i) => at(-30, -20, utc(i))),
        ),
      ],
    ],
  ])('marks nothing in a file with no track named like the own one: %s', async (_, tracks) => {
    const marked = Object.entries(await verdicts(gpxOf(...tracks))).filter(([, by]) => by !== undefined)

    expect(marked).toEqual([])
  })

  type Call = { url: string; method: string; offset?: number; size?: number; signal?: AbortSignal | null | undefined }

  /**
   * A server taking an upload: `answer` may stand in for its answer to a
   * slice. Each call is noted with the offset and size of the slice it sent.
   */
  const server = (
    size: number,
    over: {
      current?: object
      answer?: (call: Call, take: () => Response) => Response | Promise<Response>
      stop?: () => Response
    } = {},
  ) => {
    const calls: Call[] = []
    let upload = {
      id: 'u1',
      state: 'receiving',
      received: 0,
      size,
      filename: 'f.gpx',
      tracks: ['Own'],
      onOverlap: 'keep',
    }
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    const request = vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      const offset = /offset=(\d+)/.exec(url)?.[1]
      const call: Call = { url, method, signal: init.signal }
      if (offset !== undefined) {
        call.offset = Number(offset)
        call.size = (init.body as Blob).size
      }
      calls.push(call)
      if (method === 'GET') return json({ upload: over.current ?? null })
      if (method === 'POST') return json({ upload }, 201)
      if (method === 'DELETE' && over.stop) return over.stop()
      if (method === 'DELETE') return json({ upload: (upload = { ...upload, state: 'aborted' }) })
      const take = () => {
        const received = upload.received + call.size!
        upload = { ...upload, received, state: received === size ? 'finished' : 'receiving' }
        return json({ upload })
      }
      return over.answer ? over.answer(call, take) : take()
    })
    return { calls, request }
  }

  const blob = (size: number) => Object.assign(new Blob([new Uint8Array(size)]), { name: 'f.gpx' })
  const options = { tracks: ['Own'], onOverlap: 'keep', onStatus: () => {}, sleep: async () => {} }

  it('sends the file a slice at a time from where the server says it got to', async () => {
    const size = 2 * SLICE_BYTES + 5
    const { calls, request } = server(size)
    const done = await uploadGpx({ ...options, file: blob(size), request })
    expect(done).toMatchObject({ state: 'finished', received: size })
    expect(calls.filter(({ method }) => method === 'PUT').map(({ offset, size }) => [offset, size])).toEqual([
      [0, SLICE_BYTES],
      [SLICE_BYTES, SLICE_BYTES],
      [2 * SLICE_BYTES, 5],
    ])
  })

  it('goes on with an upload of the same file broken off before', async () => {
    const size = SLICE_BYTES + 5
    const current = {
      id: 'u0',
      state: 'receiving',
      received: SLICE_BYTES,
      size,
      filename: 'f.gpx',
      tracks: ['Own'],
      onOverlap: 'keep',
      fingerprint: await fingerprintOf(blob(size)),
    }
    const { calls, request } = server(size, {
      current,
      answer: () => new Response(JSON.stringify({ upload: { ...current, received: size, state: 'finished' } })),
    })
    await uploadGpx({ ...options, file: blob(size), request })
    expect(calls.map(({ method, url }) => `${method} ${url.replace(/^.*upload/, '')}`)).toEqual([
      'GET ',
      `PUT /u0?offset=${SLICE_BYTES}`,
    ])
  })

  it('starts anew with another file of the same name and size', async () => {
    const size = SLICE_BYTES + 5
    const other = Object.assign(new Blob([new Uint8Array(size).fill(1)]), { name: 'f.gpx' })
    const current = {
      id: 'u0',
      state: 'receiving',
      received: SLICE_BYTES,
      size,
      filename: 'f.gpx',
      tracks: ['Own'],
      onOverlap: 'keep',
      fingerprint: await fingerprintOf(blob(size)),
    }
    const { calls, request } = server(size, { current })
    await uploadGpx({ ...options, file: other, request })
    expect(calls.map(({ method }) => method).slice(0, 3)).toEqual(['GET', 'POST', 'PUT'])
    expect(calls[2]).toMatchObject({ offset: 0 })
  })

  it('starts anew when only the last bytes of a same-size file differ', async () => {
    const size = SLICE_BYTES + 5
    const bytes = new Uint8Array(size)
    bytes[size - 1] = 1
    const other = Object.assign(new Blob([bytes]), { name: 'f.gpx' })
    const current = {
      id: 'u0',
      state: 'receiving',
      received: SLICE_BYTES,
      size,
      filename: 'f.gpx',
      tracks: ['Own'],
      onOverlap: 'keep',
      fingerprint: await fingerprintOf(blob(size)),
    }
    const { calls, request } = server(size, { current })
    await uploadGpx({ ...options, file: other, request })
    expect(calls.map(({ method }) => method).slice(0, 3)).toEqual(['GET', 'POST', 'PUT'])
    expect(calls[2]).toMatchObject({ offset: 0 })
  })

  it('sends a slice again after a dropped connection, from where the server got to', async () => {
    let failed = false
    const { calls, request } = server(10, {
      answer: (_call, take) => {
        if (!failed) {
          failed = true
          throw new TypeError('Failed to fetch')
        }
        return take()
      },
    })
    await uploadGpx({ ...options, file: blob(10), request })
    expect(calls.filter(({ method }) => method === 'PUT')).toHaveLength(2)
  })

  it('gives up on a refusal no second try changes', async () => {
    const { request } = server(10, {
      answer: () => new Response(JSON.stringify({ message: 'The file is not well-formed GPX' }), { status: 422 }),
    })
    await expect(uploadGpx({ ...options, file: blob(10), request })).rejects.toThrow('The file is not well-formed GPX')
  })

  it('ends the upload on the server when stopped', async () => {
    const controller = new AbortController()
    const { calls, request } = server(2 * SLICE_BYTES, {
      answer: (_call, take) => {
        controller.abort()
        return take()
      },
    })
    await expect(
      uploadGpx({ ...options, file: blob(2 * SLICE_BYTES), request, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls.map(({ method }) => method)).toEqual(['GET', 'POST', 'PUT', 'DELETE'])
  })

  it('gives up a slice stuck on its way when stopped', async () => {
    const controller = new AbortController()
    const { calls, request } = server(10, {
      answer: ({ signal }) => {
        setTimeout(() => controller.abort(), 0)
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      },
    })
    await expect(uploadGpx({ ...options, file: blob(10), request, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(calls.map(({ method }) => method)).toEqual(['GET', 'POST', 'PUT', 'DELETE'])
  })

  it('stops while the upload is being started, and ends the upload that start brings', async () => {
    const controller = new AbortController()
    let answer: (response: Response) => void = () => {}
    const calls: string[] = []
    const request = vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      calls.push(`${method} ${url.replace(/^.*upload/, '')}`)
      if (method === 'GET') return new Response(JSON.stringify({ upload: null }))
      if (method === 'POST') return new Promise<Response>((resolve) => (answer = resolve))
      return new Response(JSON.stringify({ upload: { id: 'u1', state: 'aborted' } }))
    })
    const uploading = uploadGpx({ ...options, file: blob(10), request, signal: controller.signal })
    await vi.waitFor(() => expect(calls).toContain('POST '))
    controller.abort()
    await expect(uploading).rejects.toMatchObject({ name: 'AbortError' })
    answer(new Response(JSON.stringify({ upload: { id: 'u1', state: 'receiving', received: 0, size: 10 } })))
    await vi.waitFor(() => expect(calls).toContain('DELETE /u1'))
  })

  it('stops without waiting out the delay before a retry', async () => {
    const controller = new AbortController()
    const { calls, request } = server(10, {
      answer: () => {
        setTimeout(() => controller.abort(), 0)
        return new Response(JSON.stringify({ message: 'restarting' }), { status: 503 })
      },
    })
    const started = Date.now()
    await expect(
      uploadGpx({ ...options, sleep: undefined, file: blob(10), request, signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(calls.at(-1)?.method).toBe('DELETE')
    // The first retry waits two seconds.
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('says so when the server could not be told the upload stopped', async () => {
    const controller = new AbortController()
    const { calls, request } = server(2 * SLICE_BYTES, {
      answer: (_call, take) => {
        controller.abort()
        return take()
      },
      stop: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await expect(
      uploadGpx({ ...options, file: blob(2 * SLICE_BYTES), request, signal: controller.signal }),
    ).rejects.toThrow('the server could not be told')
    expect(calls.filter(({ method }) => method === 'DELETE')).toHaveLength(5)
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
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('takes DELETE, and nothing else, as confirming', () => {
    expect(confirmed('DELETE')).toBe(true)
    expect(confirmed(' DELETE ')).toBe(true)
    expect(confirmed('delete')).toBe(false)
    expect(confirmed('')).toBe(false)
  })

  /** The dialog's handlers, run against stand-ins for its elements, with `answer` as fetch. */
  function mount(answer: (url: string, init: { signal: AbortSignal }) => Promise<unknown>) {
    const handlers: Record<string, (event?: unknown) => unknown> = {}
    const on = (name: string) => (_type: string, handler: (event?: unknown) => unknown) => {
      handlers[name] = handler
    }
    const button = { disabled: true }
    const cancelButton = { addEventListener: on('cancelClick') }
    const confirm = { value: '', addEventListener: on('input') }
    const form = {
      elements: { confirm },
      querySelector: (selector: string) => (selector.includes('cancel') ? cancelButton : button),
      addEventListener: on('submit'),
    }
    const dialog = { querySelector: () => form, showModal: vi.fn(), close: vi.fn(), addEventListener: on('cancel') }
    const error = { textContent: '', hidden: true }
    const elements: Record<string, unknown> = {
      'reset-open': { addEventListener: on('click') },
      'reset-dialog': dialog,
      'reset-error': error,
    }
    const fetch = vi.fn(answer)
    const reload = vi.fn()
    vi.stubGlobal('document', { getElementById: (id: string) => elements[id] })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('location', { reload })
    startDanger()
    // Kept from the form, whose method="dialog" would close it on the spot.
    const submitHeld = vi.fn()
    const submit = () => handlers.submit!({ submitter: { value: 'reset' }, preventDefault: submitHeld })
    /** Whether the dialog stays open on Cancel, or on Esc. */
    const keptOpen = (how: 'Cancel' | 'Esc') => {
      if (how === 'Cancel') {
        const closes = dialog.close.mock.calls.length
        handlers.cancelClick!()
        return dialog.close.mock.calls.length === closes
      }
      const preventDefault = vi.fn()
      handlers.cancel!({ preventDefault })
      return preventDefault.mock.calls.length > 0
    }
    return { handlers, button, confirm, dialog, error, fetch, reload, submit, submitHeld, keptOpen }
  }

  it('deletes only once the word is typed, says why it was refused, and reloads once done', async () => {
    const answers = [
      { ok: false, status: 403, json: () => Promise.reject(new Error('not JSON')) },
      { ok: true, status: 200, json: () => Promise.resolve({ deleted: true }) },
    ]
    const { handlers, button, confirm, dialog, error, fetch, reload, submit, keptOpen } = mount(() =>
      Promise.resolve(answers.shift()),
    )

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

    await submit()
    expect(fetch).toHaveBeenCalledWith(
      '../../plugins/tracks/database?confirm=DELETE',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(error.textContent).toBe('This needs an administrator login.')
    expect(error.hidden).toBe(false)
    expect(button.disabled).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(keptOpen('Cancel')).toBe(false)
    expect(keptOpen('Esc')).toBe(false)

    const closes = dialog.close.mock.calls.length
    await submit()
    expect(dialog.close).toHaveBeenCalledTimes(closes + 1)
    expect(reload).toHaveBeenCalled()
  })

  it('waits a minute for a delete, then stops and says it may have gone through', async () => {
    // AbortSignal.timeout runs on timers of Node's own, which fake timers do
    // not reach, so the deadline is rebuilt on setTimeout for the test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms)
      return controller.signal
    })
    const { handlers, button, confirm, error, fetch, reload, submit, keptOpen } = mount(
      (_url: string, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    )
    handlers.click!()
    confirm.value = 'DELETE'
    handlers.input!()

    const sent = submit()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(error.hidden).toBe(true)
    expect(button.disabled).toBe(true)
    expect(keptOpen('Esc')).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    await sent
    expect(deadline).toHaveBeenCalledWith(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(error.textContent).toBe(
      'The server did not answer. The database may still have been deleted: reload the page to see.',
    )
    // A second delete takes the word typed again, not one click.
    expect(confirm.value).toBe('')
    expect(button.disabled).toBe(true)
    expect(keptOpen('Esc')).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('asks for the word again when the connection fails', async () => {
    const { handlers, button, confirm, error, fetch, submit } = mount(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    )
    handlers.click!()
    confirm.value = 'DELETE'
    handlers.input!()

    await submit()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(error.textContent).toBe(
      'The connection failed. The database may still have been deleted: reload the page to see.',
    )
    expect(confirm.value).toBe('')
    expect(button.disabled).toBe(true)
  })

  it('asks for the word again after a proxy error, and not after the plugin refused', async () => {
    for (const [status, cleared] of [
      [502, true],
      [504, true],
      [409, false],
    ] as const) {
      const { handlers, confirm, submit } = mount(() =>
        Promise.resolve({ ok: false, status, json: () => Promise.reject(new Error('not JSON')) }),
      )
      handlers.click!()
      confirm.value = 'DELETE'
      handlers.input!()

      await submit()
      expect(confirm.value).toBe(cleared ? '' : 'DELETE')
    }
  })

  it('asks once and stays open while a delete is on its way', async () => {
    let answer!: (response: unknown) => void
    const { handlers, button, confirm, error, fetch, reload, submit, submitHeld, keptOpen } = mount(
      () => new Promise((resolve) => (answer = resolve)),
    )
    handlers.click!()
    expect(keptOpen('Cancel')).toBe(false)
    expect(keptOpen('Esc')).toBe(false)
    confirm.value = 'DELETE'
    handlers.input!()

    const first = submit()
    expect(submitHeld).toHaveBeenCalledTimes(1)
    expect(keptOpen('Cancel')).toBe(true)
    expect(keptOpen('Esc')).toBe(true)
    for (const typed of ['DELET', 'DELETE']) {
      confirm.value = typed
      handlers.input!()
      expect(button.disabled).toBe(true)
    }
    await submit()
    expect(submitHeld).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledTimes(1)

    answer({ ok: true, status: 200, json: () => Promise.resolve({ deleted: true }) })
    await first
    expect(error.hidden).toBe(true)
    expect(reload).toHaveBeenCalled()
  })
  // Enter in the field submits with the form's first submit button: were that
  // Cancel, typing the word and pressing Enter would close the dialog.
  it('has Delete as its only submit button', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    const form = /<dialog id="reset-dialog"[\s\S]*?<\/dialog>/.exec(html)![0]
    const submits = [...form.matchAll(/<button\b([^>]*)>/g)]
      .map(([, attributes]) => attributes!)
      .filter((attributes) => !/type="button"/.test(attributes))
    expect(submits).toEqual([' value="reset" class="danger" disabled'])
  })
})
