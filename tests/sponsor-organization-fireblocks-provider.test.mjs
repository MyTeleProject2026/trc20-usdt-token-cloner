import test from 'node:test'
import assert from 'node:assert/strict'
import { preflightSponsorOrganizationFireblocksProvider } from '../server/sponsor-organization-fireblocks-provider.mjs'

const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const principal = 'TKbcs8dYuaZT1VdtrKxnVswNg3DKjSs7u2'
const fee = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'
const receiver = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'
const principalVaultId = '101'
const feeVaultId = '202'
const configEnv = {
  FIREBLOCKS_API_KEY: 'test-api-user-key',
  FIREBLOCKS_SECRET_KEY_PATH: '/etc/secrets/fireblocks-test.pem',
  FIREBLOCKS_API_BASE: 'https://api.fireblocks.io',
  SPONSOR_FIREBLOCKS_REGISTRY_ORGANIZATION_ID: '41',
  SPONSOR_FIREBLOCKS_REGISTRY_PRINCIPAL_ACCOUNT_ID: '51',
  SPONSOR_FIREBLOCKS_REGISTRY_FEE_ACCOUNT_ID: '52',
  SPONSOR_FIREBLOCKS_PRINCIPAL_VAULT_ACCOUNT_ID: principalVaultId,
  SPONSOR_FIREBLOCKS_FEE_VAULT_ACCOUNT_ID: feeVaultId,
  SPONSOR_FIREBLOCKS_USDT_ASSET_ID: 'USDT_TRON',
  SPONSOR_FIREBLOCKS_TRX_ASSET_ID: 'TRX',
}

function makeIntent(overrides = {}) {
  return {
    id: '9001',
    intentDigest: 'a'.repeat(64),
    status: 'sponsor_authorization_complete',
    network: 'mainnet',
    asset: 'USDT',
    tokenContract: contract,
    receiverAddress: receiver,
    amountBaseUnits: '2500000',
    feeCapSun: '300000',
    principalSponsorAddress: principal,
    feeSponsorAddress: fee,
    principalOrganizationId: '41',
    feeOrganizationId: '41',
    principalAccountId: '51',
    feeAccountId: '52',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    ...overrides,
  }
}

function createHarness({
  intent = makeIntent(),
  principalAvailable = '10.000000',
  feeAvailable = '100.000000',
  feeEstimate = { low: { networkFee: '0.10' }, medium: { networkFee: '0.20' }, high: { networkFee: '0.25' } },
  usdtMetadata = {
    id: 'USDT_TRON',
    legacyId: 'USDT_TRON',
    symbol: 'USDT',
    decimals: 6,
    onchain: { address: contract, decimals: 6 },
  },
  trxMetadata = {
    id: 'TRX',
    assetClass: 'NATIVE',
    symbol: 'TRX',
    decimals: 6,
    onchain: { symbol: 'TRX', decimals: 6 },
  },
  principalAddresses = [principal],
  feeAddresses = [fee],
} = {}) {
  const clientCalls = []
  const addresses = new Map([
    [contract, '41' + '44'.repeat(20)],
  ])
  const tronWebFactory = async () => ({
    address: { toHex: (address) => addresses.get(address) || '' },
  })
  const fireblocksClientFactory = (env) => {
    const isPrincipal = env.FIREBLOCKS_VAULT_ACCOUNT_ID === principalVaultId
    const role = isPrincipal ? 'principal' : 'fee'
    clientCalls.push({ role, vaultId: env.FIREBLOCKS_VAULT_ACCOUNT_ID })
    return {
      isConfigured: () => true,
      async getVaultAccount() {
        return { id: env.FIREBLOCKS_VAULT_ACCOUNT_ID }
      },
      async getAssetMetadata(assetId) {
        return isPrincipal ? usdtMetadata : trxMetadata
      },
      async getAssetAddresses(assetId) {
        return { addresses: isPrincipal ? principalAddresses : feeAddresses }
      },
      async getVaultAccountAsset(assetId) {
        return isPrincipal
          ? { id: 'USDT_TRON', available: principalAvailable }
          : { id: 'TRX', available: feeAvailable }
      },
      async estimateUsdtTransferFee(input) {
        assert.equal(input.recipientAddress, receiver)
        assert.equal(input.amountUsdt, '2.5')
        return feeEstimate
      },
    }
  }
  const store = {
    async getPayoutIntentForPreflight(id) {
      assert.equal(id, '9001')
      return { success: true, intent, sponsorOwnerApprovalsVerified: true }
    },
  }
  const chainPreflight = async () => ({
    success: true,
    status: 'transaction-specific-resource-preflight-passed-review-required',
    resourceEstimate: {
      estimatedNetworkFeeSun: '250000',
      principalResourcesCoverCurrentEstimate: true,
      feeSponsorDelegationObserved: true,
    },
    transactionDraft: { signed: false, broadcast: false },
  })
  return {
    clientCalls,
    run: (overrides = {}) => preflightSponsorOrganizationFireblocksProvider({
      store,
      intentId: '9001',
      env: configEnv,
      fireblocksClientFactory,
      chainPreflight,
      tronWebFactory,
      ...overrides,
    }),
  }
}

test('Fireblocks custody preflight binds one sponsor organization to two distinct verified vault accounts', async () => {
  const harness = createHarness()
  const result = await harness.run()
  assert.equal(result.success, true)
  assert.equal(result.status, 'fireblocks-custody-preflight-passed-review-required')
  assert.equal(result.intent.organizationId, '41')
  assert.equal(result.provider.principalVaultAccountVerified, true)
  assert.equal(result.provider.feeVaultAccountVerified, true)
  assert.equal(result.provider.principalWalletAddressVerified, true)
  assert.equal(result.provider.feeWalletAddressVerified, true)
  assert.equal(result.provider.officialUsdtAssetVerified, true)
  assert.equal(result.provider.nativeTrxFeeAssetVerified, true)
  assert.equal(result.provider.providerUsdtAvailableBaseUnits, '10000000')
  assert.equal(result.provider.estimatedHighNetworkFeeSun, '250000')
  assert.equal(result.provider.estimatedFeeWithinApprovedCap, true)
  assert.equal(result.tronResourcePreflight.feeSponsorDelegationObserved, true)
  assert.equal(result.transactionCreated, false)
  assert.equal(result.transactionSigned, false)
  assert.equal(result.transactionSubmitted, false)
  assert.equal(result.canSubmitSponsoredTransfer, false)
  assert.equal(result.submissionEnabled, false)
  assert.equal(harness.clientCalls.length, 2)
})

test('provider preflight does not contact Fireblocks when registry-to-vault mapping is incomplete', async () => {
  const harness = createHarness()
  const env = { ...configEnv, SPONSOR_FIREBLOCKS_REGISTRY_FEE_ACCOUNT_ID: '' }
  let calls = 0
  const result = await harness.run({
    env,
    fireblocksClientFactory: () => { calls += 1; throw new Error('must not call provider') },
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'sponsor-fireblocks-provider-not-configured')
  assert.ok(result.missing.includes('SPONSOR_FIREBLOCKS_REGISTRY_FEE_ACCOUNT_ID'))
  assert.equal(calls, 0)
})

test('provider preflight rejects a different organization or registry account mapping', async () => {
  const harness = createHarness({ intent: makeIntent({ feeOrganizationId: '42' }) })
  const result = await harness.run()
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fireblocks-vault-to-registry-account-binding-mismatch')
  assert.equal(harness.clientCalls.length, 0)
})

test('provider preflight rejects a mismatched wallet address in Fireblocks', async () => {
  const harness = createHarness({ feeAddresses: ['TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'] })
  const result = await harness.run()
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fireblocks-wallet-address-does-not-match-verified-sponsor-account')
})

test('provider preflight rejects a Fireblocks asset whose contract is not official Mainnet USDT', async () => {
  const harness = createHarness({
    usdtMetadata: {
      id: 'USDT_TRON', symbol: 'USDT', decimals: 6,
      onchain: { address: principal, decimals: 6 },
    },
  })
  const result = await harness.run()
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fireblocks-asset-is-not-official-six-decimal-tron-usdt')
})

test('provider preflight blocks insufficient provider-available USDT', async () => {
  const harness = createHarness({ principalAvailable: '1.000000' })
  const result = await harness.run()
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fireblocks-principal-provider-balance-insufficient')
  assert.equal(result.providerUsdtAvailableBaseUnits, '1000000')
})

test('provider preflight blocks provider fee estimates above the intent fee cap', async () => {
  const harness = createHarness({
    feeEstimate: {
      low: { networkFee: '0.30' },
      medium: { networkFee: '0.40' },
      high: { networkFee: '0.50' },
    },
  })
  const result = await harness.run()
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fireblocks-estimated-fee-exceeds-approved-fee-cap')
  assert.equal(result.estimatedFeeSun, '500000')
})

test('provider preflight requires an independently passing TRON resource preflight', async () => {
  const harness = createHarness()
  const result = await harness.run({
    chainPreflight: async () => ({
      success: true,
      status: 'transaction-specific-resource-preflight-blocked',
    }),
  })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'tron-resource-preflight-not-passed')
  assert.equal(harness.clientCalls.length, 0)
})

test('provider preflight rejects testnet and non-USDT intent types', async () => {
  const testnet = createHarness({ intent: makeIntent({ network: 'nile' }) })
  assert.equal((await testnet.run()).reason, 'fireblocks-adapter-requires-official-mainnet-usdt')
  const trx = createHarness({ intent: makeIntent({ asset: 'TRX', tokenContract: null }) })
  assert.equal((await trx.run()).reason, 'fireblocks-adapter-requires-official-mainnet-usdt')
})

test('provider preflight blocks when the fee-role vault cannot cover the approved TRX fee cap', async () => {
  const harness = createHarness({ feeAvailable: '0.100000' })
  const result = await harness.run()
  assert.equal(result.success, false)
  assert.equal(result.reason, 'fireblocks-fee-provider-balance-insufficient')
  assert.equal(result.providerFeeWalletTrxAvailableSun, '100000')
  assert.equal(result.approvedFeeCapSun, '300000')
})
