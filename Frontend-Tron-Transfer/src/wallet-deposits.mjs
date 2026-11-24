export function getIncomingNativeTrxTransfers(transactions, address, addressHex) {
  if (!Array.isArray(transactions) || !address || !addressHex) return []
  const rows = []
  for (const transaction of transactions) {
    const txid = String(transaction?.txID || transaction?.txid || '')
    if (!/^[0-9a-f]{64}$/i.test(txid)) continue
    const contracts = transaction?.raw_data?.contract
    if (!Array.isArray(contracts)) continue
    for (const contract of contracts) {
      if (contract?.type !== 'TransferContract') continue
      const value = contract?.parameter?.value || {}
      const recipient = String(value.to_address || '').toLowerCase()
      if (recipient !== String(addressHex).toLowerCase() && recipient !== String(address).toLowerCase()) continue
      const amountSun = String(value.amount ?? '')
      if (!/^[1-9][0-9]*$/.test(amountSun)) continue
      rows.push({ txid, amountSun, timestamp: Number(transaction.block_timestamp) || null })
    }
  }
  return rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
}

export function getIncomingUsdtTransfers(transfers, address) {
  if (!Array.isArray(transfers) || !address) return []
  return transfers.filter(item =>
    typeof item?.transaction_id === 'string'
    && /^[0-9a-f]{64}$/i.test(item.transaction_id)
    && String(item.to || '').toLowerCase() === String(address).toLowerCase()
    && /^[1-9][0-9]*$/.test(String(item.value || ''))
  ).map(item => ({
    txid: item.transaction_id,
    value: String(item.value),
    timestamp: Number(item.block_timestamp) || null,
  })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
}

export function formatDepositAmount(raw, decimals = 6) {
  try {
    const units = BigInt(String(raw || '0'))
    const scale = 10n ** BigInt(decimals)
    const whole = (units / scale).toString()
    const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
    return fraction ? whole + '.' + fraction : whole
  } catch { return '0' }
}
