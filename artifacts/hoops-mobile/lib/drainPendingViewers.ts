/**
 * drainPendingViewers
 *
 * Offers a WebRTC peer connection to every viewer who arrived while the
 * broadcaster's camera stream was still opening (getUserMedia in-flight).
 *
 * The mobile broadcaster's WebRTC stream useEffect starts getUserMedia
 * asynchronously. A viewer's `new-viewer` signal may arrive during that
 * window. Rather than silently skipping those viewers, the `new-viewer`
 * handler pushes their IDs into `pendingIds`. Once getUserMedia resolves
 * successfully, this function is called to drain the queue.
 *
 * Design choices:
 *   - `pendingIds` is mutated in-place (splice) so the component ref is
 *     cleared atomically — a second call while the first is in-flight can't
 *     re-drain the same IDs.
 *   - Returns a promise so callers can await completion; errors from
 *     individual peer creations are swallowed (they are already console.warn'd
 *     by createPeerForViewer).
 */
export async function drainPendingViewers(
  pendingIds: string[],
  stream: any,
  createPeerForViewer: (viewerId: string) => Promise<void>,
): Promise<void> {
  if (!stream || pendingIds.length === 0) return;
  // Splice atomically so a concurrent new-viewer that fires before we finish
  // doesn't see a stale non-empty list and re-create the same peer.
  const ids = pendingIds.splice(0);
  await Promise.all(ids.map((id) => createPeerForViewer(id).catch(() => {})));
}
