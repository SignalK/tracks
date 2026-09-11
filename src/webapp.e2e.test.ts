import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from './e2e.test-utils.js'
import type { E2EServer } from './e2e.test-utils.js'

/**
 * The webapp as the server actually serves it.
 *
 * The unit suite proves the label logic; only a real server proves the parts
 * that depend on packaging: that `public/` survives the `files` allowlist,
 * that the `signalk-webapp` keyword gets it mounted at all, and that it is
 * mounted where the page's own relative URLs expect.
 *
 * Deliberately not in CI, like the rest of the e2e tier.
 */
describe('the webapp is served by a real server', () => {
  let server: E2EServer

  beforeAll(async () => {
    server = await startServer({ port: 4791 })
  }, 180_000)

  afterAll(() => server?.stop())

  const fetchApp = (path: string) => fetch(`${server.url}/@signalk/tracks-plugin/${path}`)

  it('mounts the page under the package name', async () => {
    const res = await fetchApp('index.html')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>Tracks</title>')
  })

  it('serves the script and stylesheet the page asks for', async () => {
    for (const asset of ['tracks.js', 'style.css']) {
      const res = await fetchApp(asset)

      expect(res.status, asset).toBe(200)
    }
  })

  // The page is mounted under /@signalk/tracks-plugin, so its relative URL for
  // the API has to climb back out to the server root. Getting this wrong gives
  // a page that loads and then shows "Could not reach the server".
  it('resolves its API url to the real track endpoint', async () => {
    const page = new URL(`${server.url}/@signalk/tracks-plugin/index.html`)
    // The URL the page actually asks for, observed by running it against a
    // stub document and a fetch that records its argument -- rather than read
    // out of the source, which would pin how the request happens to be
    // written rather than where it goes.
    const { requested } = await renderShippedPage(await (await fetchApp('tracks.js')).text())
    expect(requested).toHaveLength(1)

    const resolved = new URL(requested[0]!, page)
    const res = await fetch(resolved)

    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('features')
  })
})

/**
 * Run the shipped script against a stub document, recording what it fetches.
 *
 * The unit suite has a richer version of this; here it only needs to reach the
 * fetch, so the response is a minimal empty collection.
 */
async function renderShippedPage(source: string): Promise<{ requested: string[] }> {
  const stub = () => {
    const el: Record<string, unknown> = { dataset: {}, hidden: false, textContent: '', className: '' }
    Object.assign(el, {
      append: () => undefined,
      replaceChildren: () => undefined,
      querySelector: () => el,
    })
    return el
  }
  const shared = stub()
  const requested: string[] = []
  const run = new Function(
    'document',
    'fetch',
    `return (async () => { ${source.replace(/^void load\(\)$/m, '')} await load() })()`,
  ) as (d: unknown, f: unknown) => Promise<void>

  await run({ getElementById: () => shared, createElement: stub }, (url: string) => {
    requested.push(url)
    return Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ type: 'FeatureCollection', features: [] }),
    })
  })
  return { requested }
}
