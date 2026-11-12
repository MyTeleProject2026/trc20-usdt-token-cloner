import { TronWeb } from 'tronweb'
import solc from 'solc'
import fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const network = process.env.TRON_NETWORK
const hosts = { nile: 'https://nile.trongrid.io', shasta: 'https://api.shasta.trongrid.io' }
if (!Object.hasOwn(hosts, network)) throw new Error('TRON_NETWORK must be nile or shasta; Mainnet deployment is unsupported.')
if (process.env.DEPLOY_1TRAX_TESTNET !== 'YES') throw new Error('Set DEPLOY_1TRAX_TESTNET=YES to authorize testnet deployment.')
const privateKey = process.env.TRON_PRIVATE_KEY || ''
if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('TRON_PRIVATE_KEY must be a dedicated testnet private key.')

const host = hosts[network]
const source = await fs.readFile(new URL('../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
const input = { language: 'Solidity', sources: { 'Restricted1TRAX.sol': { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter((entry) => entry.severity === 'error')
if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'))
const artifact = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
if (!artifact?.abi || !artifact.evm?.bytecode?.object) throw new Error('1TRAX compilation failed.')

const tronWeb = new TronWeb({ fullHost: host, privateKey })
const deployer = tronWeb.defaultAddress?.base58
if (!deployer) throw new Error('Could not derive testnet deployer address.')
const unsigned = await tronWeb.transactionBuilder.createSmartContract({
  abi: JSON.stringify(artifact.abi),
  bytecode: artifact.evm.bytecode.object,
  feeLimit: 1_000_000_000,
  callValue: 0,
  userFeePercentage: 1,
  originEnergyLimit: 10_000_000,
  name: 'Restricted1TRAX',
}, deployer)
const signed = await tronWeb.trx.sign(unsigned, privateKey)
const broadcast = await tronWeb.trx.sendRawTransaction(signed)
if (broadcast?.result !== true) throw new Error('Testnet deployment broadcast was rejected.')
const txID = unsigned.txID
const contractAddress = unsigned.contract_address
if (!txID || !contractAddress) throw new Error('Deployment transaction is missing its transaction ID or derived contract address.')

async function post(path, body) {
  const response = await fetch(host + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error('TRON node returned HTTP ' + response.status + ' for ' + path)
  return response.json()
}
let receipt = null
for (let attempt = 0; attempt < 40; attempt += 1) {
  receipt = await post('/walletsolidity/gettransactioninfobyid', { value: txID })
  if (receipt?.id) break
  await delay(3000)
}
if (!receipt?.id) throw new Error('Deployment is broadcast but not yet solidified; check transaction ' + txID)
if (receipt.result === 'FAILED' || receipt.receipt?.result !== 'SUCCESS') {
  throw new Error('Solidified deployment failed. Inspect transaction ' + txID)
}
const deployedInfo = await post('/walletsolidity/getcontractinfo', { value: contractAddress, visible: true })
if (!deployedInfo?.bytecode) throw new Error('Receipt succeeded but deployed contract bytecode was not confirmed.')
console.log(JSON.stringify({
  network, deployer, contractAddress, transactionId: txID,
  receipt: 'solidified-success', bytecodeVerified: true,
  tokenName: 'Tron Transfer Restricted TRX Credit', tokenSymbol: '1TRAX',
  decimals: 6, initialTotalSupply: '0', mintingEnabled: false, paused: true,
  warning: 'No TRX reserve was transferred. The contract is testnet-only and starts paused with minting disabled.',
}, null, 2))
