/**
 * Deleting tracks, and the recycle bin they go to.
 *
 * Deletes go through the v2 Track API, like every other client's; the bin is
 * this plugin's own, under its router at /plugins/tracks, since the Track API
 * has no restore. Both need an administrator, which the server enforces.
 *
 * Everything that touches the page runs from `start()`, so the pure helpers
 * can be imported and tested without a document.
 */

/** Relative, because the server mounts this page under /@signalk/tracks-plugin. */
const TRACKS_URL = '../../signalk/v2/api/tracks'
const BIN_URL = '../../plugins/tracks/recycle-bin'

/** The label for a track, matching `trackLabel()` on the server and `label()` in tracks.js. */
export function label({ context, contextName, isSelf }) {
  if (isSelf) {
    return 'Own Ship'
  }
  if (contextName) {
    return `AIS ${contextName}`
  }
  const mmsi = /urn:mrn:imo:mmsi:(\d+)$/.exec(context ?? '')
  return mmsi ? `AIS ${mmsi[1]}` : (context ?? 'No vessel')
}

/** What a bin entry deleted, in the viewer's locale and zone. */
export function deletedPart({ whole, from, to }) {
  if (whole) {
    return 'The whole track'
  }
  if (from === undefined) {
    return `Everything up to ${when(to)}`
  }
  if (to === undefined) {
    return `Everything from ${when(from)}`
  }
  return `${when(from)} to ${when(to)}`
}

/**
 * The query string for a delete of part of a track, from two `datetime-local`
 * values; undefined when neither is set.
 *
 * The inputs show whole seconds, so `to` reaches the end of its second: a
 * track ending at 12:00:00.5 shows as ending at 12:00:00, and a span "to
 * 12:00:00" taken literally would keep the last point the user meant to
 * delete.
 */
export function spanQuery(from, to) {
  const params = new URLSearchParams()
  if (from) params.set('from', new Date(from).toISOString())
  if (to) params.set('to', new Date(new Date(to).getTime() + 999).toISOString())
  const query = params.toString()
  return query ? `?${query}` : undefined
}

/** An ISO time as a `datetime-local` value, in the viewer's zone. */
export function localInput(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) {
    return ''
  }
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  )
}

/** Why a request was refused, in words a user can act on. */
export function refusal(status) {
  if (status === 401 || status === 403) {
    return 'This needs an administrator login.'
  }
  if (status === 404) {
    return 'It is no longer there.'
  }
  if (status === 501) {
    return 'The track provider cannot do this.'
  }
  return `The server answered ${status}.`
}

function when(iso) {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString()
}

async function messageOf(response) {
  try {
    const body = await response.json()
    return body?.error ?? body?.message
  } catch {
    return undefined
  }
}

function start() {
  const dialog = document.getElementById('delete-dialog')
  const form = dialog.querySelector('form')
  const error = document.getElementById('delete-error')
  const binStatus = document.getElementById('bin-status')
  const binTable = document.getElementById('bin-table')
  const binBody = binTable.querySelector('tbody')
  let target

  document.addEventListener('tracks:delete', (event) => {
    target = event.detail
    document.getElementById('delete-title').textContent = `Delete ${target.label}${
      target.name ? ` (imported: ${target.name})` : ''
    }`
    // A recording goes on after it is deleted: what is recorded next is a new
    // track, so "whole" means up to now, and saying so avoids a surprise.
    document.getElementById('delete-whole').textContent = target.id.startsWith(`${target.providerId}:recorded:`)
      ? 'The whole track, up to now'
      : 'The whole track'
    form.elements.scope.value = 'whole'
    form.elements.from.value = localInput(target.from)
    form.elements.to.value = localInput(target.to)
    // A track without times has no part to address by time.
    for (const input of form.querySelectorAll('[value="span"], .span input')) {
      input.disabled = target.from === undefined
    }
    error.hidden = true
    dialog.showModal()
  })

  form.addEventListener('submit', async (event) => {
    if (event.submitter?.value !== 'delete') {
      return
    }
    event.preventDefault()
    const { scope, from, to } = form.elements
    let query = ''
    if (scope.value === 'span') {
      // Without a bound the request would delete the whole track, which is
      // not what choosing a part asked for.
      const span = spanQuery(from.value, to.value)
      if (span === undefined) {
        error.textContent = 'Give the time the part starts, ends, or both.'
        error.hidden = false
        return
      }
      query = span
    }
    // The server hands out ids already qualified by their provider.
    const id = encodeURIComponent(target.id)
    const url = `${TRACKS_URL}/${id}${query}`
    let response
    try {
      response = await fetch(url, { method: 'DELETE', credentials: 'include' })
    } catch {
      error.textContent = 'Could not reach the server.'
      error.hidden = false
      return
    }
    if (!response.ok) {
      error.textContent = (await messageOf(response)) ?? refusal(response.status)
      error.hidden = false
      return
    }
    dialog.close()
    location.reload()
  })

  async function act(url, method) {
    let response
    try {
      response = await fetch(url, { method, credentials: 'include' })
    } catch {
      showBin('Could not reach the server.', 'error')
      return
    }
    if (!response.ok) {
      showBin((await messageOf(response)) ?? refusal(response.status), 'error')
      return
    }
    location.reload()
  }

  function showBin(message, state) {
    binStatus.textContent = message
    if (state) {
      binStatus.dataset.state = state
    } else {
      delete binStatus.dataset.state
    }
  }

  function cell(text, className) {
    const td = document.createElement('td')
    td.textContent = String(text)
    if (className) td.className = className
    return td
  }

  function button(text, onClick, className) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    if (className) b.className = className
    b.addEventListener('click', onClick)
    return b
  }

  function binRow(entry) {
    const tr = document.createElement('tr')
    const name = cell(label(entry))
    if (entry.name) {
      const imported = document.createElement('span')
      imported.className = 'imported'
      imported.textContent = ` (imported: ${entry.name})`
      name.append(imported)
    }
    const actions = document.createElement('td')
    const buttons = document.createElement('div')
    buttons.className = 'actions'
    actions.append(buttons)
    buttons.append(
      button('Restore', () => act(`${BIN_URL}/${entry.id}/restore`, 'POST')),
      button(
        'Delete now',
        () => {
          if (confirm('Delete this for good? It cannot be restored afterwards.')) {
            void act(`${BIN_URL}/${entry.id}`, 'DELETE')
          }
        },
        'danger',
      ),
    )
    tr.append(
      name,
      cell(deletedPart(entry)),
      cell(when(entry.deletedAt)),
      cell(when(entry.purgeAt)),
      cell(entry.pointCount, 'num'),
      actions,
    )
    return tr
  }

  async function loadBin() {
    let response
    try {
      response = await fetch(BIN_URL, { credentials: 'include', signal: AbortSignal.timeout(30_000) })
    } catch {
      showBin('Could not reach the server.', 'error')
      return
    }
    if (!response.ok) {
      showBin(
        response.status === 401 || response.status === 403
          ? 'Sign in as an administrator to see the recycle bin.'
          : refusal(response.status),
        'error',
      )
      return
    }
    let entries
    try {
      entries = await response.json()
    } catch {
      entries = undefined
    }
    if (!Array.isArray(entries)) {
      showBin('The server sent a response this page could not read.', 'error')
      return
    }
    if (entries.length === 0) {
      showBin('The recycle bin is empty.')
      return
    }
    binBody.replaceChildren(...entries.map(binRow))
    binTable.hidden = false
    showBin(`${entries.length} deleted track${entries.length === 1 ? '' : 's'} or parts, newest first.`)
  }

  void loadBin()
}

if (typeof document !== 'undefined') {
  start()
}
