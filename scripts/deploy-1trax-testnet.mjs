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
const tronWeb = new TronWeb({ fullHost: host, privateKey })
const deployer = tronWeb.defaultAddress?.base58
if (!deployer) throw new Error('Could not derive testnet deployer address.')

const sources = {
  'OneTraxReserveVault.sol': await fs.readFile(new URL('../contracts/OneTraxReserveVault.sol', import.meta.url), 'utf8'),
  'Restricted1TRAX.sol': await fs.readFile(new URL('../contracts/Restricted1TRAX.sol', import.meta.url), 'utf8'),
}
const output = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: Object.fromEntries(Object.entries(sources).map(([name, content]) => [name, { content }])),
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})))
const errors = (output.errors || []).filter((entry) => entry.severity === 'error')
if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'))
const vaultArtifact = output.contracts?.['OneTraxReserveVault.sol']?.OneTraxReserveVault
const tokenArtifact = output.contracts?.['Restricted1TRAX.sol']?.Restricted1TRAX
if (!vaultArtifact?.abi || !vaultArtifact.evm?.bytecode?.object || !tokenArtifact?.abi || !tokenArtifact.evm?.bytecode?.object) throw new Error('1TRAX contract compilation failed.')

async function post(path, body) {
  const response = await fetch(host + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error('TRON node returned HTTP ' + response.status + ' for ' + path)
  return response.json()
}
async function waitForSolidified(txID) {
  let info = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    info = await post('/walletsolidity/gettransactioninfobyid', { value: txID })
    if (info?.id) break
    await delay(3000)
  }
  if (!info?.id) throw new Error('Transaction is broadcast but not solidified: ' + txID)
  if (info.result === 'FAILED' || info.receipt?.result !== 'SUCCESS') throw new Error('Solidified transaction failed: ' + txID)
  return info
}
async function verifyBytecode(addressHex) {
  const info = await post('/wallet/getcontractinfo', { value: addressHex, visible: false })
  if (!info?.bytecode) throw new Error('Contract bytecode verification failed for ' + addressHex)
}
async function deployContract(artifact, name) {
  const tx = await tronWeb.transactionBuilder.createSmartContract({
    abi: JSON.stringify(artifact.abi),
    bytecode: artifact.evm.bytecode.object,
    feeLimit: 1_000_000_000,
    callValue: 0,
    userFeePercentage: 1,
    originEnergyLimit: 10_000_000,
    name,
  }, deployer)
  const signed = await tronWeb.trx.sign(tx, privateKey)
  const broadcast = await tronWeb.trx.sendRawTransaction(signed)
  if (broadcast?.result !== true) throw new Error(name + ' deployment broadcast was rejected.')
  await waitForSolidified(tx.txID)
  await verifyBytecode(tx.contract_address)
  return { addressHex: tx.contract_address, address: tronWeb.address.fromHex(tx.contract_address), txID: tx.txID }
}
async function sendAndConfirm(method, label) {
  const result = await method.send({ feeLimit: 100_000_000, callValue: 0, shouldPollResponse: true, keepTxID: true })
  if (!Array.isArray(result) || result[1] !== true) throw new Error(label + ' did not return a successful confirmed result.')
  if (result[0]) await waitForSolidified(result[0])
  return result[0]
}

const vaultDeployment = await deployContract(vaultArtifact, 'OneTraxReserveVault')
const tokenDeployment = await deployContract(tokenArtifact, 'Restricted1TRAX')
const vault = await tronWeb.contract(vaultArtifact.abi, vaultDeployment.address)
const token = await tronWeb.contract(tokenArtifact.abi, tokenDeployment.address)
const authorizeTx = await sendAndConfirm(vault.setAuthorizedToken(tokenDeployment.address), 'Authorize 1TRAX token in reserve vault')
const linkVaultTx = await sendAndConfirm(token.setReserveVault(vaultDeployment.address), 'Link reserve vault in 1TRAX token')
const [authorizedToken, linkedVault, paused, mintingEnabled] = await Promise.all([
  vault.authorizedToken().call(),
  token.reserveVault().call(),
  token.paused().call(),
  token.mintingEnabled().call(),
])
if (tronWeb.address.toHex(authorizedToken) !== tronWeb.address.toHex(tokenDeployment.address)) throw new Error('Reserve vault authorization did not verify.')
if (tronWeb.address.toHex(linkedVault) !== tronWeb.address.toHex(vaultDeployment.address)) throw new Error('1TRAX reserve-vault link did not verify.')
if (paused !== true || mintingEnabled !== false) throw new Error('1TRAX did not remain paused with minting disabled.')
console.log(JSON.stringify({
  network, deployer,
  reserveVault: { address: vaultDeployment.address, deploymentTx: vaultDeployment.txID, authorizationTx: authorizeTx },
  token: { address: tokenDeployment.address, deploymentTx: tokenDeployment.txID, vaultLinkTx: linkVaultTx },
  initialTotalSupply: '0', mintingEnabled: false, paused: true,
  warning: 'No reserve TRX was transferred. Fund the dedicated vault with testnet TRX before enabling minting. Never use Mainnet with this script.',
}, null, 2))
