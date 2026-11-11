import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const sponsor = await readFile(new URL('../src/SponsorDirectPayouts.jsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
const sponsorRoute = await readFile(new URL('../../server/routes/sponsor-direct-payouts.mjs', import.meta.url), 'utf8')

test('recipient inspection uses the read-only Mainnet API path', () => {
  assert.ok(app.includes('/api/tron-transfer/recipient'))
  assert.ok(app.includes("network:'mainnet'"))
  assert.ok(!app.includes('/api/tron-transfer/sponsor-requests'))
  assert.ok(!app.includes('/api/tron-transfer/broadcast'))
})

test('recipient monitor defaults to the public monitored address and official Tether contract', () => {
  assert.ok(app.includes('TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'))
  assert.ok(app.includes('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'))
  assert.ok(app.includes('TRON Mainnet'))
})

test('active withdrawal tab uses the zero-balance owner sponsor-direct request flow', () => {
  assert.ok(app.includes('<SponsorDirectPayouts wallet={unlocked} ownerSession={ownerSession} mode="withdraw" />'))
  assert.ok(sponsor.includes("api('/api/tron/sponsor-direct/requests'"))
  assert.ok(sponsor.includes('A sponsor must authorize and fund it.'))
  assert.ok(sponsor.includes('The owner identity wallet does not need USDT or TRX to submit a request.'))
  assert.ok(!app.includes("import OwnerWithdrawals"))
})

test('owner password session and wallet identity session are distinct', () => {
  assert.ok(app.includes('/api/auth/owner/session'))
  assert.ok(app.includes('/api/auth/owner/login'))
  assert.ok(app.includes('OWNER_SESSION_KEY'))
  assert.ok(app.includes('requestTronLinkConnection(provider,window)'))
  assert.ok(sponsor.includes('/api/auth/tron/challenge'))
  assert.ok(sponsor.includes('/api/auth/tron/verify'))
  assert.ok(sponsor.includes('identityMatchesWallet'))
})

test('sponsor payout signing is restricted to the approved sponsor wallet', () => {
  assert.ok(sponsor.includes("walletAddress !== item.sponsorAddress"))
  assert.ok(sponsor.includes("wallet?.tronWeb?.defaultAddress?.base58 !== item.sponsorAddress"))
  assert.ok(sponsor.includes('wallet.tronWeb.trx.sign(item.unsignedTransaction)'))
  assert.ok(sponsor.includes("'/broadcast'"))
  assert.ok(sponsor.includes('Only the approved sponsor address that prepared this payment can sign it.'))
})

test('modern midnight blue dashboard theme and responsive breakpoints remain', () => {
  assert.ok(css.includes('--bg: #080d18'))
  assert.ok(css.includes('--mint-bright: #48b5ff'))
  assert.ok(css.includes('backdrop-filter: blur'))
  assert.ok(css.includes('@media (max-width: 820px)'))
  assert.ok(css.includes('@media (max-width: 560px)'))
  assert.ok(css.includes('.owner-withdrawals-page'))
})


test('mobile navigation exposes the four primary owner tabs and a functional More menu', () => {
  assert.ok(app.includes("mobilePrimaryNav = nav.filter"))
  assert.ok(app.includes("['overview','assets','recipients','withdrawals']"))
  assert.ok(app.includes("mobileMoreNav = nav.filter"))
  assert.ok(app.includes("['provider','sponsors','transactions','settings']"))
  assert.ok(app.includes("aria-current={tab===item.id?"))
  assert.ok(app.includes("setTab(item.id);setMoreOpen(false)"))
  assert.ok(app.includes("event.key === 'Escape'"))
  assert.ok(css.includes('.mobile-bottom-nav'))
  assert.ok(css.includes('.mobile-more-menu'))
  assert.ok(css.includes('env(safe-area-inset-bottom'))
})

test('mobile bottom navigation stays separate from owner authentication and wallet payout logic', () => {
  assert.ok(app.includes('className="app-shell auth-shell"'))
  assert.ok(app.includes('className="mobile-bottom-nav"'))
  assert.ok(app.includes('SponsorDirectPayouts wallet={unlocked} ownerSession={ownerSession} mode="withdraw"'))
  assert.ok(app.includes("requestTronLinkConnection(provider,window)"))
})


test('brand control navigates home and More is an accessible menu trigger', () => {
  assert.ok(app.includes('className="brand brand-home"'))
  assert.ok(app.includes("setTab('overview');setMoreOpen(false)"))
  assert.ok(!app.includes('href="#">'))
  assert.ok(app.includes('aria-haspopup="true"'))
  assert.ok(app.includes('aria-expanded={moreOpen}'))
  assert.ok(app.includes("aria-label={mobileMoreNav.some(item=>item.id===tab)"))
})


test('More navigation locks background scroll and restores keyboard focus', () => {
  assert.ok(app.includes('moreTriggerRef=useRef(null)'))
  assert.ok(app.includes('moreMenuRef=useRef(null)'))
  assert.ok(app.includes("document.body.style.overflow = 'hidden'"))
  assert.ok(app.includes("moreMenuRef.current?.querySelector('button')?.focus()"))
  assert.ok(app.includes('moreTriggerRef.current?.focus()'))
})


test('Funding status tab explains sponsor funding and links to the correct owner actions', () => {
  assert.ok(app.includes("label:'Funding status'"))
  assert.ok(app.includes('Funding status & payout requirements'))
  assert.ok(app.includes("setTab('sponsors')"))
  assert.ok(app.includes("setTab('withdrawals')"))
  assert.ok(app.includes('Sponsor-funded'))
  assert.ok(!app.includes('ProviderPayoutReadiness'))
  assert.ok(css.includes('.funding-status-grid'))
  assert.ok(css.includes('.funding-flow-list'))
})


test('owner dashboard copy consistently explains sponsor-direct funding rather than a provider credit facility', () => {
  assert.ok(app.includes('A real withdrawal uses the sponsor-direct route'))
  assert.ok(app.includes('sponsor-direct route'))
  assert.ok(!app.includes('provider-owned liquidity or an approved credit facility'))
})


test('Mainnet sponsor broadcast revalidates the exact signed payout and live funding before sending', () => {
  assert.ok(sponsorRoute.includes("router.post('/requests/:id/broadcast'"))
  assert.ok(sponsorRoute.includes('validateOwnerSignedTransaction(signedTransaction, row.unsigned_transaction, intent)'))
  assert.ok(sponsorRoute.includes("'wallet/getapprovedlist'"))
  assert.ok(sponsorRoute.includes('readSnapshot(env, auth.address)'))
  assert.ok(sponsorRoute.includes('calculateSponsorDirectFeeCoverage'))
  assert.ok(sponsorRoute.includes("'wallet/broadcasttransaction'"))
  assert.ok(sponsorRoute.includes("status=\\'submitted\\'"))
  assert.ok(sponsorRoute.includes('verifyTransfer(env,'))
  assert.ok(sponsorRoute.includes('startSponsorDirectPayoutReconciliationWorker'))
})

test('sponsor payout route never substitutes requester funds or claims exchange-account credit', () => {
  assert.ok(sponsorRoute.includes('Only the approved sponsor address can sign this exact transfer'))
  assert.ok(sponsorRoute.includes('sponsor-insufficient-mainnet-usdt-balance'))
  assert.ok(sponsorRoute.includes('sponsor-network-fee-resources-insufficient'))
  assert.ok(sponsorRoute.includes('Do not sign or submit a replacement payment'))
  assert.ok(sponsorRoute.includes('solidified Mainnet receipt and official USDT Transfer event'))
  assert.ok(sponsorRoute.includes('No funds move until that sponsor approves in its own TronLink wallet'))
})


test('withdrawal retries reuse one idempotency key per exact recipient and amount', () => {
  assert.ok(sponsor.includes('requestIdempotencyRef = useRef({ intent: \'\', key: \'\' })'))
  assert.ok(sponsor.includes('requestIdempotencyRef.current.intent !== requestIntent'))
  assert.ok(sponsor.includes('idempotencyKey: requestIdempotencyRef.current.key'))
  assert.ok(sponsor.includes("requestIdempotencyRef.current = { intent: '', key: '' }"))
})

test('owner can cancel only unsigned requested or prepared payouts from the withdrawal history', () => {
  assert.ok(sponsor.includes("'/cancel'"))
  assert.ok(sponsor.includes('walletAddress !== ownerSession?.address'))
  assert.ok(sponsor.includes("['requested', 'prepared'].includes(item.status)"))
  assert.ok(sponsor.includes('Cancel unsigned request'))
  assert.ok(sponsorRoute.includes('payout-can-no-longer-be-cancelled-safely'))
  assert.ok(sponsorRoute.includes('cancelled-by-platform-owner'))
})

test('sponsor-direct broadcast integration covers signature rejection, one accepted broadcast, and non-credit status', () => {
  assert.ok(sponsorRoute.includes("router.post('/requests/:id/broadcast'"))
  assert.ok(sponsorRoute.includes("router.post('/requests/:id/cancel'"))
  assert.ok(sponsorRoute.includes("wallet/broadcasttransaction"))
  assert.ok(sponsorRoute.includes('sponsor-signature-not-approved-by-tron-network'))
  assert.ok(sponsorRoute.includes('solidified Mainnet receipt and official USDT Transfer event'))
})


test('external deposit request requires network and exchange deposit-instruction confirmation', () => {
  assert.ok(sponsor.includes('recipientNetworkConfirmed'))
  assert.ok(sponsor.includes('recipientDepositRequirementsConfirmed'))
  assert.ok(sponsor.includes('Confirm that the receiving address accepts official USDT on TRON Mainnet (TRC20).'))
  assert.ok(sponsor.includes('Confirm the exchange minimum deposit and that no memo or tag is required'))
  assert.ok(sponsor.includes('This transfer sends the USDT TRC20 token only. It does not attach an exchange memo/tag.'))
  assert.ok(css.includes('.recipient-deposit-checklist'))
})


test('changing the recipient clears prior exchange-network and deposit-instruction confirmations', () => {
  assert.ok(sponsor.includes('setRecipientNetworkConfirmed(false); setRecipientDepositRequirementsConfirmed(false)'))
})


test('withdrawal history distinguishes verified solidified Mainnet evidence from exchange account credit', () => {
  assert.ok(sponsor.includes("setRequestEvidence((items) => ({ ...items, [id]: { confirmation: result.confirmation || null"))
  assert.ok(sponsor.includes("exchangeCreditStatus: result.exchangeCreditStatus || 'not-verified-by-tron-chain'"))
  assert.ok(sponsor.includes('Blockchain evidence: verified solidified Mainnet receipt and exact official-USDT Transfer event.'))
  assert.ok(sponsor.includes('Exchange deposit credit:'))
  assert.ok(sponsor.includes('Not verified by the TRON blockchain. Check the receiving exchange account or its deposit support.'))
})
