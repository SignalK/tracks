import type { Context } from './types.js'

/**
 * Watches which `$source` each context's positions arrive from.
 *
 * `navigation.position` is a rapid update — a GPS may report at 10Hz — and a
 * typical boat has several receivers: an internal GPS, an AIS transponder, a
 * chart plotter echoing its own fix. Signal K resolves which one *wins* per
 * path through source priority, but the streambundle bus this plugin listens
 * on carries every source's values, not just the winner.
 *
 * Recording all of them interleaves fixes from receivers metres apart, so the
 * track zigzags between them rather than following the boat. The fix is to
 * configure source priority for `navigation.position`; this watcher exists to
 * say so, because the symptom (a track that looks noisy) does not obviously
 * point at the cause.
 *
 * Detection is empirical rather than reading the server's priority config:
 * what matters is what actually arrives, and a priority rule that exists but
 * does not match still produces multiple sources here.
 */
export class SourceWatch {
  private readonly seen = new Map<Context, Set<string>>()

  /** Record that `context` produced a position from `$source`. */
  add(context: Context, source: string | undefined): void {
    if (!source) {
      return
    }
    let sources = this.seen.get(context)
    if (!sources) {
      sources = new Set()
      this.seen.set(context, sources)
    }
    sources.add(source)
  }

  /** Sources seen for a context, in the order they first appeared. */
  sourcesFor(context: Context): string[] {
    return [...(this.seen.get(context) ?? [])]
  }

  /** Contexts receiving positions from more than one source. */
  conflicted(): Context[] {
    return [...this.seen.entries()].filter(([, sources]) => sources.size > 1).map(([context]) => context)
  }

  /**
   * A status line naming the problem, or undefined when nothing is wrong.
   *
   * `selfContext` is called out by name because the own vessel's track is the
   * one a user looks at, and it is the one whose priority they can fix. Other
   * vessels are usually AIS, where multiple receivers are expected and less
   * worth nagging about — they are counted, not named.
   */
  warning(selfContext?: Context): string | undefined {
    const conflicted = this.conflicted()
    if (conflicted.length === 0) {
      return undefined
    }
    const selfConflicted = selfContext !== undefined && conflicted.includes(selfContext)
    const others = conflicted.length - (selfConflicted ? 1 : 0)

    if (selfConflicted) {
      const sources = this.sourcesFor(selfContext).join(', ')
      const tail = others > 0 ? ` (and ${others} other ${others === 1 ? 'vessel' : 'vessels'})` : ''
      return (
        `navigation.position for the own vessel is arriving from ${this.sourcesFor(selfContext).length} sources ` +
        `(${sources})${tail}. Set source priority for navigation.position, or the track will zigzag between them.`
      )
    }
    return `navigation.position is arriving from multiple sources for ${others} ${others === 1 ? 'vessel' : 'vessels'}.`
  }

  /** Forget everything seen; used when the plugin restarts. */
  clear(): void {
    this.seen.clear()
  }
}
