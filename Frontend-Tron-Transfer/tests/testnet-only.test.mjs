import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { toWalletSignableTransaction } from '../src/trax-mainnet.mjs'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('TRӾ workspace exposes dedicated owner-admin pages and one Mainnet deployment flow', async () => {
  const app = await read('../src/App.jsx')
  const panel = await read('../src/TRXMainnetPanel.jsx')
  const contract = await read('../../contracts/Restricted1TRAX.sol')
  const mobile = await read('../src/MobileNavBar.jsx')
  const sidebar = await read('../src/TRAXSidebar.jsx')
  assert.ok(panel.includes("const DEFAULT_FEE_CAP = '150'"))
  assert.ok(panel.includes('const deployToken'))
  assert.ok(contract.includes('contract Restricted1TRAX'))
  assert.ok(panel.includes('Prepare deployment'))
  assert.ok(panel.includes('Check deployment readiness'))
  assert.ok(panel.includes('disabled={!walletReady || busy || !feeCapSun || !deploymentReady} onClick={deployToken}'))
  assert.ok(panel.includes("apiRequest('/api/owner/deployment/readiness')"))
  assert.ok(panel.includes("'/api/owner/deployment/prepare'"))
  assert.ok(panel.includes("'/api/owner/deployment/confirm'"))
  assert.ok(panel.includes('separate transaction-specific phrase is required before any broadcast'))
  assert.ok(panel.includes("'/api/owner/deployment/broadcast'"))
  assert.ok(panel.includes('The local Owner signature was verified and durably saved. No Mainnet broadcast was attempted.'))
  assert.ok(panel.includes('signer.trx.sign(deploymentOperation.unsignedTransaction)'))
  assert.ok(panel.includes('signer.trx.sign(pendingOperation.unsignedTransaction)'))
  assert.doesNotMatch(panel, /deployContractWithOwnerSigner|sendAndVerifyContractCall|tronWeb\.trx\.sign|sendRawTransaction/)
  assert.ok(panel.includes('verifyTRAXTokenContract'))
  assert.ok(panel.includes("activePage = 'home'"))
  for (const page of ['home','deploy','issuance','credits','batch','pause','minting','transfers','ownership','history','balance']) {
    assert.ok(app.includes("id: '" + page + "'"), 'missing navigation page: ' + page)
  }
  assert.ok(!app.includes("id: 'accept-ownership'"), 'pending-owner acceptance must not add a navigation page')
  assert.ok(!app.includes("id: 'account-security'"), 'account security must not add a navigation page')
  const ownershipControls = await read('../src/TRAXOwnershipControls.jsx')
  assert.ok(ownershipControls.includes('<PendingOwnerAcceptance/>'), 'pending-owner acceptance must live inside existing Ownership transfer controls')
  for (const action of ['issueOwnerSupply','issueCredit','batchCredit','pause','unpauseTransfers','enableMinting','disableMinting','transfer']) {
    assert.ok(panel.includes('const ' + action + ' ='), 'missing contract action: ' + action)
  }
  assert.ok(panel.includes('<TRAXOwnershipControls'))
  assert.ok(panel.includes('<TRAXCreditHistory'))
  assert.ok(mobile.includes('trax-mobile-nav'))
  assert.ok(mobile.includes('More workspace'))
  assert.ok(sidebar.includes('collapsed'))
  assert.ok(!/TRAX_VAULT_ARTIFACT|vaultAddress|deployVault/.test(panel))
  assert.doesNotMatch(panel, /\\.call\\(\\)/, 'all Mainnet contract reads must use the paced RPC queue')
  assert.ok(panel.includes('callMainnetView('))
  assert.ok(panel.includes('getMainnetNativeBalance('))
  assert.ok(app.includes('TRXMainnetPanel'))
})

test('TRӾ frontend uses Mainnet deployment gates and validates the signer before broadcast', async () => {
  const client = await read('../src/trax-mainnet.mjs')
  for (const value of [
    "TRON_MAINNET_HOST = 'https://api.trongrid.io'",
    'MAINNET_DEPLOYMENT_SIGNING_ENABLED = true',
    'MAINNET_DEPLOYMENT_BROADCAST_ENABLED = true',
    'assertTransactionIntegrity(tronWeb, unsigned',
    'verifyTransactionSigner(tronWeb, signedTransaction, wallet.address)',
    'assertTransactionPermission(tronWeb, signedTransaction, wallet.address)',
    'sendRawTransaction(signedTransaction)',
  ]) assert.ok(client.includes(value), 'missing deployment guard: ' + value)
  assert.ok(client.indexOf('assertTransactionPermission(tronWeb, signedTransaction, wallet.address)')
    < client.indexOf('sendRawTransaction(signedTransaction)'))
})

test('Mainnet deployment signs a canonical FullNode transaction, not a locally encoded wallet-builder payload', async () => {
  const client = await read('../src/trax-mainnet.mjs')
  const start = client.indexOf('export async function deployContractWithOwnerSigner')
  const end = client.indexOf('\nexport async function ', start + 40)
  const deployment = client.slice(start, end > start ? end : undefined)
  assert.ok(deployment.includes('createMainnetDeploymentTransaction(tronWeb, options, wallet.address)'))
  assert.ok(!deployment.includes('createMainnetDeploymentTransaction(walletTronWeb, options, wallet.address)'))
  assert.ok(deployment.includes('walletTronWeb.trx.sign(walletTransaction)'))
  assert.ok(deployment.includes('walletTronWeb.trx.sendRawTransaction(signedTransaction)'))
  assert.ok(deployment.includes('walletTxCheck'))
  assert.ok(deployment.includes('const finalResourceSnapshot = await readResources(tronWeb, wallet.address)'))
  assert.ok(deployment.includes('safetyMarginBps: 12500'))
  assert.ok(deployment.indexOf('const finalResourceSnapshot = await readResources(tronWeb, wallet.address)')
    < deployment.indexOf('walletTronWeb.trx.sign(walletTransaction)'))
  assert.ok(deployment.includes('const preBroadcastResourceSnapshot = await readResources(tronWeb, wallet.address)'))
  assert.ok(deployment.indexOf('const preBroadcastResourceSnapshot = await readResources(tronWeb, wallet.address)')
    > deployment.indexOf('walletTronWeb.trx.sign(walletTransaction)'))
  assert.ok(deployment.indexOf('assertZeroTrxBurnBudget(preBroadcastBudget)')
    < deployment.indexOf('walletTronWeb.trx.sendRawTransaction(signedTransaction)'))
})

test('Owner and Sponsor workspaces do not depend on injected TRON wallet providers', async () => {
  const app = await read('../src/App.jsx')
  const ownerAccess = await read('../src/OwnerWalletAccess.jsx')
  const sponsor = await read('../src/SponsorWalletManager.jsx')
  assert.ok(app.includes('OwnerWalletAccess'))
  assert.ok(app.includes('SponsorWalletManager'))
  assert.ok(ownerAccess.includes('encrypted-local-owner-vault'))
  assert.ok(ownerAccess.includes('no TronLink connection required'))
  for (const source of [app, ownerAccess, sponsor]) {
    assert.doesNotMatch(source, /tronlink-provider|requestTronLinkConnection|discoverTronLinkProvider/)
  }
})

test('contract administration checks the configured owner against the on-chain token owner', async () => {
  const panel = await read('../src/TRXMainnetPanel.jsx')
  for (const value of ['callMainnetView(token.owner())', 'connectedAddress', 'addressesEqual(wallet.tronWeb, wallet.tronWeb.defaultAddress?.base58, connectedAddress)']) {
    assert.ok(panel.includes(value), 'missing on-chain owner check: ' + value)
  }
  assert.doesNotMatch(panel, /EXPECTED_OWNER_ADDRESS|TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp|vaultAddress|vaultOwner|TRAX_VAULT_ARTIFACT/)
})

test('production build runs the complete frontend regression suite', async () => {
  const pkg = JSON.parse(await read('../package.json'))
  assert.ok(pkg.scripts.build.includes('node --test tests/*.test.mjs'))
  assert.ok(pkg.scripts.build.includes('vite build'))
  assert.equal(pkg.dependencies.tronweb, '6.5.2')
  assert.equal(pkg.overrides.tmp, '0.2.7')
})

test('the local Owner signer receives the exact canonical node-issued CreateSmartContract transaction', () => {
  const transaction = {
    visible: false,
    txID: 'a'.repeat(64),
    contract_address: '41' + 'b'.repeat(40),
    raw_data: {
      contract: [{ type: 'CreateSmartContract', parameter: { type_url: 'type.googleapis.com/protocol.CreateSmartContract', value: { owner_address: '41' + 'c'.repeat(40), new_contract: { bytecode: '6000', abi: { entrys: [] } } } } }],
      fee_limit: 150000000,
    },
    raw_data_hex: '0a02abcd',
    providerMetadata: { retain: true },
  }
  const signable = toWalletSignableTransaction(transaction)
  assert.strictEqual(signable, transaction)
})


test('deployment transaction construction uses the FullNode deploycontract endpoint, not browser protobuf encoding', async () => {
  const helper = await read('../src/trax-mainnet.mjs')
  const start = helper.indexOf('export async function createMainnetDeploymentTransaction')
  const end = helper.indexOf('async function getCachedChainParameters', start)
  const builder = helper.slice(start, end)
  assert.ok(builder.includes("'/wallet/deploycontract'"))
  assert.ok(builder.includes('owner_address: tronWeb.address.toHex(ownerAddress)'))
  assert.ok(builder.includes('fee_limit: feeLimit'))
  assert.ok(!builder.includes('transactionBuilder.createSmartContract'))
})
