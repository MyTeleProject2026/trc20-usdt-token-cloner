const TRONSCAN_KEY_NAMES = Object.freeze(['TRONSCAN_PRO_API_KEY', 'TRONSCAN_API_KEY'])

export function resolveTronScanApiKey(env = process.env) {
  for (const name of TRONSCAN_KEY_NAMES) {
    const value = typeof env?.[name] === 'string' ? env[name].trim() : ''
    if (value) return Object.freeze({ value, source: name })
  }
  return Object.freeze({ value: '', source: null })
}
