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
 * How far back the list of other vessels reaches when the plugin does not say
 * how long it keeps them, or keeps them indefinitely; otherwise it reaches
 * back as far as they are kept.
 *
 * The API refuses an unbounded multi-context query — "a time window (from or
 * duration) is required unless a single context is given" — because listing
 * every track a server ever saw is a question with no cheap answer. Thirty
 * days covers the passage someone is looking for while keeping the query
 * something the store can serve.
 */
const LIST_DAYS = 30

// The two APIs spell a duration differently: v2 takes ISO 8601, v1 takes a
// number with a unit suffix. One spelling for both sent `P30D` to the v1
// export route, which rejected it and made every GPX download a 400.
const v2Days = (days) => `P${days}D`
const v1Days = (days) => `${days}d`

/** This plugin's id, which the server stamps on its tracks as `providerId`. */
const PROVIDER_ID = 'tracks'

/**
 * Ceiling on the list request.
 *
 * Generous, because a month of tracks on a busy receiver is a real query, not
 * a hung one — this exists to end a request that will never answer, not to
 * hurry a slow store.
 */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * How long the list waits for the own vessel's tracks before it is asked
 * anyway: a third of the ceiling, leaving the rest to the list. They come in
 * a second or two, so this only ends a request stalled on its way.
 */
const OWN_WAIT_MS = REQUEST_TIMEOUT_MS / 3

/** Relative, because the server mounts this under /@signalk/tracks-plugin. */
const tracksUrl = (days) => `../../signalk/v2/api/tracks?geometry=false&duration=${v2Days(days)}`
/**
 * The own vessel's tracks alone, asked for before the whole list: one vessel
 * answers at once, while every AIS target a busy receiver heard in a month
 * can take the store many seconds. With no window, since one vessel needs
 * none: its whole recording.
 */
const OWN_TRACKS_URL = '../../signalk/v2/api/tracks?geometry=false&contexts=vessels.self'
/** How long the plugin keeps other vessels, from its settings. */
const SETTINGS_URL = '../../plugins/tracks/settings'
/** One track by its id, on a server that serves them so. */
const TRACK_URL = '../../signalk/v2/api/tracks/'
/** Every import, in the shape of the list's rows; the window above misses old and untimed ones. */
const IMPORTS_URL = '../../plugins/tracks/imports'

const status = document.getElementById('status')

/** A list of tracks, and the note above it that says what it shows. */
function listOf(tableId, noteId) {
  const table = document.getElementById(tableId)
  return { table, tbody: table.querySelector('tbody'), note: document.getElementById(noteId) }
}

/**
 * The own vessel, other vessels and imports each in a list of their own: they
 * are kept for different times, and one list under one window read as though
 * all three were kept for it.
 */
const lists = {
  own: listOf('own-tracks', 'own-note'),
  others: listOf('other-tracks', 'others-note'),
  imported: listOf('imported-tracks', 'imported-note'),
}

/** How far back the list of other vessels reaches, once the settings are read. */
let listDays = LIST_DAYS

function kindOf(properties) {
  const id = localId(properties)
  if (typeof id === 'string' && id.startsWith('imported:')) {
    return 'imported'
  }
  return properties.isSelf ? 'own' : 'others'
}

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
  const mmsi = /urn:mrn:imo:mmsi:(\d+)$/.exec(context ?? '')
  return mmsi ? `AIS ${mmsi[1]}` : (context ?? 'No vessel')
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
  // An imported track names the vessel it belongs to and has a name of its
  // own; without the second it reads exactly like that vessel's recording.
  if (typeof properties.name === 'string') {
    const imported = document.createElement('span')
    imported.className = 'imported'
    imported.textContent = ` (imported: ${properties.name})`
    name.append(imported)
  }
  tr.append(
    name,
    cell(when(properties.from)),
    cell(when(properties.to)),
    cell(properties.pointCount, 'num'),
    exportCell(properties),
    deleteCell(properties),
  )
  return tr
}

/**
 * A button asking `bin.js` to delete this track.
 *
 * Handed over as an event rather than handled here, so the list stays a page
 * that only reads; a track that cannot be addressed gets none.
 */
function deleteCell(properties) {
  const td = document.createElement('td')
  // The server names a track `providerId:trackId`; one that hands out the
  // provider's own ids has no route to delete them by.
  const { id, providerId } = properties
  if (typeof id === 'string' && typeof providerId === 'string' && id.startsWith(`${providerId}:`)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'Delete…'
    button.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('tracks:delete', { detail: { ...properties, label: label(properties) } }))
    })
    td.append(button)
  }
  return td
}

/**
 * A link that downloads this track as GPX.
 *
 * A plain link rather than a fetch: the browser already knows how to save a
 * response with a Content-Disposition on it, and the server sets one. Doing it
 * by hand would mean holding a whole track in memory to build a blob.
 */
function exportCell(properties) {
  const { providerId, context, isSelf } = properties
  const td = document.createElement('td')
  const link = document.createElement('a')
  const trackId = localId(properties)
  // An import is exported as it was imported, never as the recording of the
  // vessel it names; v1 does not know imports at all. Only this plugin's own:
  // another provider's ids mean nothing to its route.
  if (typeof trackId === 'string' && trackId.startsWith('imported:')) {
    if (providerId !== undefined && providerId !== PROVIDER_ID) {
      return td
    }
    link.href = `../../plugins/tracks/imports/${encodeURIComponent(trackId)}/track.gpx`
  } else if (typeof context === 'string') {
    // `self` resolves server-side; using it keeps the URL short and avoids
    // guessing how the own vessel's context should be spelled. The own
    // vessel's whole recording, which the route writes a day at a time; another
    // vessel's as far back as its list reaches.
    link.href = isSelf
      ? '../../signalk/v1/api/self/track.gpx'
      : `../../signalk/v1/api/vessels/${encodeURIComponent(context)}/track.gpx?duration=${v1Days(listDays)}`
  } else {
    return td
  }
  link.textContent = 'GPX'
  link.rel = 'nofollow'
  td.append(link)
  return td
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

/**
 * Every imported track, or none when the server cannot list them: one that
 * predates the route, or keeps it to administrators. The list then shows what
 * the Track API returns, as it always has.
 */
async function allImports(signal) {
  try {
    const response = await fetch(IMPORTS_URL, { credentials: 'include', signal })
    const body = response.ok ? await response.json() : undefined
    return Array.isArray(body) ? body : []
  } catch {
    return []
  }
}

/**
 * A track's id without the provider prefix, which a server older than the
 * Track API's write routes leaves off; the import listing always carries it.
 */
function localId(properties) {
  const { id, providerId } = properties ?? {}
  return typeof id === 'string' && typeof providerId === 'string' && id.startsWith(`${providerId}:`)
    ? id.slice(providerId.length + 1)
    : id
}

/**
 * Whether the server names tracks `providerId:trackId`. Its listing shows it;
 * with nothing listed, asking it for one import by that name does.
 */
async function namesByProvider(listed, unlisted, signal) {
  if (listed.length > 0) {
    return listed.some(
      (properties) =>
        typeof properties?.providerId === 'string' &&
        typeof properties.id === 'string' &&
        properties.id.startsWith(`${properties.providerId}:`),
    )
  }
  if (unlisted.length === 0) {
    return false
  }
  try {
    const response = await fetch(`${TRACK_URL}${encodeURIComponent(unlisted[0].id)}`, {
      credentials: 'include',
      signal,
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Whether a listed entry can be shown. Skipped rather than thrown on: one
 * malformed feature should not blank a list that is otherwise fine.
 */
function listable(properties) {
  return (
    properties &&
    // An import may name no vessel; it is still listed, so it can be deleted.
    (typeof properties.context === 'string' || typeof properties.name === 'string') &&
    Number.isFinite(properties.pointCount)
  )
}

/**
 * Puts the entries that can be shown in their lists, newest first: the track
 * someone came to look at is almost always the one that just finished.
 */
function draw(entries) {
  const sorted = entries.filter(listable).sort((a, b) => String(b.to ?? '').localeCompare(String(a.to ?? '')))
  for (const [kind, { table, tbody }] of Object.entries(lists)) {
    const rows = sorted.filter((properties) => kindOf(properties) === kind)
    // Replaced even with nothing, so the own vessel's rows shown while the
    // list loaded do not outlive a list that has none.
    tbody.replaceChildren(...rows.map(row))
    table.hidden = rows.length === 0
  }
  return sorted
}

const daysText = (days) => `${days} day${days === 1 ? '' : 's'}`

/**
 * The notes over the lists, for what they turned out to hold. `own` says
 * whether the own vessel's request answered, and with its recording: when it
 * did not, its row is the list's window of it.
 */
function describe(sorted, retention, own) {
  const has = (kind) => sorted.some((properties) => kindOf(properties) === kind)
  const window = `the last ${daysText(listDays)}`
  lists.own.note.textContent = own.whole
    ? 'Its whole recording.'
    : own.answered && !has('own')
      ? 'Nothing recorded yet.'
      : has('own')
        ? `In ${window}.`
        : `None in ${window}.`
  const kept =
    retention === undefined
      ? ''
      : retention > 0
        ? ` The plugin keeps them ${daysText(retention)}.`
        : ' The plugin keeps them indefinitely.'
  lists.others.note.textContent = has('others') ? `In ${window}.${kept}` : `None in ${window}.${kept}`
  lists.imported.note.textContent = has('imported') ? 'Kept until deleted, however old.' : 'No imported tracks.'
}

/** How many days the plugin keeps other vessels, 0 for indefinitely, or undefined when it does not say. */
async function retention(signal) {
  try {
    const response = await fetch(SETTINGS_URL, { credentials: 'include', signal })
    const body = response.ok ? await response.json() : undefined
    const days = body?.aisRetentionDays
    return Number.isFinite(days) && days >= 0 ? days : undefined
  } catch {
    return undefined
  }
}

/** The own vessel's listed tracks, or undefined when that request fails: the whole list reports it. */
async function ownTracks(signal) {
  try {
    const response = await fetch(OWN_TRACKS_URL, { credentials: 'include', signal })
    const body = response.ok ? await response.json() : undefined
    return body?.type === 'FeatureCollection' && Array.isArray(body.features)
      ? body.features.map((feature) => feature?.properties)
      : undefined
  } catch {
    return undefined
  }
}

async function load() {
  // Bounded, because an unsettled fetch is the one failure the page cannot
  // recover from: every other path ends in an error message, while a stalled
  // server or proxy leaves it on "Loading…" indefinitely, which reads as a
  // hang rather than a failure. The signal stays armed through json() below,
  // so a response that stops mid-body is caught too.
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  // A month of AIS traffic can keep a busy store for a while: the wait counts
  // up, and the own vessel's tracks show as soon as they are in.
  const started = Date.now()
  let waiting = 'Loading…'
  const tick = () => show(`${waiting} ${Math.round((Date.now() - started) / 1000)} s`)
  const ticker = setInterval(tick, 1000)
  // The status is a live region: busy while it counts, so a screen reader
  // announces where the wait ended rather than every second of it.
  status.setAttribute('aria-busy', 'true')
  // Beside the own vessel's tracks: it asks the plugin, not the store.
  const kept = retention(AbortSignal.timeout(OWN_WAIT_MS))
  try {
    // The others are asked for once this settles, not beside it: the store
    // answers one query at a time, so asked together the own vessel's would
    // wait behind the very traffic it is meant to show before. Its shorter
    // timer starts with the deadline, so it ends inside it, and a request
    // stalled on its way cannot take the list's time with it.
    const own = await ownTracks(AbortSignal.timeout(OWN_WAIT_MS))
    if (own?.some(listable)) {
      draw(own)
      waiting = 'Loading the other vessels…'
      tick()
    }
    const days = await kept
    listDays = days > 0 ? days : LIST_DAYS
    await list(deadline, own, days)
  } finally {
    clearInterval(ticker)
    status.setAttribute('aria-busy', 'false')
  }
}

async function list(deadline, own, retention) {
  const imports = allImports(deadline)
  let response
  try {
    response = await fetch(tracksUrl(listDays), { credentials: 'include', signal: deadline })
  } catch {
    show(deadline.aborted ? 'The server did not answer in time.' : 'Could not reach the server.', 'error')
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
    // body that stops mid-stream, which the deadline above aborts here rather
    // than at the fetch. Without this the rejection escapes `void load()` and
    // the page sits on "Loading…" forever, which looks like a hang.
    show(
      deadline.aborted ? 'The server did not answer in time.' : 'The server sent a response this page could not read.',
      'error',
    )
    return
  }
  // A 200 carrying something else entirely -- an error object, a login page --
  // is a failure, not an empty list. Reporting "no tracks" for it would tell
  // the user the opposite of what happened.
  if (body?.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
    show('The server sent a response this page could not read.', 'error')
    return
  }
  // The own vessel's whole recording came with its own request, so the list's
  // window of it is left out, unless that request found nothing.
  const whole = (own ?? []).some((properties) => listable(properties) && kindOf(properties) === 'own')
  const seen = new Set()
  // An import of the own vessel can come with both requests; shown once. Told
  // apart by provider too, since two providers can give a track the same id.
  const listed = [
    ...(own ?? []).filter(listable),
    ...body.features
      .map((feature) => feature?.properties)
      .filter((properties) => !whole || !properties || kindOf(properties) !== 'own'),
  ].filter((properties) => {
    const id = localId(properties)
    if (typeof id !== 'string') return true
    const key = `${properties.providerId ?? ''}:${id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const ids = new Set(listed.map(localId))
  const unlisted = (await imports).filter((properties) => !ids.has(localId(properties)))
  // A server older than the Track API's write routes names tracks without
  // their provider and cannot delete by id, so the imports added here follow
  // suit there rather than offer a delete that cannot work.
  const older = (await namesByProvider(listed, unlisted, deadline))
    ? unlisted
    : unlisted.map((properties) => ({ ...properties, id: localId(properties), providerId: undefined }))
  describe(draw([...listed, ...older]), retention, { whole, answered: own !== undefined })
  show('')
  status.hidden = true
}

void load()
