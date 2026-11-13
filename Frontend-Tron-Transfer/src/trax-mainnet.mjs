import artifacts from './generated/trax-contract-artifacts.js'
import { TronWeb } from 'tronweb'

export const TRON_MAINNET_HOST = 'https://api.trongrid.io'
export const TRAX_STORAGE_KEY = 'tron-transfer:trax-mainnet-contracts:v1'
export const TRAX_TOKEN_ARTIFACT = artifacts.token
export const TRAX_VAULT_ARTIFACT = artifacts.vault

export function assertMainnetWallet(wallet) {
  if (!wallet?.tronWeb || !wallet?.address) throw new Error('Connect a TronLink wallet first.')
  let host = ''
  try { host = new URL(String(wallet.tronWeb.fullNode?.host || '')).hostname.toLowerCase() } catch {}
  if (host !== 'api.trongrid.io') throw new Error('Wrong network. Switch TronLink to TRON Mainnet and reconnect.')
  if (!wallet.tronWeb.isAddress(wallet.address)) throw new Error('TronLink returned an invalid TRON address.')
  return wallet.tronWeb
}

export function parseTokenUnits(value) {
  const input = String(value ?? '').trim()
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(input) || !/[1-9]/.test(input)) {
    throw new Error('Enter a positive amount with no more than six decimal places.')
  }
  const [whole, fraction = ''] = input.split('.')
  return (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))).toString()
}

export function formatTokenUnits(value) {
  const amount = BigInt(String(value ?? '0'))
  const whole = amount / 1000000n
  const fraction = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '')
  return whole.toString() + (fraction ? '.' + fraction : '')
}

export function addressesEqual(tronWeb, a, b) {
  try { return tronWeb.address.toHex(String(a)).toLowerCase() === tronWeb.address.toHex(String(b)).toLowerCase() }
  catch { return false }
}

export function loadSavedContracts() {
  try {
    const value = JSON.parse(window.localStorage.getItem(TRAX_STORAGE_KEY) || '{}')
    return {
      tokenAddress: typeof value.tokenAddress === 'string' ? value.tokenAddress : '',
      vaultAddress: typeof value.vaultAddress === 'string' ? value.vaultAddress : '',
    }
  } catch { return { tokenAddress: '', vaultAddress: '' } }
}

export function saveContractAddresses(addresses) {
  const value = {
    tokenAddress: String(addresses.tokenAddress || ''),
    vaultAddress: String(addresses.vaultAddress || ''),
  }
  window.localStorage.setItem(TRAX_STORAGE_KEY, JSON.stringify(value))
}

async function postNode(tronWeb, path, body) {
  const response = await fetch(TRON_MAINNET_HOST + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('TRON Mainnet node returned HTTP ' + response.status + ' for ' + path)
  return response.json()
}

export async function waitForSolidifiedReceipt(tronWeb, txID, { timeoutMs = 180000, intervalMs = 3000 } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(txID || ''))) throw new Error('The wallet did not return a valid transaction ID.')
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      const transaction = await postNode(tronWeb, '/walletsolidity/gettransactionbyid', { value: txID })
      if (transaction?.txID || transaction?.txid || transaction?.raw_data) {
        const receipt = await postNode(tronWeb, '/walletsolidity/gettransactioninfobyid', { value: txID })
        if (receipt?.id) {
          if (receipt.result === 'FAILED' || receipt.receipt?.result !== 'SUCCESS') {
            throw new Error('Solidified transaction execution failed. Transaction: ' + txID)
          }
          return receipt
        }
      }
    } catch (error) {
      if (error instanceof Error && /execution failed/.test(error.message)) throw error
      lastError = error
    }
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs))
  }
  throw new Error('Transaction has not been verified in the solidified Mainnet chain. Keep its ID and check again: ' + txID + (lastError ? ' (' + lastError.message + ')' : ''))
}

export function buildDeploymentOptions(artifact, contractName, feeLimitSun) {
  const feeLimit = Number(feeLimitSun)
  if (!Number.isSafeInteger(feeLimit) || feeLimit <= 0) throw new Error('Invalid deployment fee cap. Enter a positive whole-number TRX fee cap.')
  if (!artifact || !Array.isArray(artifact.abi)) throw new Error('Compiled contract ABI is missing or invalid. Rebuild the TRӾ contract artifacts before deployment.')
  const bytecode = String(artifact.bytecode || '').replace(/^0x/, '')
  if (!bytecode || !/^[0-9a-f]+$/i.test(bytecode)) throw new Error('Compiled contract bytecode is missing or invalid. Rebuild the TRӾ contract artifacts before deployment.')
  return {
    abi: artifact.abi,
    bytecode,
    feeLimit,
    callValue: 0,
    userFeePercentage: 100,
    originEnergyLimit: 10000000,
    name: String(contractName),
  }
}

function explainTronLinkError(error, stage) {
  const raw = typeof error === 'string' ? error : (error?.message || error?.toString?.() || 'Unknown wallet error')
  if (/Confirmation declined by user|User rejected|code.?4001/i.test(raw)) return stage + ': transaction was declined in TronLink. No retry was attempted.'
  if (/Invalid transaction provided/i.test(raw)) return stage + ': TronLink rejected the unsigned deployment transaction as invalid. Check the transaction payload and wallet/network connection. Details: ' + raw
  if (/User has not unlocked wallet/i.test(raw)) return stage + ': unlock TronLink and reconnect before trying again.'
  return stage + ': ' + raw
}

export function toWalletSignableTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
    throw new Error('TRON node returned a malformed deployment transaction.')
  }
  const rawData = transaction.raw_data
  if (!rawData || typeof rawData !== 'object' || !Array.isArray(rawData.contract)
    || rawData.contract.length !== 1 || rawData.contract[0]?.type !== 'CreateSmartContract') {
    throw new Error('TRON node returned an invalid CreateSmartContract signing payload.')
  }
  const txID = String(transaction.txID || '')
  const rawDataHex = String(transaction.raw_data_hex || '')
  if (!/^[0-9a-f]{64}$/i.test(txID) || !/^[0-9a-f]+$/i.test(rawDataHex)) {
    throw new Error('TRON node returned incomplete transaction signing fields.')
  }
  // TronLink's trx.sign accepts the protocol transaction shape only:
  // visible (optional), txID, raw_data and raw_data_hex. createSmartContract
  // also returns contract_address as UI metadata; passing that extra field
  // through to the wallet can fail its strict transaction validator.
  const signable = {
    ...(typeof transaction.visible === 'boolean' ? { visible: transaction.visible } : {}),
    txID,
    raw_data: JSON.parse(JSON.stringify(rawData)),
    raw_data_hex: rawDataHex,
  }
  return signable
}

export async function deployContractFromTronLink(wallet, artifact, contractName, feeLimitSun, {
  createClient = () => new TronWeb({ fullHost: TRON_MAINNET_HOST }),
  waitForReceipt = waitForSolidifiedReceipt,
  verifyDeployedContract = async (client, address) => client.trx.getContract(address),
} = {}) {
  // Use the app-pinned TronWeb 6.5.1 instance to build and broadcast. TronLink's
  // injected TronWeb is only the wallet signer: its bundled version can differ.
  const walletTronWeb = assertMainnetWallet(wallet)
  const tronWeb = createClient()
  if (!tronWeb?.transactionBuilder?.createSmartContract || !tronWeb?.trx?.sendRawTransaction) {
    throw new Error('The pinned TRON Mainnet transaction client could not be initialized.')
  }
  const options = buildDeploymentOptions(artifact, contractName, feeLimitSun)
  let unsigned
  try {
    unsigned = await tronWeb.transactionBuilder.createSmartContract(options, wallet.address)
  } catch (error) {
    throw new Error(explainTronLinkError(error, 'Deployment transaction construction failed'))
  }
  if (!unsigned?.txID || !/^[0-9a-f]{64}$/i.test(unsigned.txID) || !unsigned?.contract_address || !unsigned?.raw_data?.contract?.length) {
    throw new Error('TRON Mainnet returned an incomplete deployment transaction. No signature or broadcast was attempted.')
  }
  const predictedAddress = tronWeb.address.fromHex(unsigned.contract_address)
  if (!tronWeb.isAddress(predictedAddress)) throw new Error('TRON node returned an invalid predicted contract address. No signature or broadcast was attempted.')
  // Validate the plain protocol transaction, then ask the injected wallet signer.
  // TronWeb 6.5.1 returns a new signed object; broadcast that exact return value.
  const walletTransaction = toWalletSignableTransaction(unsigned)
  if (!walletTransaction.raw_data_hex || !walletTransaction.raw_data
    || !Array.isArray(walletTransaction.raw_data.contract)
    || walletTransaction.raw_data.contract.length !== 1
    || walletTransaction.raw_data.contract[0]?.type !== 'CreateSmartContract') {
    throw new Error('TRON node returned an invalid CreateSmartContract signing payload. No wallet prompt or broadcast was attempted.')
  }
  // Mainnet deployment is user-initiated: TronLink must explicitly approve signing.
  // Only the exact signed transaction is broadcast; then wait for solidification
  // and verify deployed bytecode before returning/persisting the address.
  let signed
  try {
    signed = await walletTronWeb.trx.sign(walletTransaction)
  } catch (error) {
    const contract = walletTransaction.raw_data.contract[0]
    const value = contract?.parameter?.value || {}
    const newContract = value.new_contract || {}
    const diagnostic = {
      walletTronWebVersion: String(walletTronWeb.version || 'unknown'),
      builderTronWebVersion: String(tronWeb.version || 'unknown'),
      transactionType: contract?.type || 'unknown',
      parameterTypeUrl: contract?.parameter?.type_url || 'missing',
      hasContractAddress: Boolean(walletTransaction.contract_address),
      hasOwnerAddress: Boolean(value.owner_address),
      hasNewContract: Boolean(value.new_contract),
      bytecodeLength: String(newContract.bytecode || '').length,
      abiEntries: Array.isArray(newContract.abi) ? newContract.abi.length : null,
      feeLimitSun: walletTransaction.raw_data.fee_limit ?? null,
      rawDataHexLength: walletTransaction.raw_data_hex.length,
    }
    throw new Error(explainTronLinkError(error, 'TronLink signing failed') + ' Payload diagnostics: ' + JSON.stringify(diagnostic))
  }
  const signatures = signed?.signature
  const hasValidSignature = Array.isArray(signatures)
    && signatures.length > 0
    && signatures.every(value => typeof value === 'string' && /^[0-9a-f]{130}$/i.test(value))
  // TronLink providers may normalize or omit raw_data/raw_data_hex in their
  // returned object. The signature is over txID, so require the exact original
  // txID and a well-formed signature, then rebuild the broadcast object from
  // the node-generated transaction. Never broadcast wallet-returned mutations.
  if (!signed || !hasValidSignature || signed.txID !== walletTransaction.txID) {
    const reason = !signed ? 'missing signed transaction'
      : !hasValidSignature ? 'missing or malformed 65-byte signature'
      : 'transaction ID changed'
    throw new Error('TronLink signing result failed validation (' + reason + '). Nothing was broadcast.')
  }
  // TronWeb 6.5.1 requires broadcasting the exact object returned by trx.sign().
  // Do not rebuild it: wallet/provider-specific transaction fields and signature
  // encoding must remain intact. The node performs cryptographic validation.
  let broadcast
  try {
    broadcast = await tronWeb.trx.sendRawTransaction(signed)
  } catch (error) {
    throw new Error(explainTronLinkError(error, 'Deployment broadcast request failed') + ' Check TRONSCAN for transaction ' + unsigned.txID + ' before retrying.')
  }
  if (broadcast?.result !== true) {
    let detail = broadcast?.message || broadcast?.code || 'unknown node rejection'
    try { if (typeof detail === 'string' && /^[0-9a-f]+$/i.test(detail)) detail = tronWeb.toUtf8(detail) } catch {}
    throw new Error('TRON Mainnet rejected deployment broadcast: ' + detail + '. Transaction: ' + unsigned.txID)
  }
  const receipt = await waitForReceipt(tronWeb, unsigned.txID)
  if (receipt?.receipt?.result !== 'SUCCESS') throw new Error('Deployment transaction is not confirmed successful. Transaction: ' + unsigned.txID)
  const deployed = await verifyDeployedContract(tronWeb, predictedAddress)
  if (!deployed?.bytecode) throw new Error('Deployment receipt succeeded, but deployed contract bytecode could not be verified. Transaction: ' + unsigned.txID)
  return { address: predictedAddress, txID: unsigned.txID, receipt }
}

export async function sendAndVerifyContractCall(tronWeb, method, feeLimitSun = 150000000) {
  const result = await method.send({
    feeLimit: feeLimitSun,
    callValue: 0,
    shouldPollResponse: false,
    keepTxID: true,
  })
  const txID = Array.isArray(result) ? result[0] : result
  if (typeof txID !== 'string' || !/^[0-9a-f]{64}$/i.test(txID)) throw new Error('TronLink did not return a valid transaction ID.')
  const receipt = await waitForSolidifiedReceipt(tronWeb, txID)
  return { txID, receipt }
}

export async function sendNativeTrxFromTronLink(wallet, toAddress, amountSun) {
  const tronWeb = assertMainnetWallet(wallet)
  if (!tronWeb.isAddress(toAddress)) throw new Error('Invalid reserve-vault TRON address.')
  const amount = BigInt(String(amountSun))
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid TRX funding amount.')
  const unsigned = await tronWeb.transactionBuilder.sendTrx(toAddress, Number(amount), wallet.address)
  const signed = await tronWeb.trx.sign(unsigned)
  if (!signed?.signature?.length) throw new Error('TronLink did not sign the native TRX funding transaction.')
  const broadcast = await tronWeb.trx.sendRawTransaction(signed)
  if (broadcast?.result !== true) throw new Error('TRON Mainnet rejected the TRX funding transfer.')
  const receipt = await waitForSolidifiedReceipt(tronWeb, unsigned.txID)
  return { txID: unsigned.txID, receipt }
}
