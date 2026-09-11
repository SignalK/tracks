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
    const script = await (await fetchApp('tracks.js')).text()
    // The constants are evaluated rather than pattern-matched: the URL is
    // built from a template with the window in it, so a regex over the source
    // would pin how it happens to be written rather than where it points.
    // Only the declarations run — the rest of the module touches `document`.
    const declarations = script.slice(0, script.indexOf('const status'))
    const relative = new Function(`${declarations}\nreturn TRACKS_URL`)() as string

    const resolved = new URL(relative, page)
    const res = await fetch(resolved)

    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('features')
  })
})
