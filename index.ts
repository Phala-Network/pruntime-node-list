require('dotenv').config()

import fs from 'node:fs'
import * as R from 'ramda'
import { options, createPruntimeClient } from '@phala/sdk'
import { ApiPromise, WsProvider, HttpProvider } from '@polkadot/api'

const argv = require('arg')({
  '--ws': String,
  '--http': Boolean,
})

type PoormanEither = [boolean, string]

//
// @returns [workerId, endpointUrl, isAvailable, errorMessage]
//
async function diagnoseEndpointAvailability([workerId, endpointUrl]: [string, string]) {
  const checkEndpoint = async () => {
    try {
      const client = createPruntimeClient(endpointUrl)
      const info = await client.getInfo({})
      if (`0x${info.ecdhPublicKey || ''}` === workerId) {
        return [true, null] as const
      }
      return [false, 'On-chain worker ID not match to the worker ECDH PublicKey.']
    } catch (err) {
      return [false, `${err}`] as const
    }
  }
  const result = await Promise.race([
    checkEndpoint(),
    new Promise((resolve) => setTimeout(() => resolve([false, 'Timeout after 3 secs, worker might be offline.'] as const), 3_000)),
  ]) as PoormanEither
  return [workerId, endpointUrl, ...result]
}

async function main() {
  const ws = argv['--ws'] || process.env.ENDPOINT
  if (!ws) {
    throw new Error('No ws endpoint specified')
  }
  const provider = argv['--http'] ? new HttpProvider(ws.replace('wss://', 'https://').replace('ws://', 'http://')) : new WsProvider(ws)
  const apiPromise = await ApiPromise.create(options({
    provider,
    noInitWarn: true
  }))

  // 1. Getting all registered workers by cluster.
  console.log('getting all registered workers...')
  const clusterWorkersQuery = await apiPromise.query.phalaPhatContracts.clusterWorkers.entries()
  const clusterWorkers = clusterWorkersQuery.map(([storageKeys, workerList]) => {
    const clusterId = storageKeys.args[0].toHex()
    // @ts-ignore
    return [clusterId, workerList.map(i => i.toHex())]
  })

  // 2. Get all registered endpoint from on-chain.
  console.log('getting all registered endpoints...')
  const endpointsQuery = await apiPromise.query.phalaRegistry.endpoints.entries()
  const endpointInfos = endpointsQuery.map(([storageKeys, endpoint]) => {
    const endpointId = storageKeys.args[0].toHex()
    // @ts-ignore
    return [endpointId, endpoint.toHuman()?.V1?.[0]]
  })

  // 3. batch check all pruntime endpoint.
  console.log('checking all pruntime endpoint...')
  // @ts-ignore
  const result = await Promise.all(endpointInfos.map(diagnoseEndpointAvailability))

  // 4. Print to console.
  console.log("\n")
  const availableNodes: Record<string, string[]> = {}
  for (let group of clusterWorkers) {
    const [clusterId, workerIds] = group
    console.log(`cluster=${clusterId}`)
    if (!availableNodes[clusterId]) {
      availableNodes[clusterId] = []
    }
    for (let workerId of workerIds) {
      const diagnoseResult = R.find(([_workerId]) => _workerId === workerId, result)
      if (!diagnoseResult) {
        console.log(`  ❌ ${workerId} Worker not found.`)
        continue
      }
      const [_endpointId, endpointUrl, isAvailable, errorMessage] = diagnoseResult
      console.log(`  ${isAvailable ? '✅' : '❌'} ${workerId} ${endpointUrl} ${errorMessage || ''}`)
      if (isAvailable) {
        availableNodes[clusterId].push(endpointUrl as string)
      }
    }
  }

  // 5. Write to file.
  fs.writeFileSync('_site/nodes.json', JSON.stringify(availableNodes, null, 2))

  let pages = fs.readFileSync('src/index.md', 'utf-8')
  pages += '\nUpdated at: ' + new Date().toISOString() + '\n'
  fs.writeFileSync('src/index.md', pages)
}

function handleUncaughtExceptionOrRejection() {}
process.on('unhandledRejection', handleUncaughtExceptionOrRejection);
process.on('uncaughtException', handleUncaughtExceptionOrRejection);


main().catch(console.error).finally(() => process.exit())