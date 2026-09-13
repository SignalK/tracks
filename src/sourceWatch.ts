import type { Context } from './types.js'

/**
 * Watches which `$source` each context's positions arrive from.
 *
 * `navigation.position` is a rapid update — a GPS may report at 10Hz — and a
 * typical boat has several receivers: an internal GPS, an AIS transponder, a
 * chart plotter echoing its own fix.
 *
 * Signal K resolves which one wins through source priority, and the bus this
 * plugin listens on is the filtered one: the server applies `toPreferredDelta`
 * before emitting `delta`, which is what feeds `getBus()`. So with a priority
 * rule in place, only the winner arrives and there is nothing to warn about.
 *
 * The gap is when no rule *matches* the path. Then the engine passes every
 * source through, the fixes from receivers metres apart interleave, and the
 * track zigzags between them rather than following the boat. The fix is to
 * configure source priority for `navigation.position`; this watcher exists to
 * say so, because the symptom (a track that looks noisy) does not obviously
 * point at the cause.
 *
 * Detection is therefore empirical rather than reading the priority config:
 * seeing several sources here *is* the evidence that no rule is matching,
 * which a config that merely exists would not tell us.
 *
 * With one qualification. A priority rule has a failover window — when the
 * top-ranked source goes quiet the engine promotes the next one — so over a
 * long run several sources legitimately reach this bus even with a rule in
 * place, one at a time. Counting every source ever seen would therefore
 * report a conflict on a correctly configured boat whose GPS drops out
 * occasionally. What distinguishes competition is *alternation*: unfiltered
 * sources hand back and forth repeatedly within seconds, while a failover
 * switches once and stays.
 */

/**
 * How quickly the source must change again for it to count as alternation.
 *
 * Shorter than the server's 15s default failover, so a promotion — one
 * switch after a silence — never chains into a sequence. Positions are a
 * rapid update, often 10Hz, so genuinely competing sources alternate far
 * faster than this.
 */
const ALTERNATION_WINDOW_MS = 10 * 1000

/**
 * How long a conflict is remembered after it was last observed.
 *
 * Longer than the 30s status tick, so a conflict seen just after one tick is
 * still reported at the next and does not flicker. Finite, so fixing the
 * priorities clears the warning on its own rather than needing a restart —
 * which is the whole complaint about a watcher that only ever accumulates.
 */
const CONFLICT_RETENTION_MS = 90 * 1000

/**
 * How many source changes in a row before it counts as competition.
 *
 * One change is a failover, two is a failback — the preferred source
 * returning and winning immediately, which the server does on purpose. Three
 * means the sources are trading the path back and forth, which no priority
 * rule does.
 */
const CHANGES_BEFORE_WARNING = 3

export class SourceWatch {
  /** Last time each source produced a position, per context. */
  private readonly seen = new Map<Context, Map<string, number>>()
  /** Sources found competing, per context, with when each was last seen so. */
  private readonly competing = new Map<Context, Map<string, number>>()
  /** The current alternation per context: who is in it, and how long it is. */
  private readonly lastSeen = new Map<
    Context,
    { source: string; at: number; changedAt: number; changes: number; participants: Set<string> }
  >()

  /** Record that `context` produced a position from `$source`. */
  add(context: Context, source: string | undefined, now: number = Date.now()): void {
    if (!source) {
      return
    }
    let sources = this.seen.get(context)
    if (!sources) {
      sources = new Map()
      this.seen.set(context, sources)
    }
    // Counted per *change* of source, not per overlapping report: a recovered
    // source reporting repeatedly is one transition, however many fixes it
    // sends. Judged as positions arrive rather than when the status is
    // published, which is up to 30s later.
    const previous = this.lastSeen.get(context)
    // Recorded before the conflict below reads each participant's last-seen
    // time: a source returning after a long silence would otherwise be filed
    // with its old timestamp and expire immediately.
    sources.set(source, now)
    // Timed from the last *change*, not the last report: repeated fixes from
    // the winner are the healthy state and neither advance the sequence nor
    // end it, while a run of them long enough to pass the window does.
    const stale = !previous || now - previous.changedAt > ALTERNATION_WINDOW_MS
    if (stale || previous.source === source) {
      this.lastSeen.set(context, {
        source,
        at: now,
        changedAt: stale ? now : previous.changedAt,
        changes: stale ? 0 : previous.changes,
        participants: stale ? new Set([source]) : previous.participants,
      })
    } else {
      const changes = previous.changes + 1
      const participants = previous.participants.add(source)
      this.lastSeen.set(context, { source, at: now, changedAt: now, changes, participants })
      if (changes >= CHANGES_BEFORE_WARNING) {
        // Every source in the alternation, not just the last pair: three
        // receivers trading a path is one conflict, and naming two of them
        // sends the user after the wrong hardware.
        const found = this.competing.get(context) ?? new Map<string, number>()
        for (const participant of participants) {
          // Each carries its own last-seen time, so one that drops out of the
          // alternation expires on schedule instead of being kept alive by
          // the others still trading.
          found.set(participant, sources.get(participant) ?? now)
        }
        this.competing.set(context, found)
      }
    }
  }

  /** Every source seen for a context, in the order they first appeared. */
  sourcesFor(context: Context): string[] {
    return [...(this.seen.get(context) ?? new Map<string, number>()).keys()]
  }

  /**
   * The sources found live at the same time, which is what a warning names.
   *
   * Expired entries are dropped rather than merely hidden, so a conflict that
   * has stopped recurring leaves nothing behind.
   */
  competingFor(context: Context, now: number = Date.now()): string[] {
    const found = this.competing.get(context)
    if (!found) {
      return []
    }
    for (const [source, at] of found) {
      if (now - at > CONFLICT_RETENTION_MS) {
        found.delete(source)
      }
    }
    // One source left is nobody to compete with.
    if (found.size < 2) {
      this.competing.delete(context)
      return []
    }
    return [...found.keys()]
  }

  /** Contexts that have received positions from two sources at once. */
  conflicted(now: number = Date.now()): Context[] {
    return [...this.competing.keys()].filter((context) => this.competingFor(context, now).length > 1)
  }

  /**
   * A status line naming the problem, or undefined when nothing is wrong.
   *
   * `selfContext` is called out by name because the own vessel's track is the
   * one a user looks at, and it is the one whose priority they can fix. Other
   * vessels are usually AIS, where multiple receivers are expected and less
   * worth nagging about — they are counted, not named.
   */
  warning(selfContext?: Context, now: number = Date.now()): string | undefined {
    const conflicted = this.conflicted(now)
    if (conflicted.length === 0) {
      return undefined
    }
    const selfConflicted = selfContext !== undefined && conflicted.includes(selfContext)
    const others = conflicted.length - (selfConflicted ? 1 : 0)

    if (selfConflicted) {
      const recent = this.competingFor(selfContext, now)
      const sources = recent.join(', ')
      const tail = others > 0 ? ` (and ${others} other ${others === 1 ? 'vessel' : 'vessels'})` : ''
      return (
        `navigation.position for the own vessel is arriving from ${recent.length} sources ` +
        `(${sources})${tail}. Set source priority for navigation.position, or the track will zigzag between them.`
      )
    }
    return `navigation.position is arriving from multiple sources for ${others} ${others === 1 ? 'vessel' : 'vessels'}.`
  }

  /** Forget everything seen; used when the plugin restarts. */
  clear(): void {
    this.seen.clear()
    this.competing.clear()
    this.lastSeen.clear()
  }
}
