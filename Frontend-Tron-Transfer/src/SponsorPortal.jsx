import './styles.css'

/**
 * Legacy sponsor-entry route retained as a compatibility surface.
 * All active Sponsor operations live inside the existing TRON TRANSFER app.
 * This page intentionally does not discover or connect external wallet providers.
 */
export default function SponsorPortal() {
  return (
    <div className="app-shell sponsor-portal-shell">
      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">TRON TRANSFER · INVITED SPONSOR ACCESS</span>
            <h1>TRON TRANSFER Sponsor workspace</h1>
          </div>
          <div className="topbar-actions">
            <a className="outline-button" href="/#/sponsor">Open Sponsor workspace</a>
          </div>
        </header>
        <div className="content">
          <section className="panel sponsor-public-brief" aria-labelledby="sponsor-brief-title">
            <div className="section-heading">
              <div>
                <span className="eyebrow">INTERNAL SPONSOR CUSTODY · TRON MAINNET</span>
                <h2 id="sponsor-brief-title">Manage the independent Sponsor account inside TRON TRANSFER</h2>
                <p>The Sponsor workspace is part of the existing TRON TRANSFER application. It uses its own encrypted Sponsor Wallet vault, separate from the Owner Wallet, and does not require TronLink or another injected wallet provider.</p>
              </div>
            </div>
            <div className="owner-session-card sponsor-target-card">
              <strong>Independent Sponsor account</strong>
              <p><strong>Separate address, separate private-key custody boundary, separate transaction authorization.</strong></p>
              <small>Import only an existing Sponsor account. Do not deposit funds into a platform-controlled account or share recovery phrases, private keys or passwords. Sponsor resource operations remain subject to explicit confirmation, server-side readiness, protected reserves, fee caps and solidified Mainnet verification.</small>
            </div>
            <div className="sponsor-brief-grid">
              <div>
                <h3>How Sponsor control works</h3>
                <ol>
                  <li>Open the Sponsor workspace in the existing TRON TRANSFER app.</li>
                  <li>Unlock the encrypted local Sponsor Wallet vault.</li>
                  <li>Confirm the Sponsor address matches the separately configured Mainnet Sponsor signer.</li>
                  <li>Review each exact operation, resource, amount, Owner recipient and fee/reserve policy.</li>
                  <li>Authorize the operation explicitly and wait for solidified Mainnet verification.</li>
                </ol>
              </div>
              <div>
                <h3>Security boundaries</h3>
                <ul>
                  <li>Owner and Sponsor wallets remain separate.</li>
                  <li>The Owner workspace never receives the Sponsor private key.</li>
                  <li>No TronLink, browser-injected wallet or third-party wallet approval is required.</li>
                  <li>Never share seed phrases, private keys, vault passwords or remote access.</li>
                  <li>Code availability is not proof of a funded Sponsor account or successful Mainnet operation.</li>
                </ul>
              </div>
            </div>
            <p className="fine-print">Sponsor recruitment and funding are not represented as completed. No individual Sponsor is claimed approved or funded, and no Mainnet resource grant or payout is claimed by this entry page.</p>
          </section>
        </div>
      </main>
    </div>
  )
}
