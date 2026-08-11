/**
 * Minimal Expo Push Notification sender.
 *
 * Sends a single notification via Expo's hosted push service
 * (https://exp.host/--/api/v2/push/send). No SDK required — plain fetch.
 *
 * Tokens must start with "ExponentPushToken[...]". Tokens from other providers
 * (FCM direct, APNs direct) are not supported by this utility.
 */

import { logger } from "./logger";

export interface ExpoPushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
  channelId?: string;
}

/**
 * Send a push notification to a single Expo push token.
 * Never throws — logs a warning and returns on failure so callers don't
 * need try/catch for what is always a best-effort notification.
 */
export async function sendExpoPush(
  pushToken: string,
  message: ExpoPushMessage,
): Promise<void> {
  if (!pushToken.startsWith("ExponentPushToken[")) {
    logger.warn({ pushToken }, "Invalid Expo push token format — skipping notification");
    return;
  }

  try {
    const payload = {
      to: pushToken,
      title: message.title,
      body: message.body,
      data: message.data ?? {},
      sound: message.sound ?? "default",
      ...(message.badge !== undefined ? { badge: message.badge } : {}),
      ...(message.channelId ? { channelId: message.channelId } : {}),
    };

    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      logger.warn({ status: response.status, body: text }, "Expo push send failed");
      return;
    }

    const json = (await response.json()) as { data?: { status: string; message?: string } };
    const status = json?.data?.status;
    if (status && status !== "ok") {
      logger.warn({ status, message: json?.data?.message }, "Expo push delivery issue");
    } else {
      logger.info({ pushToken: pushToken.slice(0, 30) + "…" }, "Expo push notification sent");
    }
  } catch (err) {
    logger.warn({ err }, "Expo push send threw — notification skipped");
  }
}
