// Public Terms of Service + Privacy Policy pages, served at /terms and /privacy.
// No sign-in required. Plain, readable, professional starter documents tailored
// to BuildPro+ (contractor estimating/invoicing SaaS with Stripe payments).
// NOTE: These are good-faith templates, not legal advice — have an attorney
// review before relying on them at scale.

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'
const EFFECTIVE_DATE = 'June 8, 2026'
const COMPANY = 'BuildPro+'
const SITE = 'builderspro.cc'
const CONTACT_EMAIL = 'chrisbowling220@gmail.com'

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#f8fafc', minHeight: '100vh' }}>
      <div style={{ background: NAVY, color: 'white', padding: '20px 24px' }}>
        <div style={{ maxWidth: '780px', margin: '0 auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '40px', height: '40px', background: ORANGE, borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '20px' }}>B</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: '20px' }}>BuildPro<span style={{ color: ORANGE }}>+</span></div>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>{title}</div>
          </div>
        </div>
      </div>
      <div style={{ maxWidth: '780px', margin: '0 auto', padding: 'clamp(20px, 4vw, 40px)' }}>
        <h1 style={{ fontSize: '28px', fontWeight: 800, color: NAVY, margin: '0 0 4px' }}>{title}</h1>
        <p style={{ color: '#64748b', fontSize: '13px', margin: '0 0 24px' }}>Effective {EFFECTIVE_DATE}</p>
        <div style={{ color: '#1a1f2e', fontSize: '15px', lineHeight: 1.65 }}>{children}</div>
        <div style={{ marginTop: '40px', paddingTop: '20px', borderTop: '1px solid #e2e8f0', display: 'flex', gap: '16px', fontSize: '13px' }}>
          <a href="/terms" style={{ color: ORANGE, textDecoration: 'none', fontWeight: 600 }}>Terms of Service</a>
          <a href="/privacy" style={{ color: ORANGE, textDecoration: 'none', fontWeight: 600 }}>Privacy Policy</a>
          <a href={`https://${SITE}`} style={{ color: '#64748b', textDecoration: 'none' }}>Back to {SITE}</a>
        </div>
      </div>
    </div>
  )
}

function H({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: '18px', fontWeight: 700, color: NAVY, margin: '28px 0 8px' }}>{children}</h2>
}

export function TermsPage() {
  return (
    <Shell title="Terms of Service">
      <p>Welcome to {COMPANY} ("{COMPANY}," "we," "us," or "our"). These Terms of Service ("Terms") govern your access to and use of the {COMPANY} application, website at {SITE}, and related services (together, the "Service"). By creating an account or using the Service, you agree to these Terms. If you do not agree, do not use the Service.</p>

      <H>1. Who Can Use the Service</H>
      <p>You must be at least 18 years old and able to form a binding contract. The Service is intended for contractors and tradespeople to create estimates, change orders, invoices, and to manage their jobs and customers. You are responsible for everything that happens under your account, so keep your login secure.</p>

      <H>2. Your Account</H>
      <p>You agree to provide accurate information and to keep it up to date. You are responsible for the content you create — including estimates, prices, scopes of work, invoices, and any photos you upload. You will not use the Service for anything unlawful or to mislead your customers.</p>

      <H>3. Estimates, Quotes, and AI-Assisted Content</H>
      <p>The Service can help generate estimates, material lists, labor figures, scopes of work, and other content automatically. <strong>These are working drafts and starting points, not professional, code-final, or guaranteed figures.</strong> You are the contractor of record. You are solely responsible for reviewing, correcting, and approving every quote, price, quantity, and scope before sending it to a customer or relying on it. {COMPANY} does not guarantee the accuracy, completeness, or fitness of any generated content, and does not provide engineering, code-compliance, legal, or financial advice. Always confirm local building codes, permits, and specifications with the appropriate licensed professional and your local authority having jurisdiction (AHJ).</p>

      <H>4. Payments and Subscriptions</H>
      <p>Some features require a paid subscription or per-use credits. Prices are shown in the app. Subscriptions renew automatically for the period you selected (e.g., monthly or every three months) until you cancel. You can cancel anytime; cancellation takes effect at the end of the current billing period, and fees already paid are non-refundable except where required by law. We may change pricing with reasonable notice.</p>
      <p>Payment processing is handled by our third-party provider, Stripe, Inc. By making or receiving payments through the Service, you also agree to Stripe's applicable terms. We do not store full card or bank numbers.</p>

      <H>5. Getting Paid by Your Customers</H>
      <p>If you enable card payments, your customers pay you and the funds are routed to your own connected payout account through Stripe. {COMPANY} is a software platform — we are not a bank, money transmitter, or party to the contract between you and your customer. A platform fee (currently 2% per card payment) is deducted to cover the cost of the platform; this is disclosed in the app and may change with notice. Because you are the merchant of record for these payments, Stripe's payment-processing fee is charged to you, and you are responsible for your own taxes, refunds, chargebacks, and obligations to your customers.</p>

      <H>6. Your Content and Records</H>
      <p>You own the content you create. You grant us a limited license to store, process, and display it as needed to operate the Service for you (for example, generating a shareable estimate link). To help protect you in disputes, e-signed documents and paid invoices may be retained and cannot be deleted for a period of time (currently two years). You are responsible for keeping your own copies of anything you need.</p>

      <H>7. Acceptable Use</H>
      <p>You will not misuse the Service, including by: breaking the law; infringing others' rights; uploading malware; attempting to access accounts or data that aren't yours; reverse-engineering or overloading the Service; or using it to harass, defraud, or mislead anyone.</p>

      <H>8. Disclaimers</H>
      <p>The Service is provided "as is" and "as available," without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, accuracy, and non-infringement. We do not warrant that the Service will be uninterrupted, error-free, or that generated estimates will be accurate or profitable.</p>

      <H>9. Limitation of Liability</H>
      <p>To the fullest extent permitted by law, {COMPANY} will not be liable for any indirect, incidental, special, consequential, or punitive damages, or for lost profits, lost business, or lost data, arising from your use of the Service. Our total liability for any claim relating to the Service will not exceed the amount you paid us in the three (3) months before the claim. Some jurisdictions don't allow certain limitations, so some of these may not apply to you.</p>

      <H>10. Indemnification</H>
      <p>You agree to defend, indemnify, and hold harmless {COMPANY} and its owners, operators, and contractors from and against any and all claims, demands, damages, losses, liabilities, fines, penalties, and costs (including reasonable attorneys' fees) arising out of or related to: your use of the Service; your content; your estimates, prices, scopes, and invoices; the work you perform or fail to perform; any dispute between you and your customer or any third party; your taxes; or your violation of these Terms or any law. This obligation survives termination.</p>

      <H>11. Independent Relationship; Your Licensing, Permits, and Work</H>
      <p>{COMPANY} provides software tools only. We are <strong>not</strong> a party to any agreement, bid, contract, estimate, or transaction between you and your customers, and we are not a general contractor, subcontractor, engineer, architect, inspector, lender, or insurer. You are solely responsible for your own work, workmanship, materials, scheduling, safety, and warranties, and for resolving any dispute with your customers directly. You represent and warrant that you hold — and will keep current — all licenses, registrations, certifications, bonds, and insurance required for your trade and your jurisdiction, and that you are responsible for obtaining all required permits and for compliance with all building codes, regulations, and laws applicable to your work. Any reliance you or your customers place on content created with the Service is at your own risk, and {COMPANY} has no liability for the work you perform or the agreements you make with your customers.</p>

      <H>12. Governing Law; Binding Arbitration; Class-Action Waiver</H>
      <p>These Terms are governed by the laws of the State of North Carolina, without regard to its conflict-of-laws rules.</p>
      <p>Most concerns can be resolved quickly — please contact us first. If a dispute cannot be resolved informally, you and {COMPANY} agree that any dispute, claim, or controversy arising out of or relating to these Terms or the Service will be resolved by <strong>final and binding individual arbitration</strong>, rather than in court, except that either party may bring an individual claim in small-claims court. Judgment on the award may be entered in any court with jurisdiction.</p>
      <p><strong>YOU AND {COMPANY} AGREE THAT EACH MAY BRING CLAIMS AGAINST THE OTHER ONLY IN AN INDIVIDUAL CAPACITY, AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, COLLECTIVE, OR REPRESENTATIVE PROCEEDING.</strong> To the extent permitted by law, you and {COMPANY} waive any right to a jury trial. If this class-action waiver is found unenforceable as to a particular claim, that claim (and only that claim) will proceed in court, while the rest of this section continues to apply. You may opt out of this arbitration agreement by emailing us within 30 days of first accepting these Terms.</p>

      <H>13. Termination</H>
      <p>You may stop using the Service at any time. We may suspend or terminate your access if you violate these Terms or if we need to for legal or security reasons. Sections that by their nature should survive termination (such as payment, disclaimers, indemnification, limitation of liability, and dispute resolution) will survive.</p>

      <H>14. Changes to These Terms</H>
      <p>We may update these Terms from time to time. If we make material changes, we'll provide reasonable notice (such as in the app or by email). Continuing to use the Service after changes take effect means you accept the updated Terms.</p>

      <H>15. Contact</H>
      <p>Questions about these Terms? Contact us at <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: ORANGE }}>{CONTACT_EMAIL}</a>.</p>
    </Shell>
  )
}

export function PrivacyPage() {
  return (
    <Shell title="Privacy Policy">
      <p>This Privacy Policy explains how {COMPANY} ("we," "us," or "our") collects, uses, and protects information when you use our application and website at {SITE} (the "Service"). By using the Service, you agree to this Policy.</p>

      <H>1. Information We Collect</H>
      <p><strong>Account information:</strong> your name, email, and business details (business name, phone, license number, logo) that you provide.</p>
      <p><strong>Content you create:</strong> customers, estimates, change orders, invoices, scopes of work, prices, schedules, notes, and job photos you upload.</p>
      <p><strong>Payment information:</strong> when you subscribe or accept payments, our payment processor (Stripe) collects and processes payment and identity details. We receive limited information such as subscription status and the last four digits of a card — we do not store full card or bank numbers.</p>
      <p><strong>Usage information:</strong> basic technical data (such as device/browser type and app activity) used to operate and improve the Service.</p>

      <H>2. How We Use Information</H>
      <p>We use information to: provide and operate the Service; generate estimates, invoices, and other content you request; process subscriptions and payments; send you reminders and notifications you've enabled; provide support; keep the Service secure; and comply with the law.</p>

      <H>3. AI Processing</H>
      <p>To generate estimates, scopes, letters, and similar content, the text and photos you submit are sent to our AI service provider (Anthropic) for processing and returned to you. This data is used to fulfill your request. We do not sell your content.</p>

      <H>4. How We Share Information</H>
      <p>We do not sell your personal information. We share information only as needed to run the Service, including with: service providers who help us operate (such as Stripe for payments, Anthropic for AI processing, and Google Firebase for hosting and storage); the customers you choose to send estimates, invoices, or links to; and authorities when required by law or to protect rights and safety.</p>

      <H>5. Your Customers' Information</H>
      <p>When you add a customer or send them a document, you control that information. You are responsible for having the right to collect and use your customers' details and for handling them appropriately. We process it on your behalf to provide the Service.</p>

      <H>6. Data Storage and Security</H>
      <p>Your data is stored using industry-standard cloud infrastructure (Google Firebase). We use reasonable technical and organizational measures to protect it, including per-account access controls. No system is perfectly secure, so we can't guarantee absolute security. Some records (such as e-signed documents and paid invoices) are retained for a period of time to support dispute protection.</p>

      <H>7. Your Choices and Rights</H>
      <p>You can update your business profile in the app at any time. You can control notification preferences in the app. Depending on where you live, you may have rights to access, correct, or delete certain personal information — contact us to make a request. Note that some records may be retained where we have a legal or legitimate business reason to keep them.</p>

      <H>8. Data Retention</H>
      <p>We keep your information for as long as your account is active and as needed to provide the Service, comply with our legal obligations, resolve disputes, and enforce our agreements.</p>

      <H>9. Children</H>
      <p>The Service is not intended for anyone under 18, and we do not knowingly collect information from children.</p>

      <H>10. Changes to This Policy</H>
      <p>We may update this Policy from time to time. If we make material changes, we'll provide reasonable notice. Continuing to use the Service after changes take effect means you accept the updated Policy.</p>

      <H>11. Contact</H>
      <p>Questions about this Policy or your data? Contact us at <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: ORANGE }}>{CONTACT_EMAIL}</a>.</p>
    </Shell>
  )
}
