import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { isValidTronAddress } from '../server/tron-address.mjs'

const enabled = process.env.SPONSOR_PG_INTEGRATION === '1'

function makeTronAddress(fill) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const payload = Buffer.from('41' + fill.repeat(20), 'hex')
  const checksum = createHash('sha256').update(
    createHash('sha256').update(payload).digest(),
  ).digest().subarray(0, 4)
  const bytes = Buffer.concat([payload, checksum])
  let value = BigInt('0x' + bytes.toString('hex'))
  let encoded = ''
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded
    value /= 58n
  }
  return encoded
}

test('PostgreSQL persists scoped funding consent, single-use deposit evidence, Fireblocks reconciliation and revocation', {
  skip: !enabled && 'Set SPONSOR_PG_INTEGRATION=1 with the dedicated sponsor_test database',
}, async () => {
  const {
    initializeDatabase,
    persistThirdPartyFundingAuthorization,
    getThirdPartyFundingAuthorization,
    listThirdPartyFundingAuthorizations,
    persistThirdPartyFundingDeposit,
    markThirdPartyFundingDepositFireblocksVerified,
    persistFireblocksInventorySnapshot,
    revokeThirdPartyFundingAuthorization,
  } = await import('../server/database.mjs')

  const initialized = await initializeDatabase()
  assert.equal(initialized.ready, true)

  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const sponsorAddress = makeTronAddress('11')
  const vaultAddress = makeTronAddress('22')
  assert.equal(isValidTronAddress(sponsorAddress), true)
  assert.equal(isValidTronAddress(vaultAddress), true)

  const authorizationId = 'pg-funding-' + suffix
  const signature = '0x' + 'a'.repeat(130)
  const signatureHash = createHash('sha256').update(signature, 'utf8').digest('hex')
  const messageHash = createHash('sha256').update('message-' + suffix).digest('hex')
  const issuedAt = new Date(Date.now() - 60_000)
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
  const registered = await persistThirdPartyFundingAuthorization({
    authorizationId,
    sponsorAddress,
    vaultAddress,
    usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    maxUsdtBaseUnits: '25000000',
    maxTrxSun: '8000000',
    agreementReference: 'PG-AGREEMENT-' + suffix,
    agreementReviewedBy: makeTronAddress('33'),
    agreementReviewedAt: new Date(),
    signature,
    signatureHash,
    messageHash,
    issuedAt,
    expiresAt,
  })
  assert.equal(registered.persisted, true)
  assert.equal(registered.duplicate, false)
  assert.equal(registered.status, 'awaiting-deposit')

  const duplicateRegistration = await persistThirdPartyFundingAuthorization({
    authorizationId,
    sponsorAddress,
    vaultAddress,
    usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    maxUsdtBaseUnits: '25000000',
    maxTrxSun: '8000000',
    agreementReference: 'PG-AGREEMENT-' + suffix,
    agreementReviewedBy: makeTronAddress('33'),
    agreementReviewedAt: new Date(),
    signature,
    signatureHash,
    messageHash,
    issuedAt,
    expiresAt,
  })
  assert.equal(duplicateRegistration.persisted, true)
  assert.equal(duplicateRegistration.duplicate, true)

  const usdtTx = createHash('sha256').update('usdt-' + suffix).digest('hex')
  const trxTx = createHash('sha256').update('trx-' + suffix).digest('hex')
  const usdtDeposit = await persistThirdPartyFundingDeposit({
    authorizationId, transactionHash: usdtTx, asset: 'USDT',
    tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    senderAddress: sponsorAddress, recipientAddress: vaultAddress,
    amountBaseUnits: '25000000', blockNumber: 1001, evidenceIndex: 0,
  })
  assert.equal(usdtDeposit.persisted, true)
  assert.equal(usdtDeposit.status, 'deposit-evidence-recorded')

  const duplicateDeposit = await persistThirdPartyFundingDeposit({
    authorizationId, transactionHash: usdtTx, asset: 'USDT',
    tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    senderAddress: sponsorAddress, recipientAddress: vaultAddress,
    amountBaseUnits: '25000000', blockNumber: 1001, evidenceIndex: 0,
  })
  assert.equal(duplicateDeposit.persisted, true)
  assert.equal(duplicateDeposit.duplicate, true)

  const conflictingUsdtDeposit = await persistThirdPartyFundingDeposit({
    authorizationId, transactionHash: createHash('sha256').update('second-usdt-' + suffix).digest('hex'),
    asset: 'USDT', tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    senderAddress: sponsorAddress, recipientAddress: vaultAddress,
    amountBaseUnits: '1', blockNumber: 1002, evidenceIndex: 0,
  })
  assert.equal(conflictingUsdtDeposit.persisted, false)
  assert.equal(conflictingUsdtDeposit.reason, 'deposit-for-asset-already-recorded')

  const overCapTrxDeposit = await persistThirdPartyFundingDeposit({
    authorizationId, transactionHash: trxTx, asset: 'TRX', tokenContract: null,
    senderAddress: sponsorAddress, recipientAddress: vaultAddress,
    amountBaseUnits: '8000001', blockNumber: 1003, evidenceIndex: 0,
  })
  assert.equal(overCapTrxDeposit.persisted, false)
  assert.equal(overCapTrxDeposit.reason, 'deposit-exceeds-authorized-cap')

  const trxDeposit = await persistThirdPartyFundingDeposit({
    authorizationId, transactionHash: trxTx, asset: 'TRX', tokenContract: null,
    senderAddress: sponsorAddress, recipientAddress: vaultAddress,
    amountBaseUnits: '8000000', blockNumber: 1003, evidenceIndex: 0,
  })
  assert.equal(trxDeposit.persisted, true)

  const inventoryCheckedAt = new Date(Date.now() + 5_000)
  const inventory = await persistFireblocksInventorySnapshot({
    workflowRunId: String(Date.now()) + String(parseInt(suffix, 16)).padStart(8, '0'),
    workflowRunAttempt: 1,
    repository: 'MyTeleProject2026/trc20-usdt-token-cloner',
    branch: 'main',
    commitSha: 'a'.repeat(40),
    verificationStatus: 'verified',
    checkedAt: inventoryCheckedAt,
    configuration: {
      apiBase: 'https://api.fireblocks.io', vaultAccountId: '42',
      usdtAssetId: 'TRON_USDT', trxAssetId: 'TRX',
      treasuryAddress: vaultAddress, signerMode: 'fireblocks', network: 'mainnet',
      usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      usdtDecimals: 6, trxDecimals: 6, apiKeyConfigured: true,
    },
    checks: {
      fireblocksApiAuthenticated: true, vaultAccountVerified: true,
      usdtAssetActivated: true, officialUsdtAssetVerified: true,
      usdtAddressMatches: true, trxAssetActivated: true,
      nativeTrxAssetVerified: true, trxAddressMatches: true,
      officialUsdtChainVerified: true, treasuryTrxChainBalanceRead: true,
      databaseReady: true,
    },
    balances: {
      fireblocksUsdtAvailableBaseUnits: '25000000',
      chainUsdtBalanceBaseUnits: '25000000',
      fireblocksTrxAvailableBaseUnits: '8000000',
      chainTrxBalanceSun: '8000000',
    },
    reasons: [],
  })
  assert.equal(inventory.persisted, true)

  const marked = await markThirdPartyFundingDepositFireblocksVerified({
    authorizationId, asset: 'USDT', transactionHash: usdtTx,
    snapshotId: inventory.id, treasuryAddress: vaultAddress, vaultAccountId: '42',
    availableBalanceBaseUnits: '25000000', chainBalanceBaseUnits: '25000000',
    checkedAt: inventoryCheckedAt,
  })
  assert.equal(marked.verified, true)
  assert.equal(marked.duplicate, false)

  const detail = await getThirdPartyFundingAuthorization(authorizationId)
  assert.equal(detail.success, true)
  assert.equal(detail.authorization.authorizationId, authorizationId)
  assert.equal(detail.authorization.status, 'deposit-evidence-recorded')
  assert.equal(detail.deposits.length, 2)
  const usdtRow = detail.deposits.find((row) => row.asset === 'USDT')
  assert.equal(usdtRow.fireblocksSnapshotId, inventory.id)
  assert.equal(usdtRow.fireblocksVaultAccountId, '42')
  assert.ok(usdtRow.fireblocksVerifiedAt)

  const list = await listThirdPartyFundingAuthorizations({ limit: 50 })
  assert.equal(list.success, true)
  assert.ok(list.authorizations.some((item) => item.authorizationId === authorizationId))

  const revoked = await revokeThirdPartyFundingAuthorization({
    authorizationId, revokedBy: makeTronAddress('33'),
  })
  assert.equal(revoked.revoked, true)
  assert.equal(revoked.status, 'revoked')

  const repeatedRevocation = await revokeThirdPartyFundingAuthorization({
    authorizationId, revokedBy: makeTronAddress('33'),
  })
  assert.equal(repeatedRevocation.revoked, true)
  assert.equal(repeatedRevocation.duplicate, true)

  const blockedAfterRevocation = await persistThirdPartyFundingDeposit({
    authorizationId, transactionHash: createHash('sha256').update('late-' + suffix).digest('hex'),
    asset: 'TRX', tokenContract: null, senderAddress: sponsorAddress,
    recipientAddress: vaultAddress, amountBaseUnits: '1', blockNumber: 1004,
  })
  assert.equal(blockedAfterRevocation.persisted, false)
  assert.equal(blockedAfterRevocation.reason, 'funding-authorization-revoked')
})
