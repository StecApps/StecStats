/**
 * YouTube is an optional distribution channel. Daily owns the coach's camera,
 * StecStats viewer, and cloud recording even if this relay is not configured.
 */
export async function startOptionalYoutubeRelay(
  apiBase: string,
  code: string,
  getToken: () => Promise<string | null>,
): Promise<{ distributed: boolean; warning?: string }> {
  try {
    const token = await getToken();
    const response = await fetch(
      `${apiBase}/api/live/${encodeURIComponent(code)}/youtube/start`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (response.ok) return { distributed: true };
    const payload = await response.json().catch(() => ({})) as { code?: string; error?: string };
    // Ordinary customers never need to connect their own YouTube account.
    if (payload.code === 'YOUTUBE_NOT_CONNECTED') return { distributed: false };
    const detail = payload.code === 'YOUTUBE_RECONNECT_REQUIRED'
      ? 'Reconnect the optional YouTube channel in Profile.'
      : payload.code === 'YOUTUBE_LIVE_NOT_ENABLED'
        ? 'Enable YouTube Live for the connected channel. First activation may take up to 24 hours.'
        : payload.error ?? `YouTube relay returned HTTP ${response.status}.`;
    return { distributed: false, warning: detail };
  } catch (error) {
    return {
      distributed: false,
      warning: error instanceof Error ? error.message : 'YouTube relay could not be reached.',
    };
  }
}