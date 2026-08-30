export default function TermsOfService() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="mb-10">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-primary mb-3">Legal</p>
          <h1 className="text-4xl md:text-5xl font-display font-bold uppercase leading-tight text-secondary mb-4">
            Terms of Service
          </h1>
          <p className="text-muted-foreground text-sm">
            Effective date: January 1, 2025 · Last updated: August 1, 2026
          </p>
        </div>

        <div className="prose prose-invert prose-sm max-w-none space-y-8 text-muted-foreground leading-relaxed">

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">1. Acceptance of Terms</h2>
            <p>
              By downloading, installing, or using the StecStats application ("App") or website at{" "}
              <a href="https://stecstats.com" className="text-primary hover:underline">stecstats.com</a>{" "}
              (collectively, the "Service"), you agree to be bound by these Terms of Service ("Terms").
              If you do not agree to these Terms, do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">2. Description of Service</h2>
            <p>
              StecStats provides basketball statistics tracking, game recording, live streaming, and
              related coaching tools. Features are available on a tiered basis: Free, Pro, and
              Premium. Certain features require an active paid subscription.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">3. Subscriptions and In-App Purchases</h2>
            <p className="mb-3">
              StecStats Pro is offered as an auto-renewable subscription. The following terms apply:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong className="text-foreground">Billing:</strong> Payment will be charged to your Apple ID account
                at confirmation of purchase. Subscriptions purchased through the App are processed by Apple's
                In-App Purchase system.
              </li>
              <li>
                <strong className="text-foreground">Auto-renewal:</strong> Your subscription automatically renews
                unless cancelled at least 24 hours before the end of the current subscription period.
              </li>
              <li>
                <strong className="text-foreground">Renewal charge:</strong> Your account will be charged for renewal
                within 24 hours prior to the end of the current period at the same price you were originally charged.
              </li>
              <li>
                <strong className="text-foreground">Managing subscriptions:</strong> You can manage or cancel your
                subscription at any time by going to your Apple ID Account Settings after purchase. Cancellation takes
                effect at the end of the current billing period.
              </li>
              <li>
                <strong className="text-foreground">Free trial:</strong> A free trial period may be offered for new
                subscribers. Any unused portion of a free trial period will be forfeited when you purchase a
                subscription. After the trial ends, your subscription automatically begins and you will be charged.
              </li>
              <li>
                <strong className="text-foreground">Refunds:</strong> Refunds for in-app purchases are handled by
                Apple and subject to Apple's refund policies. We have no control over and cannot process refunds
                for purchases made through Apple's In-App Purchase system.
              </li>
              <li>
                <strong className="text-foreground">Apple standard EULA:</strong> Use of the iOS App is also
                subject to Apple&apos;s Licensed Application End User License Agreement (Standard EULA), available
                at{" "}
                <a
                  href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/"
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  apple.com/legal/internet-services/itunes/dev/stdeula
                </a>.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">4. User Accounts</h2>
            <p className="mb-3">
              You must create an account to use most features of the Service. You are responsible for:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Maintaining the confidentiality of your account credentials</li>
              <li>All activity that occurs under your account</li>
              <li>Providing accurate and current information</li>
              <li>Notifying us immediately of any unauthorized use of your account</li>
            </ul>
            <p className="mt-3">
              You may delete your account at any time from the Profile screen within the App.
              Account deletion permanently removes your data from our systems.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">5. User Content</h2>
            <p className="mb-3">
              You retain ownership of all content you upload or create through the Service, including
              game footage, statistics, and player data ("User Content"). By uploading User Content,
              you grant StecStats a limited, non-exclusive license to store and display that content
              solely for the purpose of providing the Service to you.
            </p>
            <p>
              You are solely responsible for ensuring you have the right to record, upload, and share
              any footage or data you submit, including obtaining consent from players, parents, or
              guardians as required by applicable law.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">6. Acceptable Use</h2>
            <p className="mb-3">You agree not to:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Use the Service for any unlawful purpose</li>
              <li>Upload content that infringes on third-party intellectual property rights</li>
              <li>Attempt to gain unauthorized access to any part of the Service</li>
              <li>Reverse engineer, decompile, or disassemble the App</li>
              <li>Share your account credentials with third parties</li>
              <li>Upload content depicting or targeting minors in an inappropriate manner</li>
            </ul>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">7. Intellectual Property</h2>
            <p>
              The Service, including its design, software, trademarks, and content created by StecStats,
              is owned by StecStats and protected by applicable intellectual property laws. You may not
              copy, reproduce, or distribute any part of the Service without our prior written consent.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">8. Disclaimer of Warranties</h2>
            <p>
              The Service is provided "as is" and "as available" without warranties of any kind, either
              express or implied. We do not warrant that the Service will be uninterrupted, error-free,
              or free of viruses or other harmful components. Your use of the Service is at your own risk.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">9. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, StecStats shall not be liable for any indirect,
              incidental, special, consequential, or punitive damages arising from your use of the Service,
              even if we have been advised of the possibility of such damages. Our total liability to you
              for any claims arising from use of the Service shall not exceed the amount you paid to
              StecStats in the twelve months preceding the claim.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">10. Changes to Terms</h2>
            <p>
              We may update these Terms from time to time. We will notify you of material changes by
              updating the "Last updated" date above. Continued use of the Service after changes
              constitutes acceptance of the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">11. Governing Law</h2>
            <p>
              These Terms are governed by the laws of the State of New York, without regard to its
              conflict of law provisions. Any disputes arising from these Terms shall be resolved in
              the courts located in New York.
            </p>
          </section>

          <section>
            <h2 className="text-foreground text-lg font-bold uppercase tracking-wide mb-3">12. Contact</h2>
            <p>
              If you have questions about these Terms, please contact us at{" "}
              <a href="mailto:support@stecstats.com" className="text-primary hover:underline">
                support@stecstats.com
              </a>.
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}
