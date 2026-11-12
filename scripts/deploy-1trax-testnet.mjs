import { TronWeb } from 'tronweb'
import solc from 'solc'
import fs from 'node:fs/promises'
const network = process.env.TRON_NETWORK
const hosts = { nile: 'https://nile.trongrid.io', shasta: 'https://api.shasta.trongrid.io' }
if (!Object.hasOwn(hosts, network)) throw new Error('TRON_NETWORK must be nile or shasta; Mainnet deployment is unsupported.')
if (process.env.DEPLOY_1TRAX_TESTNET !== 'YES') throw new Error('Set DEPLOY_1TRAX_TESTNET=YES to authorize testnet deployment.')
const privateKey = process.env.TRON_PRIVATE_KEY || ''
if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('TRON_PRIVATE_KEY must be a dedicated testnet private key.')
const source = await fs.readFile(new URL('../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8')
const input = { language: 'Solidity', sources: { 'Restricted1TRAX.sol': { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter((entry) => entry.severity === 'error')
if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'))
const artifact = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
if (!artifact?.abi || !artifact.evm?.bytecode?.object) throw new Error('1TRAX compilation failed.')
const tronWeb = new TronWeb({ fullHost: hosts[network], privateKey })
const deployer = tronWeb.defaultAddress?.base58
if (!deployer) throw new Error('Could not derive testnet deployer address.')
const deployed = await tronWeb.contract().new({ abi: artifact.abi, bytecode: artifact.evm.bytecode.object, feeLimit: 1_000_000_000, callValue: 0, parameters: [], name: 'Restricted1TRAX' })
const address = deployed.address || deployed._address
if (!address) throw new Error('Deployment returned no contract address.')
console.log(JSON.stringify({ network, deployer, contractAddress: address, tokenName: 'Tron Transfer Restricted TRX Credit', tokenSymbol: '1TRAX', decimals: 6, initialTotalSupply: '0', mintingEnabled: false, paused: true, transactionId: deployed.transaction?.txID || deployed.transaction?.txid || null, warning: 'Verify a solidified SUCCESS receipt and deployed bytecode. No TRX reserve was transferred.' }, null, 2))
