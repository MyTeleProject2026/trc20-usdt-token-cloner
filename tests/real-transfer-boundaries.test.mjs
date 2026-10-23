import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const sponsorship = await readFile(new URL('../server/sponsorship-status.mjs', import.meta.url), 'utf8')

test('UI explicitly separates Shasta test assets from mainnet funds', () => {
  assert.match(app, /Shasta Testnet — test assets only/)
  assert.match(app, /cannot become mainnet USDT/)
  assert.match(app, /TRON Mainnet — real assets and network costs/)
  assert.match(app, /Fee sponsorship is currently not integrated/)
})

test('sponsorship cannot be represented as enabled without a verified integration', () => {
  assert.match(sponsorship, /enabled: false/)
  assert.match(sponsorship, /mainnetEnabled: false/)
  assert.match(sponsorship, /canSubmitSponsoredTransfer: false/)
  assert.match(sponsorship, /not-integrated/)
})


test('Mainnet USDT sending is restricted to the official TRON contract and six decimals', () => {
  assert.match(app, /const OFFICIAL_MAINNET_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'/)
  assert.match(app, /selectedAsset === 'USDT' && network !== 'mainnet'/)
  assert.match(app, /selectedAsset === 'USDT' && contractAddress\.trim\(\) !== OFFICIAL_MAINNET_USDT_CONTRACT/)
  assert.match(app, /selectedAsset === 'USDT' && decimals !== 6/)
  assert.match(app, /selectedAsset === 'USDT' && tokenSymbolValue\.toUpperCase\(\) !== 'USDT'/)
  assert.match(app, /if \(selectedAsset === 'VTRC' && network !== 'shasta'\) throw new Error/)
  assert.match(app, /setContractAddress\(OFFICIAL_MAINNET_USDT_CONTRACT\)/)
})

test('token transfer UI uses TronLink and does not request a pasted private key', () => {
  const start = app.indexOf('/* Tab 2: Interact & Balance */')
  const end = app.indexOf('/* Native TRX is the network coin', start)
  assert.ok(start >= 0 && end > start, 'token transfer UI section should exist')
  const tokenTransferUi = app.slice(start, end)
  assert.match(tokenTransferUi, /Connect \/ verify TronLink/)
  assert.doesNotMatch(tokenTransferUi, /Wallet Private Key \(local signing only\)/)
})

test('USDT remains blocked from Shasta/Nile and VTRC cannot use the official USDT contract', () => {
  assert.match(app, /Official USDT transfer is restricted to TRON Mainnet/)
  assert.match(app, /selectedAsset === 'VTRC' && network !== 'shasta'/)
  assert.match(app, /selectedAsset === 'VTRC' && contractAddress\.trim\(\) === OFFICIAL_MAINNET_USDT_CONTRACT/)
})


test('transfer records require a valid transaction hash from the wallet or node', () => {
  assert.match(app, /Wallet response did not include a valid 64-character transaction ID/)
  assert.match(app, /typeof transactionId !== 'string' \|\| !\/\^\[0-9a-fA-F\]\{64\}\$\/.test\(transactionId\)/)
  assert.match(app, /typeof txid !== 'string' \|\| !\/\^\[0-9a-fA-F\]\{64\}\$\/.test\(txid\)/)
  assert.match(app, /do not blindly resend/)
})


test('TronLink account or network changes invalidate stale transfer and balance state', () => {
  assert.match(app, /provider\.on\('accountsChanged', onAccountsChanged\)/)
  assert.match(app, /provider\.on\('chainChanged', onChainChanged\)/)
  assert.match(app, /setWalletConnected\(false\)/)
  assert.match(app, /setNativeTransferRecord\(null\)/)
  assert.match(app, /setTokenTransferRecord\(null\)/)
  assert.match(app, /provider\.removeListener\?\.\('accountsChanged', onAccountsChanged\)/)
  assert.match(app, /provider\.removeListener\?\.\('chainChanged', onChainChanged\)/)
  assert.match(app, /provider\.on\('disconnect', onDisconnected\)/)
  assert.match(app, /provider\.on\('lock', onLocked\)/)
  assert.match(app, /provider\.removeListener\?\.\('disconnect', onDisconnected\)/)
  assert.match(app, /provider\.removeListener\?\.\('lock', onLocked\)/)
})


test('wallet transfers require the exact trusted HTTPS RPC hostname', () => {
  assert.match(app, /const parsed = new URL\(rawHost\)/)
  assert.match(app, /protocol !== 'https:' \|\| hostname !== expectedHost/)
  assert.match(app, /const expectedHost = network === 'shasta' \? 'api\.shasta\.trongrid\.io' : 'api\.trongrid\.io'/)
  assert.match(app, /const handleNativeTrxTransfer = async \(\) => \{[\s\S]*?assertSelectedTronLinkNetwork\(tronWeb\)/)
})


test('native and token transfers revalidate live TronLink account/network before signing or submission', () => {
  assert.match(app, /const getCurrentAuthorizedTronWeb = \(expectedAddress: string\) =>/)
  assert.match(app, /assertSelectedTronLinkNetwork\(currentTronWeb\)/)
  assert.match(app, /currentTronWeb\.defaultAddress\.base58 !== expectedAddress/)
  assert.match(app, /const signerTronWeb = getCurrentAuthorizedTronWeb\(sender\)[\s\S]*?signerTronWeb\.trx\.sign\(transaction\)/)
  assert.match(app, /const broadcasterTronWeb = getCurrentAuthorizedTronWeb\(sender\)[\s\S]*?broadcasterTronWeb\.trx\.sendRawTransaction\(signed\)/)
  assert.match(app, /const currentContract = await currentTronWeb\.contract\(\)\.at\(contractAddress\.trim\(\)\)/)
  assert.match(app, /currentContract\.balanceOf\(sender\)\.call\(\)/)
  assert.match(app, /getCurrentAuthorizedTronWeb\(sender\)[\s\S]*?currentContract\.transfer\(recipientAddress\.trim\(\), rawAmount\)\.send/)
})


test('connection requires recognized TronLink identity and the standard authorization prompt', () => {
  assert.match(app, /provider\.isTronLink !== true/)
  assert.match(app, /provider\.request\(\{ method: 'eth_requestAccounts' \}\)/)
  assert.match(app, /const authorizedAccounts = await provider\.request\(\{ method: 'eth_requestAccounts' \}\)/)
  assert.match(app, /authorizedAccounts\[0\] !== tronWeb\.defaultAddress\.base58/)
  assert.match(app, /No transfer will be signed by an unverified provider/)
})

test('native TRX validates amount and sender before displaying the final confirmation', () => {
  const start = app.indexOf('const handleNativeTrxTransfer = async () => {')
  const amountGuard = app.indexOf('if (!Number.isSafeInteger(Number(sun)))', start)
  const senderGuard = app.indexOf('if (!sender || !tronWeb.isAddress(sender))', start)
  const confirmation = app.indexOf("const confirmationMessage = 'Confirm native TRX transfer", start)
  assert.ok(start >= 0 && amountGuard > start && senderGuard > amountGuard && confirmation > senderGuard)
  assert.match(app, /Network fees depend on wallet resources and the network/)
  assert.match(app, /review the fee and the full transaction in TronLink before signing/i)
})


test('token confirmation discloses the configured maximum contract-call fee limit', () => {
  assert.match(app, /Contract-call feeLimit: up to 100 TRX \(100,000,000 SUN/)
  assert.match(app, /current contract-call feeLimit is up to 100 TRX/)
  assert.match(app, /Review the transaction and fee in TronLink and cancel if anything differs/)
})

test('RPC validation rejects path-bearing URLs in addition to wrong hosts', () => {
  assert.match(app, /\(parsed\.pathname !== '' && parsed\.pathname !== '\/'\)/)
  assert.match(app, /protocol !== 'https:' \|\| hostname !== expectedHost/)
})
