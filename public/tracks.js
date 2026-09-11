/**
 * Track list for the management webapp.
 *
 * Reads the v2 Track API with `geometry=false`, which answers with each
 * track's metadata and no coordinates — the same query the API already serves,
 * so listing hundreds of tracks costs nothing like fetching them.
 *
 * Plain modules and no build step: the plugin ships `public/` as static files
 * and the server mounts it directly, so anything needing a bundler would mean
 * a second build output for a page this size.
 */

/**
 * How far back the list reaches.
 *
 * The API refuses an unbounded multi-context query — "a time window (from or
 * duration) is required unless a single context is given" — because listing
 * every track a server ever saw is a question with no cheap answer. Thirty
 * days covers the passage someone is looking for while keeping the query
 * something the store can serve.
 */
const WINDOW = 'P30D'

/** Relative, because the server mounts this under /@signalk/tracks-plugin. */
const TRACKS_URL = `../../signalk/v2/api/tracks?geometry=false&duration=${WINDOW}`

const status = document.getElementById('status')
const table = document.getElementById('tracks')
const tbody = table.querySelector('tbody')

/**
 * The label for a track, matching `trackLabel()` on the server.
 *
 * The API gives `contextName` — the vessel's own name, undecorated and absent
 * when unknown — plus `isSelf`. Turning those into something a person
 * recognises is the client's job, and it has to agree with what v1 returns or
 * the same track reads differently depending on which screen it is on.
 */
function label({ context, contextName, isSelf }) {
  if (isSelf) {
    return 'Own Ship'
  }
  if (contextName) {
    return `AIS ${contextName}`
  }
  const mmsi = /urn:mrn:imo:mmsi:(\d+)$/.exec(context)
  return mmsi ? `AIS ${mmsi[1]}` : context
}

/** ISO-8601 from the API, rendered in the viewer's own locale and zone. */
function when(iso) {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString()
}

function row(properties) {
  const tr = document.createElement('tr')
  const name = document.createElement('td')
  name.textContent = label(properties)
  if (properties.isSelf) {
    name.className = 'self'
  }
  tr.append(name, cell(when(properties.from)), cell(when(properties.to)), cell(properties.pointCount, 'num'))
  return tr
}

function cell(text, className) {
  const td = document.createElement('td')
  // textContent, never innerHTML: a vessel name arrives from an AIS
  // transmission and is not ours to trust as markup.
  td.textContent = String(text)
  if (className) {
    td.className = className
  }
  return td
}

function show(message, state) {
  status.textContent = message
  if (state) {
    status.dataset.state = state
  } else {
    delete status.dataset.state
  }
}

async function load() {
  let response
  try {
    response = await fetch(TRACKS_URL, { credentials: 'include' })
  } catch {
    show('Could not reach the server.', 'error')
    return
  }
  // 501 is the server saying no provider is registered, which is a different
  // thing from an error and worth telling the user plainly.
  if (response.status === 501) {
    show('No track provider is registered on this server.', 'error')
    return
  }
  if (!response.ok) {
    show(`The server answered ${response.status}.`, 'error')
    return
  }

  let body
  try {
    body = await response.json()
  } catch {
    // A 200 carrying something that is not JSON: a proxy's error page, or a
    // truncated response. Without this the rejection escapes `void load()` and
    // the page sits on "Loading…" forever, which looks like a hang.
    show('The server sent a response this page could not read.', 'error')
    return
  }
  // Entries without properties are skipped rather than thrown on, for the same
  // reason: one malformed feature should not blank the whole list.
  const features = Array.isArray(body?.features) ? body.features : []
  // Newest first: the track someone came to look at is almost always the one
  // that just finished.
  const sorted = features
    .map((feature) => feature?.properties)
    .filter((properties) => properties && typeof properties.context === 'string')
    .sort((a, b) => String(b.to ?? '').localeCompare(String(a.to ?? '')))

  // Checked after filtering, not before: a response of nothing but malformed
  // features would otherwise draw an empty table reading "0 tracks".
  if (sorted.length === 0) {
    show('No tracks in the last 30 days.')
    return
  }

  tbody.replaceChildren(...sorted.map(row))
  table.hidden = false
  show(`${sorted.length} track${sorted.length === 1 ? '' : 's'} in the last 30 days.`)
}

void load()
