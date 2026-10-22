import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

function sectionBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker)
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`)
  return appSource.slice(start, end)
}

test('TRC-20 handler fails closed for native TRX and USDT asset selections', () => {
  const handler = sectionBetween('const handleTransfer = async () => {', 'const handleVerifyTokenTransfer = async () => {')
  const trxGuard = handler.indexOf("selectedAsset === 'TRX'")
  const usdtGuard = handler.indexOf("selectedAsset === 'USDT'")
  const sendStart = handler.indexOf('setTransferring(true)')
  assert.ok(trxGuard >= 0 && trxGuard < sendStart, 'TRX selection must be rejected before transfer begins')
  assert.ok(usdtGuard >= 0 && usdtGuard < sendStart, 'USDT selection must be rejected before transfer begins')
  assert.match(handler, /network !== 'shasta'/, 'VTRC must be restricted to Shasta')
  assert.match(handler, /TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/, 'known Mainnet USDT contract must not pass as VTRC')
})

test('native TRX handler checks selected asset before any send attempt', () => {
  const handler = sectionBetween('const handleNativeTrxTransfer = async () => {', 'const handleVerifyTx = async () => {')
  const assetGuard = handler.indexOf("selectedAsset !== 'TRX'")
  assert.ok(assetGuard >= 0, 'native transfer must require TRX selection')
  const walletAccess = handler.indexOf('getInjectedTronWeb()')
  assert.ok(walletAccess < 0 || assetGuard < walletAccess, 'asset mismatch must be rejected before wallet access')
  assert.match(handler, /fullNodeHost/, 'native transfer must inspect the connected wallet node')
  assert.match(handler, /network === 'shasta'.*isShastaWallet/s, 'Shasta selection must reject a non-Shasta wallet')
  assert.match(handler, /network === 'mainnet'.*isShastaWallet/s, 'Mainnet selection must reject a Shasta wallet')
})

test('wallet network validation rejects a Shasta/Mainnet mismatch', () => {
  const guard = sectionBetween('const assertSelectedTronLinkNetwork =', 'const getInjectedTronWeb =')
  assert.match(guard, /network === 'shasta'.*shasta/s)
  assert.match(guard, /network === 'mainnet'/)
  assert.match(guard, /api\.trongrid\.io/)
})

test('changing networks clears the previous wallet connection and account snapshot', () => {
  const effect = sectionBetween('useEffect(() => {\n    setTronBlock(null)', '  }, [network])')
  assert.match(effect, /setWalletConnected\(false\)/, 'network changes must require wallet reconnection')
  assert.match(effect, /setAccountData\(null\)/, 'network-specific account details must be discarded')
  assert.match(effect, /setPrivateKey\(''\)/, 'locally held signing material must not carry across network switches')
  assert.match(effect, /setWalletAddress\(''\)/, 'the previous network wallet address must be cleared')
  assert.match(effect, /setNativeTransferRecord\(null\)/, 'native transfer context must not carry across networks')
  assert.match(effect, /setTokenTransferRecord\(null\)/, 'token transfer context must not carry across networks')
  assert.match(effect, /setNativeVerifyResult\(null\)/, 'native verification result must not be reused across networks')
  assert.match(effect, /setTokenVerifyResult\(null\)/, 'token verification result must not be reused across networks')
  assert.match(effect, /fetchStatus\(\)/, 'the selected network status must be refreshed')
})
