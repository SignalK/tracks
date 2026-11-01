/** The page's element with this id, which index.html carries: one missing is a broken page, not a case to handle. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element === null) {
    throw new Error(`#${id} is missing from the page`)
  }
  return element as T
}

/** The first element in `parent` matching `selector`, which index.html carries. */
export function within<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector)
  if (element === null) {
    throw new Error(`${selector} is missing from the page`)
  }
  return element
}
