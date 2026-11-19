import test from 'node:test'
import assert from 'node:assert/strict'
import { createWdkTronReadOnlyService, OFFICIAL_MAINNET_USDT } from '../server/wdk-tron-readonly.mjs'

const ADDRESS = 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH'
const RECIPIENT = 'TNj5wv4bC5bYTrYWBLPmcxUPRRdx9GRVwp'

test('uses standard and GasFree WDK read-only accounts for balances and fee quotes', async () => {
  const calls = { standard: [], gasfree: [] }
  class StandardReadOnly {
    constructor(address, config) { calls.standard.push({ address, config }) }
    async getBalance() { return 123n }
    async getTokenBalance(token) { assert.equal(token, OFFICIAL_MAINNET_USDT); return 456000000n }
    async quoteTransfer(options) { calls.standard.push({ quote: options }); return { fee: 321000n } }
  }
  class GasFreeReadOnly {
    constructor(address, config) { calls.gasfree.push({ address, config }) }
    async getBalance() { return 0n }
    async getTokenBalance() { return 456000000n }
    async quoteTransfer(options) { calls.gasfree.push({ quote: options }); return { fee: 2500n, activationFee: 0n } }
  }
  const inspect = createWdkTronReadOnlyService({
    loadStandardModule: async () => ({ WalletAccountReadOnlyTron: StandardReadOnly }),
    loadGasFreeModule: async () => ({ WalletAccountReadOnlyTronGasfree: GasFreeReadOnly }),
  })
  const result = await inspect({
    network: 'mainnet',
    address: ADDRESS,
    tokenAddress: OFFICIAL_MAINNET_USDT,
    recipientAddress: RECIPIENT,
    amountBaseUnits: '1000000',
    serviceProvider: 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH',
    env: {},
  })
  assert.equal(result.standard.trxBalanceSun, '123')
  assert.equal(result.standard.tokenBalanceBaseUnits, '456000000')
  assert.equal(result.standard.estimatedNetworkFeeSun, '321000')
  assert.equal(result.gasfree.estimatedTokenFeeBaseUnits, '2500')
  assert.equal(result.gasfree.estimatedActivationFeeBaseUnits, '0')
  assert.equal(calls.standard[0].config.provider, 'https://api.trongrid.io')
  assert.equal(calls.gasfree[0].config.chainId, 728126428)
  assert.equal(calls.gasfree[0].config.serviceProvider, 'TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH')
  assert.equal(calls.standard[1].quote.amount, 1000000n)
  assert.equal(result.policy.privateKeyHandling, false)
  assert.equal(result.policy.transferSigningEnabled, false)
  assert.equal(result.policy.transferSubmissionEnabled, false)
  assert.equal(result.policy.transactionBroadcast, false)
})

test('never loads the GasFree signer for a missing service-provider selection', async () => {
  let gasfreeLoads = 0
  class StandardReadOnly {
    constructor() {}
    async getBalance() { return 0n }
    async getTokenBalance() { return 0n }
  }
  const inspect = createWdkTronReadOnlyService({
    loadStandardModule: async () => ({ WalletAccountReadOnlyTron: StandardReadOnly }),
    loadGasFreeModule: async () => { gasfreeLoads += 1; throw new Error('must-not-load') },
  })
  const result = await inspect({
    network: 'mainnet',
    address: ADDRESS,
    tokenAddress: OFFICIAL_MAINNET_USDT,
  })
  assert.equal(gasfreeLoads, 0)
  assert.equal(result.gasfree.status, 'service-provider-not-selected')
})

test('rejects invalid amount/recipient before importing WDK modules', async () => {
  let loads = 0
  const inspect = createWdkTronReadOnlyService({
    loadStandardModule: async () => { loads += 1; return {} },
    loadGasFreeModule: async () => { loads += 1; return {} },
  })
  await assert.rejects(() => inspect({
    network: 'mainnet',
    address: ADDRESS,
    tokenAddress: OFFICIAL_MAINNET_USDT,
    recipientAddress: RECIPIENT,
    amountBaseUnits: '1e6',
  }), /fee quote/)
  assert.equal(loads, 0)
})

test('GasFree API secrets are passed only into the server-side WDK adapter config', async () => {
  let received
  class StandardReadOnly {
    constructor() {}
    async getBalance() { return 0n }
    async getTokenBalance() { return 0n }
  }
  class GasFreeReadOnly {
    constructor(_address, config) { received = config }
    async getBalance() { return 0n }
    async getTokenBalance() { return 0n }
  }
  const inspect = createWdkTronReadOnlyService({
    loadStandardModule: async () => ({ WalletAccountReadOnlyTron: StandardReadOnly }),
    loadGasFreeModule: async () => ({ WalletAccountReadOnlyTronGasfree: GasFreeReadOnly }),
  })
  await inspect({
    network: 'mainnet',
    address: ADDRESS,
    tokenAddress: OFFICIAL_MAINNET_USDT,
    serviceProvider: RECIPIENT,
    env: { GASFREE_MAINNET_API_KEY: 'server-key', GASFREE_MAINNET_API_SECRET: 'server-secret' },
  })
  assert.equal(received.gasFreeApiKey, 'server-key')
  assert.equal(received.gasFreeApiSecret, 'server-secret')
  assert.equal(received.provider, 'https://api.trongrid.io')
})
