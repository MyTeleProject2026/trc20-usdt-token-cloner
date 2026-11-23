import { TronWeb } from 'tronweb'

const MAINNET_HOST = 'https://api.trongrid.io'

/** Read-only Sponsor workspace RPC client. Signing authority stays in the Resource API. */
export function createSponsorTronWeb() {
  return new TronWeb({ fullHost: MAINNET_HOST })
}
