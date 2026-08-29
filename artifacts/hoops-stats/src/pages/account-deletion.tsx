import { useEffect } from "react";

const PAGE_TITLE = "Account Deletion | StecStats";
const PAGE_DESCRIPTION =
  "Learn how to permanently delete your StecStats account, what data is removed, retention timelines, subscription cancellation, and support options.";
const PAGE_URL = "https://stecstats.com/account-deletion";

export default function AccountDeletion() {
  useEffect(() => {
    const previousTitle = document.title;
    const previousDescription = document.querySelector('meta[name="description"]')?.getAttribute("content") ?? undefined;
    const previousOgTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? undefined;
    const previousOgDescription = document.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? undefined;
    const previousOgUrl = document.querySelector('meta[property="og:url"]')?.getAttribute("content") ?? undefined;
    const previousCanonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined;

    document.title = PAGE_TITLE;

    const setMeta = (selector: string, attribute: "name" | "property", key: string, content: string) => {
      let element = document.querySelector<HTMLMetaElement>(selector);
      if (!element) {
        element = document.createElement("meta");
        element.setAttribute(attribute, key);
        document.head.appendChild(element);
      }
      element.setAttribute("content", content);
    };

    setMeta('meta[name="description"]', "name", "description", PAGE_DESCRIPTION);
    setMeta('meta[property="og:title"]', "property", "og:title", PAGE_TITLE);
    setMeta('meta[property="og:description"]', "property", "og:description", PAGE_DESCRIPTION);
    setMeta('meta[property="og:url"]', "property", "og:url", PAGE_URL);

    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = PAGE_URL;

    return () => {
      document.title = previousTitle;
      const restoreMeta = (selector: string, content: string | undefined) => {
        const element = document.querySelector(selector);
        if (element && content !== undefined) element.setAttribute("content", content);
      };
      restoreMeta('meta[name="description"]', previousDescription);
      restoreMeta('meta[property="og:title"]', previousOgTitle);
      restoreMeta('meta[property="og:description"]', previousOgDescription);
      restoreMeta('meta[property="og:url"]', previousOgUrl);
      if (canonical && previousCanonical === undefined) canonical.remove();
      else if (canonical && previousCanonical !== undefined) canonical.href = previousCanonical;
    };
  }, []);

  return (
    <main className="min-h-[100dvh] bg-background text-foreground">
      <article className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-10">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-primary mb-3">Account & privacy</p>
          <h1 className="text-4xl md:text-5xl font-display font-bold uppercase leading-tight text-secondary mb-4">
            Account Deletion
          </h1>
          <p className="text-muted-foreground text-sm">
            Effective date: August 29, 2026
          </p>
        </div>

        <div className="prose prose-invert prose-sm max-w-none space-y-8 text-muted-foreground leading-relaxed">
          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">
              Delete your StecStats account
            </h2>
            <p>
              You can permanently delete your StecStats account from inside the mobile app
              without contacting support. Sign in, open <strong className="text-foreground">Profile</strong>,
              scroll to the <strong className="text-foreground">Account</strong> section, tap{" "}
              <strong className="text-foreground">Delete Account</strong>, and confirm both deletion prompts.
              The app signs you out and returns you to the welcome screen when the deletion request is complete.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">
              What we delete
            </h2>
            <p className="mb-3">
              A confirmed deletion permanently removes the StecStats account and the data associated with it,
              including:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Your StecStats profile and sign-in identity</li>
              <li>Teams, roster players, player photos, statistics, and game records</li>
              <li>Recorded game footage, saved media, and generated highlight or lowlight clips</li>
              <li>Live-stream session data and connected YouTube authorization</li>
            </ul>
            <p className="mt-3">
              Videos that you separately published to your own YouTube channel are not controlled by
              StecStats and are not deleted from YouTube. Delete those videos directly in YouTube.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">
              Retention and deletion timing
            </h2>
            <p>
              Deletion starts after you confirm the final prompt. We delete personal data and associated
              content from our active systems within 30 days. Encrypted backup copies of game media may
              remain for up to 90 days before they are automatically purged; they are not used to provide
              the Service during that period. We may retain only the limited information required by law,
              such as accounting or fraud-prevention records, for the period required by that obligation.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">
              Subscriptions are separate
            </h2>
            <p>
              Deleting your StecStats account does <strong className="text-foreground">not</strong> cancel
              an Apple subscription and does not request a refund. To stop future Apple subscription
              charges, open your Apple Account settings, select Subscriptions, choose StecStats, and
              cancel it there. Subscription billing and refunds are handled by Apple.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">
              Need help?
            </h2>
            <p>
              If you cannot sign in or cannot complete the in-app deletion flow, contact{" "}
              <a href="mailto:support@stecstats.com" className="text-primary hover:underline">
                support@stecstats.com
              </a>{" "}
              from the email address associated with your account. We can help verify the request and
              respond within one business day.
            </p>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-border flex flex-wrap gap-x-6 gap-y-3">
          <a href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            ← Back to StecStats
          </a>
          <a href="/privacy" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Privacy Policy
          </a>
          <a href="/terms" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Terms of Service
          </a>
        </div>
      </article>
    </main>
  );
}