import { Router } from 'express'
import { tatumApiBase, tatumFetch, MissingApiKeyError } from '../tatum-client.mjs'
import { findVerifiedTransfer, recordTransferVerification } from '../database.mjs'
import { canTransitionTransferStatus, buildSolidifiedTransferEvidence } from '../transfer-lifecycle.mjs'

const router = Router()
const addressPattern = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const txPattern = /^[0-9a-fA-F]{64}$/
// Canonical Mainnet Tether USDT contract; this exception is Mainnet-only.
// Hex is the 20-byte address payload without TRON's 41 network prefix.
const OFFICIAL_MAINNET_USDT_HEX = 'a614f803b6fd780986a42c78ec9c7f77e6ded13c'

// Normalize TRON hex addresses for allowlist comparisons. The lifecycle module
// has its own private normalizer for evidence checks; this route also needs one
// when parsing the configured contract allowlist.
function normalizeHexAddress(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/^0x/i, '');
  if (!/^(?:41)?[0-9a-f]{40}$/i.test(hex)) return null;
  return (hex.length === 42 && /^41/i.test(hex) ? hex.slice(2) : hex).toLowerCase();
}

async function persistVerification(input) {
  try {
    return await recordTransferVerification(input)
  } catch {
    // Report persistence separately: a chain proof may be valid even if history
    // could not be saved, but the API must never imply that it was persisted.
    return { persisted: false, reason: 'persistence-failed' }
  }
}

router.get('/status', async (_req, res) => {
  if (!process.env.TATUM_API_KEY) return res.json({ status: 'no-api-key' })
  try {
    const response = await fetch(tatumApiBase(), { signal: AbortSignal.timeout(8000), headers: { 'x-api-key': process.env.TATUM_API_KEY } })
    res.json({ status: response.ok ? 'connected' : 'provider-response', providerStatus: response.status })
  } catch (error) {
    // Keep provider diagnostics useful without exposing request headers or secrets.
    const code = typeof error?.cause?.code === 'string'
      ? error.cause.code
      : typeof error?.code === 'string'
        ? error.code
        : '';
    const name = typeof error?.name === 'string' ? error.name : '';
    const configurationError = error instanceof Error && [
      'Invalid Tatum API base configuration',
      'TATUM_API_BASE must be the approved HTTPS Tatum API origin',
    ].includes(error.message);
    let errorCategory = configurationError ? 'configuration-error' : 'network-error';
    if (configurationError) {
      // Only expose the category; never echo the configured origin or any secret.
    } else if (name === 'AbortError' || name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
      errorCategory = 'timeout';
    } else if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA'].includes(code)) {
      errorCategory = 'dns';
    } else if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code) || /TLS|CERT/i.test(code)) {
      errorCategory = 'tls';
    } else if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) {
      errorCategory = 'connection';
    }
    console.warn('[tatum-status] Provider probe failed', JSON.stringify({ errorCategory, code: code || undefined, name: name || undefined }));
    res.json({ status: 'egress-failed', errorCategory, ...(code ? { errorCode: code } : {}) })
  }
})


// Read-only sponsor status. This endpoint deliberately cannot initiate transfers.
// It stays disabled until a real provider adapter, sponsor funding, and testnet
// verification have been implemented and reviewed.
router.get('/tron/sponsorship/status', async (_req, res) => {
  const { getSponsorshipStatus } = await import('../sponsorship-status.mjs')
  res.json({ success: true, sponsorship: getSponsorshipStatus() })
})

router.get('/tron/info', async (_req, res) => {
  try {
    const data = await tatumFetch('/v3/tron/info')
    res.json({ success: true, data })
  } catch (err) {
    if (err instanceof MissingApiKeyError) return res.status(503).json({ success: false, error: 'missing-api-key', message: 'Set TATUM_API_KEY in Render environment variables.' })
    res.status(502).json({ success: false, error: 'provider-request-failed', message: err.message })
  }
})

router.get('/tron/account/:address', async (req, res) => {
  const address = req.params.address
  if (!addressPattern.test(address)) return res.status(400).json({ success: false, error: 'invalid-address', message: 'Use a valid TRON Base58 address.' })
  try {
    const data = await tatumFetch(`/v3/tron/account/${encodeURIComponent(address)}`)
    res.json({ success: true, data })
  } catch (err) {
    if (err instanceof MissingApiKeyError) return res.status(503).json({ success: false, error: 'missing-api-key', message: 'Set TATUM_API_KEY in Render environment variables.' })
    res.status(502).json({ success: false, error: 'provider-request-failed', message: err.message })
  }
})


// Read-only receiver balance query against TRON's solidified state.
// This endpoint never signs, broadcasts, or credits an internal ledger.
router.get('/tron/token-balance', async (req, res) => {
  const { network, contract, address } = req.query;
  const networkHosts = {
    mainnet: 'https://tron-mainnet.gateway.tatum.io',
    shasta: 'https://tron-shasta.gateway.tatum.io',
    nile: 'https://tron-nile.gateway.tatum.io',
  };
  if (typeof network !== 'string' || !Object.hasOwn(networkHosts, network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' });
  }
  if (typeof contract !== 'string' || typeof address !== 'string') {
    return res.status(400).json({ success: false, error: 'missing-address', message: 'Provide a token contract and receiver address.' });
  }
  if (!process.env.TATUM_API_KEY) {
    return res.status(503).json({ success: false, error: 'missing-api-key', message: 'Set TATUM_API_KEY in the backend environment to query the selected Tatum TRON network.' });
  }
  try {
    const { TronWeb } = await import('tronweb');
    const tronWeb = new TronWeb({ fullHost: networkHosts[network] });
    if (!tronWeb.isAddress(contract) || !tronWeb.isAddress(address)) {
      return res.status(400).json({ success: false, error: 'invalid-address', message: 'Token contract and receiver must be valid TRON addresses.' });
    }
    const contractHex = tronWeb.address.toHex(contract).replace(/^41/i, '');
    const addressHex = tronWeb.address.toHex(address).replace(/^41/i, '');
    const ownerHex = tronWeb.address.toHex(address);
    const headers = { 'content-type': 'application/json', 'x-api-key': process.env.TATUM_API_KEY };
    const readConstant = async (selector, parameter = '') => {
      const response = await fetch(networkHosts[network] + '/walletsolidity/triggerconstantcontract', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          owner_address: ownerHex,
          contract_address: '41' + contractHex,
          function_selector: selector,
          parameter,
          visible: false,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('solidified-provider-unavailable');
      const data = await response.json();
      if (data.Error || data.result?.result === false || !Array.isArray(data.constant_result) || !data.constant_result[0]) {
        throw new Error('solidified-contract-read-failed');
      }
      return data.constant_result[0];
    };
    const [balanceHex, decimalsHex] = await Promise.all([
      readConstant('balanceOf(address)', addressHex.padStart(64, '0')),
      readConstant('decimals()'),
    ]);
    const balanceBaseUnits = BigInt('0x' + balanceHex).toString();
    const decimals = Number(BigInt('0x' + decimalsHex));
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      return res.status(502).json({ success: false, error: 'invalid-token-decimals' });
    }
    return res.json({
      success: true,
      status: 'solidified-balance-read',
      network,
      tokenContract: contract,
      receiverAddress: address,
      balanceBaseUnits,
      decimals,
      source: 'Tatum TRON Solidity HTTP gateway triggerconstantcontract',
      note: 'This is the balance for this exact token contract on this exact network. It does not imply exchange deposit credit.',
    });
  } catch {
    return res.status(502).json({ success: false, error: 'solidified-balance-read-failed', message: 'Could not read the token balance from the selected network solidified state.' });
  }
});

router.get('/tron/contract-by-tx/:hash', async (req, res) => {
  const hash = req.params.hash
  if (!txPattern.test(hash)) return res.status(400).json({ success: false, error: 'invalid-transaction-id', message: 'Transaction ID must be 64 hexadecimal characters.' })
  try {
    const data = await tatumFetch(`/v3/blockchain/sc/address/TRON/${encodeURIComponent(hash)}`)
    res.json({ success: true, data })
  } catch (err) {
    if (err instanceof MissingApiKeyError) return res.status(503).json({ success: false, error: 'missing-api-key', message: 'Set TATUM_API_KEY in Render environment variables.' })
    res.status(502).json({ success: false, error: 'provider-request-failed', message: err.message })
  }
})


// Read-only verification against TRON's solidified chain. This endpoint never
// signs, broadcasts, credits balances, or trusts an indexer as final proof.
router.get('/tron/verify-transfer/:hash', async (req, res) => {
  const hash = req.params.hash
  const { contract, from, to, amountSun, network = 'mainnet' } = req.query
  if (!txPattern.test(hash)) return res.status(400).json({ success: false, error: 'invalid-transaction-id' })
  const networkHosts = { mainnet: 'https://api.trongrid.io', shasta: 'https://api.shasta.trongrid.io', nile: 'https://nile.trongrid.io' }
  if (typeof network !== 'string' || !Object.hasOwn(networkHosts, network)) return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be mainnet, shasta, or nile.' })
  const hexAddress = /^(?:41)?[0-9a-fA-F]{40}$/
  if (![contract, from, to].every((value) => typeof value === 'string' && hexAddress.test(value))) {
    return res.status(400).json({ success: false, error: 'invalid-address', message: 'contract, from, and to must be 20-byte hex addresses, optionally prefixed with 41.' })
  }
  if (typeof amountSun !== 'string' || !/^[0-9]+$/.test(amountSun) || BigInt(amountSun) <= 0n) {
    return res.status(400).json({ success: false, error: 'invalid-amount', message: 'amountSun must be a positive integer string in the token smallest unit.' })
  }
  const approvedContracts = (process.env.TRON_VERIFIED_TOKEN_CONTRACTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => hexAddress.test(value))
    .map(normalizeHexAddress)
  const normalizedContract = normalizeHexAddress(contract)
  // Verification of the fixed official USDT contract is safely enabled on
  // Mainnet without an environment override. No other contract is implicitly
  // trusted, and this exception must never apply to Shasta or Nile.
  const isOfficialMainnetUsdt = network === 'mainnet'
    && normalizedContract === OFFICIAL_MAINNET_USDT_HEX
  if (!isOfficialMainnetUsdt && !approvedContracts.length) {
    return res.status(503).json({ success: false, error: 'verified-token-allowlist-not-configured', message: 'Configure TRON_VERIFIED_TOKEN_CONTRACTS with reviewed contract addresses before verifying transfers for non-default token contracts.' })
  }
  if (!isOfficialMainnetUsdt && !approvedContracts.includes(normalizedContract)) {
    return res.status(403).json({ success: false, error: 'token-contract-not-allowlisted', message: 'This token contract is not on the server-approved verification list.' })
  }
  const base = networkHosts[network]
  const headers = { 'content-type': 'application/json' }
  if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY
  const querySolidified = async (path) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ value: hash, visible: false }),
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error('solidified-provider-http-' + response.status)
    return response.json()
  }
  try {
    const transaction = await querySolidified('/walletsolidity/gettransactionbyid')
    if (!transaction || transaction.txID?.toLowerCase() !== hash.toLowerCase()) {
      await persistVerification({ network, transactionHash: hash, tokenContract: contract, fromAddress: from, toAddress: to, amountBaseUnits: amountSun, status: 'awaiting-solidification', result: {} })
      return res.status(202).json({ success: true, verified: false, status: 'awaiting-solidification', message: 'No matching transaction body is available from solidified state yet. Retry with the same transaction ID.' })
    }
    const receipt = await querySolidified('/walletsolidity/gettransactioninfobyid')
    if (!receipt || receipt.id?.toLowerCase() !== hash.toLowerCase()) {
      await persistVerification({ network, transactionHash: hash, tokenContract: contract, fromAddress: from, toAddress: to, amountBaseUnits: amountSun, status: 'awaiting-solidified-receipt', result: {} })
      return res.status(202).json({ success: true, verified: false, status: 'awaiting-solidified-receipt', message: 'The transaction body is solidified, but its receipt is not available yet. Retry with the same transaction ID.' })
    }
    const { verifySolidifiedTrc20Transfer } = await import('../tron-verification.mjs')
    const result = verifySolidifiedTrc20Transfer({
      transaction,
      receipt,
      expectedTxId: hash,
      tokenContractAddress: contract,
      fromAddress: from,
      toAddress: to,
      amountSun,
    })
    if (!result.verified) {
      await persistVerification({ network, transactionHash: hash, tokenContract: contract, fromAddress: from, toAddress: to, amountBaseUnits: amountSun, status: 'not-verified', result })
      return res.status(200).json({ success: true, ...result, status: 'not-verified' })
    }
    // Defense in depth: only allow the lifecycle to advance when the result returned
    // by the solidified verifier matches every expected transfer field.
    const lifecycleEvidence = buildSolidifiedTransferEvidence({
      result, network, networkHosts, contract, from, to, amountSun,
    });
    if (!canTransitionTransferStatus('awaiting-finality', 'verified-on-chain', lifecycleEvidence)) {
      await persistVerification({ network, transactionHash: hash, tokenContract: contract, fromAddress: from, toAddress: to, amountBaseUnits: amountSun, status: 'not-verified', result: { verified: false, reason: 'lifecycle-evidence-gate-failed' } });
      return res.status(502).json({ success: false, verified: false, status: 'not-verified', error: 'verification-invariant-failed', message: 'The verified result did not satisfy all lifecycle evidence checks.' });
    }
    const persistence = await persistVerification({ network, transactionHash: hash, tokenContract: contract, fromAddress: from, toAddress: to, amountBaseUnits: amountSun, status: 'verified-on-chain', logIndex: result.logIndex, result })
    return res.json({
      success: true,
      status: 'verified-on-chain',
      ...result,
      persistence: persistence?.persisted
        ? { persisted: true }
        : { persisted: false, reason: persistence?.reason || 'persistence-unavailable' },
    })
  } catch (err) {
    return res.status(502).json({ success: false, error: 'solidified-provider-request-failed', message: 'Could not verify the solidified transaction with the configured TRON provider.' })
  }
})


// Read-only lookup for an exact, previously persisted, solidified Transfer event.
// Every identity field is required so a hash alone cannot be treated as proof.
router.get('/tron/verified-transfer/:hash', async (req, res) => {
  const hash = req.params.hash
  const { network, contract, from, to, amountSun, logIndex } = req.query
  if (!txPattern.test(hash)) return res.status(400).json({ success: false, error: 'invalid-transaction-id' })
  if (typeof network !== 'string' || !['mainnet', 'shasta', 'nile'].includes(network)) {
    return res.status(400).json({ success: false, error: 'invalid-network', message: 'network must be explicitly set to mainnet, shasta, or nile.' })
  }
  const hexAddress = /^(?:41)?[0-9a-fA-F]{40}$/
  if (![contract, from, to].every((value) => typeof value === 'string' && hexAddress.test(value))) {
    return res.status(400).json({ success: false, error: 'invalid-address', message: 'contract, from, and to must be 20-byte hex addresses, optionally prefixed with 41.' })
  }
  if (typeof amountSun !== 'string' || !/^[0-9]+$/.test(amountSun) || BigInt(amountSun) <= 0n) {
    return res.status(400).json({ success: false, error: 'invalid-amount', message: 'amountSun must be a positive integer string in token smallest units.' })
  }
  if (typeof logIndex !== 'string' || !/^(0|[1-9][0-9]*)$/.test(logIndex) || !Number.isSafeInteger(Number(logIndex))) {
    return res.status(400).json({ success: false, error: 'invalid-log-index', message: 'logIndex must be a non-negative safe integer from the verified Transfer event.' })
  }
  try {
    const lookup = await findVerifiedTransfer({
      network, transactionHash: hash, tokenContract: contract,
      fromAddress: from, toAddress: to, amountBaseUnits: amountSun,
      logIndex: Number(logIndex),
    })
    if (lookup.reason === 'database-not-configured') {
      return res.status(503).json({ success: false, error: 'verification-storage-unavailable', message: 'Persistent verification storage is not configured.' })
    }
    if (!lookup.found) {
      return res.status(404).json({ success: false, error: 'verified-transfer-not-found', message: 'No persisted verified event matches every supplied field.' })
    }
    return res.json({ success: true, status: 'verified-on-chain', transfer: lookup.transfer })
  } catch {
    return res.status(503).json({ success: false, error: 'verification-storage-unavailable', message: 'Could not read persistent verification storage.' })
  }
})

// Contract deployment is performed by the user's local wallet in the frontend.
// The server intentionally never accepts or stores a wallet private key.
router.post('/tron/deploy', (req, res) => {
  const { name, symbol, decimals, totalSupply, recipient } = req.body || {}
  if (/tether/i.test(String(name || '')) || String(symbol || '').trim().toUpperCase() === 'USDT') {
    return res.status(400).json({ success: false, error: 'reserved-token-identity', message: 'Use a distinct token identity. This app deploys an independent TRC-20 asset, not official Tether USDT.' })
  }
  if (Number(decimals) !== 18 || !Number.isSafeInteger(Number(totalSupply)) || Number(totalSupply) <= 0 || !addressPattern.test(String(recipient || ''))) {
    return res.status(400).json({ success: false, error: 'invalid-token-parameters', message: 'Provide a positive whole-token supply, an 18-decimal configuration, and a valid TRON recipient address.' })
  }
  return res.status(409).json({ success: false, error: 'local-wallet-signing-required', message: 'Token deployment is signed directly in the browser. Do not submit wallet private keys to the API.' })
})

// The browser signs transfers locally and broadcasts directly to the selected TRON node.
router.post('/tron/transfer', (_req, res) => res.status(409).json({
  success: false,
  error: 'local-wallet-signing-required',
  message: 'Transfers must be signed locally by the token owner. This API never accepts private keys or signs transactions for users.',
}))

export default router
