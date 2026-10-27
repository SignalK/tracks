/**
 * Deleting the whole track database, for a store gone wrong past repair.
 *
 * Behind a dialog that says what goes and how to keep a copy first, and a word
 * typed out, since none of it can be undone. The server asks for an
 * administrator and for the same word (`DELETE /plugins/tracks/database`).
 *
 * Everything that touches the page runs from `start()`, so the helper can be
 * imported and tested without a document.
 */
import { messageOf, refusal } from './bin.js'

/** The word typed to confirm, which the route asks for too. */
export const CONFIRMATION = 'DELETE'

/** Relative, because the server mounts this page under /@signalk/tracks-plugin. */
const DATABASE_URL = `../../plugins/tracks/database?confirm=${CONFIRMATION}`

/** Whether what was typed confirms the delete. */
export function confirmed(typed) {
  return typed.trim() === CONFIRMATION
}

export function start() {
  const open = document.getElementById('reset-open')
  const dialog = document.getElementById('reset-dialog')
  const form = dialog.querySelector('form')
  const button = form.querySelector('button[value="reset"]')
  const error = document.getElementById('reset-error')
  const { confirm } = form.elements
  // Once: a second click while the first is on its way would ask again, and
  // its refusal would read as though the first had failed.
  let pending = false

  open.addEventListener('click', () => {
    confirm.value = ''
    button.disabled = true
    error.hidden = true
    dialog.showModal()
  })
  confirm.addEventListener('input', () => {
    button.disabled = pending || !confirmed(confirm.value)
  })
  // Open until the delete is answered: closed, the dialog would hide whether
  // it went through, and a refusal would land where nobody sees it.
  dialog.addEventListener('cancel', (event) => {
    if (pending) {
      event.preventDefault()
    }
  })

  form.addEventListener('submit', async (event) => {
    if (pending) {
      event.preventDefault()
      return
    }
    if (event.submitter?.value !== 'reset') {
      return
    }
    event.preventDefault()
    if (!confirmed(confirm.value)) {
      return
    }
    pending = true
    button.disabled = true
    let response
    try {
      response = await fetch(DATABASE_URL, { method: 'DELETE', credentials: 'include' })
    } catch {
      fail('Could not reach the server.')
      return
    }
    if (!response.ok) {
      fail((await messageOf(response)) ?? refusal(response.status))
      return
    }
    dialog.close()
    location.reload()
  })

  function fail(message) {
    error.textContent = message
    error.hidden = false
    pending = false
    button.disabled = !confirmed(confirm.value)
  }
}

if (typeof document !== 'undefined') {
  start()
}
