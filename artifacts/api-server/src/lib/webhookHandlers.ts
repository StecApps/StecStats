import { getStripeSync } from "./stripeClient";

/**
 * Minimal webhook entrypoint. All subscription/customer state lives in the
 * `stripe.*` schema that stripe-replit-sync manages — this handler's only
 * job is to hand the raw payload + signature to processWebhook() so that
 * schema stays in sync. This is the source of truth for plan entitlements;
 * never infer plan state from a client-side checkout redirect.
 */
export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "STRIPE WEBHOOK ERROR: Payload must be a Buffer. " +
          "Received type: " +
          typeof payload +
          ". " +
          "This usually means express.json() parsed the body before reaching this handler. " +
          "FIX: Ensure webhook route is registered BEFORE app.use(express.json()).",
      );
    }

    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);
  }
}
