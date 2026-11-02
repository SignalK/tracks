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
import { errorName, messageOf, refusal } from './bin.js'
import { byId, within } from './dom.js'

/** The word typed to confirm, which the route asks for too. */
export const CONFIRMATION = 'DELETE'

/** Relative, because the server mounts this page under /@signalk/tracks-plugin. */
const DATABASE_URL = `../../plugins/tracks/database?confirm=${CONFIRMATION}`

/**
 * How long the dialog waits for the delete. The plugin stops, removes the
 * file and starts again, which takes seconds; past this the answer is not
 * coming, and the dialog must not stay locked open.
 */
const DELETE_WAIT_MS = 60_000

/** Spaces around the word are forgiven, its case is not. */
export function confirmed(typed: string): boolean {
  return typed.trim() === CONFIRMATION
}

export function start(): void {
  const open = byId('reset-open')
  const dialog = byId<HTMLDialogElement>('reset-dialog')
  const form = within<HTMLFormElement>(dialog, 'form')
  const button = within<HTMLButtonElement>(form, 'button[value="reset"]')
  // Not a submit button: Enter in the field submits with the form's first
  // one, and a Cancel there would close the dialog on the word just typed.
  const cancel = within<HTMLButtonElement>(form, 'button[value="cancel"]')
  const error = byId('reset-error')
  const { confirm } = form.elements as HTMLFormControlsCollection & { confirm: HTMLInputElement }
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
  cancel.addEventListener('click', () => {
    if (!pending) {
      dialog.close()
    }
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (pending || !confirmed(confirm.value)) {
      return
    }
    pending = true
    button.disabled = true
    let response
    try {
      response = await fetch(DATABASE_URL, {
        method: 'DELETE',
        credentials: 'include',
        signal: AbortSignal.timeout(DELETE_WAIT_MS),
      })
    } catch (failure) {
      // Not asked again, and not with one click either: the request may have
      // got through, the server may still finish the delete, and a second
      // would take what it has recorded since.
      confirm.value = ''
      fail(
        errorName(failure) === 'TimeoutError'
          ? 'The server did not answer. The database may still have been deleted: reload the page to see.'
          : 'The connection failed. The database may still have been deleted: reload the page to see.',
      )
      return
    }
    if (!response.ok) {
      // A proxy's answer, not the plugin's: the delete may have gone through.
      if (response.status >= 502 && response.status <= 504) {
        confirm.value = ''
      }
      fail((await messageOf(response)) ?? refusal(response.status))
      return
    }
    dialog.close()
    location.reload()
  })

  function fail(message: string): void {
    error.textContent = message
    error.hidden = false
    pending = false
    button.disabled = !confirmed(confirm.value)
  }
}

if (typeof document !== 'undefined') {
  start()
}
