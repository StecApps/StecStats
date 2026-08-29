export default function PrivacyPolicy() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="mb-10">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-primary mb-3">Legal</p>
          <h1 className="text-4xl md:text-5xl font-display font-bold uppercase leading-tight text-secondary mb-4">
            Privacy Policy
          </h1>
          <p className="text-muted-foreground text-sm">
            Effective date: January 1, 2025 · Last updated: June 1, 2025
          </p>
        </div>

        <div className="prose prose-invert prose-sm max-w-none space-y-8 text-muted-foreground leading-relaxed">

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">1. Who We Are</h2>
            <p>
              StecStats ("we," "us," or "our") operates the StecStats mobile application and website
              at <a href="https://stecstats.com" className="text-primary hover:underline">stecstats.com</a> (the
              "Service"). We are committed to protecting the personal information of coaches, parents, and athletes who
              use our platform to track basketball statistics and game footage.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">2. Information We Collect</h2>
            <p className="mb-3">We collect the following categories of information:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong className="text-foreground">Account information:</strong> Your email address and any name
                you provide when creating an account.
              </li>
              <li>
                <strong className="text-foreground">Player and team data:</strong> Names, positions, statistics, and
                game records you enter for players on your roster.
              </li>
              <li>
                <strong className="text-foreground">Game footage and media:</strong> Video recordings you capture
                through the app, highlight clips, and player photos you upload.
              </li>
              <li>
                <strong className="text-foreground">Usage data:</strong> Log data, device type, operating system
                version, app version, and general usage patterns (such as which features you use).
              </li>
              <li>
                <strong className="text-foreground">Payment information:</strong> Subscription purchases are processed
                through Apple App Store, Google Play, or Stripe. We do not store your full payment card details.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">3. How We Use Your Information</h2>
            <p className="mb-3">We use the information we collect to:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Provide, operate, and improve the Service</li>
              <li>Authenticate your account and maintain your session</li>
              <li>Store and display player statistics, game records, and video content</li>
              <li>Enable live streaming to viewers you invite</li>
              <li>Generate highlight reels and statistical summaries</li>
              <li>Process subscription payments and manage your billing</li>
              <li>Send transactional emails (account verification, receipts)</li>
              <li>Respond to your support requests</li>
            </ul>
            <p className="mt-3">
              We do not sell your personal information to third parties. We do not use your data for
              advertising profiling.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">4. Children's Privacy</h2>
            <p>
              The Service is directed at coaches and parents (adults) who track youth athletes. We do
              not knowingly collect personal information directly from children under 13. Player profiles
              (name, statistics, photos) are entered and controlled by the adult coach or parent who
              created the account. If you believe we have inadvertently collected information from a
              child under 13 without parental consent, please contact us immediately at{" "}
              <a href="mailto:support@stecstats.com" className="text-primary hover:underline">support@stecstats.com</a>{" "}
              and we will delete it promptly.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">5. Data Sharing</h2>
            <p className="mb-3">We share data only in the following limited circumstances:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong className="text-foreground">Service providers:</strong> We use third-party services
                to operate the platform, including Clerk (authentication), Stripe and RevenueCat (payments),
                Google Cloud Storage (media storage), and Metered.ca (video relay). Each provider has their
                own privacy policy and processes data only as needed to provide their service.
              </li>
              <li>
                <strong className="text-foreground">Invited viewers:</strong> When you start a live stream,
                people you invite can view the game footage and live score for the duration of the stream.
                They do not receive access to your account or any other data.
              </li>
              <li>
                <strong className="text-foreground">Legal requirements:</strong> We may disclose information
                if required to do so by law or in the good-faith belief that such action is necessary to
                comply with legal obligations.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">6. Data Storage and Security</h2>
            <p>
              Your data is stored on servers in the United States. We use industry-standard security
              measures including HTTPS encryption in transit and encrypted storage at rest. We limit
              access to personal data to employees and contractors who need it to operate the Service.
              No method of transmission over the internet is 100% secure; we cannot guarantee absolute
              security but take commercially reasonable precautions.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">7. Data Retention</h2>
            <p>
              We retain your account and associated data for as long as your account is active. If you
              delete your account, we will delete your personal data within 30 days, except where we
              are required to retain it for legal or accounting purposes. Game footage stored in cloud
              storage may take up to 90 days to be fully purged from backup systems.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">8. Your Rights</h2>
            <p className="mb-3">You have the right to:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong className="text-foreground">Access</strong> the personal data we hold about you</li>
              <li><strong className="text-foreground">Correct</strong> inaccurate data</li>
              <li><strong className="text-foreground">Delete</strong> your account and associated data</li>
              <li><strong className="text-foreground">Export</strong> your data in a portable format</li>
              <li><strong className="text-foreground">Opt out</strong> of non-essential communications</li>
            </ul>
            <p className="mt-3">
              To exercise any of these rights, email us at{" "}
              <a href="mailto:support@stecstats.com" className="text-primary hover:underline">support@stecstats.com</a>.
              We will respond within 30 days.
            </p>
            <p className="mt-3">
              For step-by-step account deletion instructions, visit our{" "}
              <a href="/account-deletion" className="text-primary hover:underline">Account Deletion page</a>.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">9. Cookies and Tracking</h2>
            <p>
              Our website uses essential cookies required for authentication and session management. We
              do not use third-party advertising cookies or tracking pixels. The mobile app does not use
              cookies. We may collect anonymous aggregate analytics to understand how the Service is used
              (such as which screens are most visited), but this data is not linked to your identity.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">10. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify you of material changes
              by posting the new policy on this page with an updated effective date. Continued use of
              the Service after changes are posted constitutes your acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">11. Contact Us</h2>
            <p>
              If you have questions about this Privacy Policy or our data practices, please contact us:
            </p>
            <div className="mt-3 p-4 rounded-lg bg-card border border-border text-sm">
              <p className="text-foreground font-medium mb-1">StecStats</p>
              <p>
                Email:{" "}
                <a href="mailto:support@stecstats.com" className="text-primary hover:underline">
                  support@stecstats.com
                </a>
              </p>
              <p>
                Website:{" "}
                <a href="https://stecstats.com" className="text-primary hover:underline">
                  stecstats.com
                </a>
              </p>
            </div>
          </section>
        </div>

        <div className="mt-12 pt-8 border-t border-border">
          <a href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            ← Back to StecStats
          </a>
        </div>
      </div>
    </div>
  );
}
