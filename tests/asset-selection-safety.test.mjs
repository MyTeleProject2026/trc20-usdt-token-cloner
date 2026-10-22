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
  const handler = sectionBetween('const handleNativeTrxTransfer = async () => {', 'const handleVerifyNativeTransfer = async () => {')
  const assetGuard = handler.indexOf("selectedAsset !== 'TRX'")
  assert.ok(assetGuard >= 0, 'native transfer must require TRX selection')
  const walletAccess = handler.indexOf('getInjectedTronWeb()')
  assert.ok(walletAccess < 0 || assetGuard < walletAccess, 'asset mismatch must be rejected before wallet access')
  assert.match(handler, /assertSelectedTronLinkNetwork/, 'native transfer must validate the selected network')
})

test('wallet network validation rejects a Shasta/Mainnet mismatch', () => {
  const guard = sectionBetween('const assertSelectedTronLinkNetwork =', 'const getInjectedTronWeb =')
  assert.match(guard, /network === 'shasta'.*shasta/s)
  assert.match(guard, /network === 'mainnet'/)
  assert.match(guard, /api\.trongrid\.io/)
})
