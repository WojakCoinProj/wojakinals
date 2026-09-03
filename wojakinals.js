#!/usr/bin/env node

const wojakcore = require('bitcore-lib-wojak')
const axios = require('axios')
const fs = require('fs')
const dotenv = require('dotenv')
const mime = require('mime-types')
const express = require('express')
const { PrivateKey, Address, Transaction, Script, Opcode } = wojakcore
const { Hash, Signature } = wojakcore.crypto

dotenv.config()

if (process.env.TESTNET == 'true') {
    wojakcore.Networks.defaultNetwork = wojakcore.Networks.testnet
}

// bitcore-lib-wojak already defaults to a Wojakcoin-appropriate rate; this is
// only for overriding it.
if (process.env.FEE_PER_KB) {
    Transaction.FEE_PER_KB = parseInt(process.env.FEE_PER_KB)
}

const WALLET_PATH = process.env.WALLET || '.wallet.json'

async function rpc(method, params = []) {
    if (!process.env.NODE_RPC_URL) {
        throw new Error('NODE_RPC_URL is not set')
    }

    try {
        const response = await axios.post(
            process.env.NODE_RPC_URL,
            { jsonrpc: '1.0', id: method, method, params },
            {
                auth: {
                    username: process.env.NODE_RPC_USER,
                    password: process.env.NODE_RPC_PASS
                }
            }
        )

        if (response.data.error) {
            throw new Error(response.data.error.message || JSON.stringify(response.data.error))
        }

        return response.data.result
    } catch (e) {
        const msg = e.response && e.response.data && e.response.data.error && e.response.data.error.message
        if (msg) throw new Error(msg)
        throw e
    }
}


async function main() {
    let cmd = process.argv[2]

    if (fs.existsSync('pending-txs.json')) {
        console.log('found pending-txs.json. rebroadcasting...')
        const txs = JSON.parse(fs.readFileSync('pending-txs.json'))
        await broadcastAll(txs.map(tx => new Transaction(tx)), false)
        return 
    }

    if (cmd == 'mint') {
        await mint()
    } else if (cmd == 'wallet') {
        await wallet()
    } else if (cmd == 'server') {
        await server()
    } else if (cmd == 'wjk-20' || cmd == 'wjk20') {
        await wjk20()
    } else {
        throw new Error(`unknown command: ${cmd}`)
    }
}


async function wallet() {
    let subcmd = process.argv[3]

    if (subcmd == 'new') {
        await walletNew()
    } else if (subcmd == 'sync') {
        await walletSync()
    } else if (subcmd == 'balance') {
        walletBalance()
    } else if (subcmd == 'send') {
        await walletSend()
    } else if (subcmd == 'split') {
        await walletSplit()
    } else {
        throw new Error(`unknown subcommand: ${subcmd}`)
    }
}


async function importPrivNoRescan(privkey) {
    try {
        await rpc('importprivkey', [privkey, 'wojakinals', false])
    } catch (e) {
        if (!/already/i.test(e.message)) throw e
    }
}


async function walletNew() {
    if (!fs.existsSync(WALLET_PATH)) {
        const privateKey = new PrivateKey()
        const privkey = privateKey.toWIF()
        const address = privateKey.toAddress().toString()
        const json = { privkey, address, utxos: [] }
        fs.writeFileSync(WALLET_PATH, JSON.stringify(json, 0, 2))
        await importPrivNoRescan(privkey)
        console.log('address', address)
    } else {
        throw new Error('wallet already exists')
    }
}


async function walletSync() {
    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

    console.log(`syncing utxos with ${process.env.NODE_RPC_URL}`)

    await importPrivNoRescan(wallet.privkey)

    const scan = await rpc('scantxoutset', ['start', [`addr(${wallet.address})`]])
    const utxos = (scan.unspents || []).map(output => ({
        txid: output.txid,
        vout: output.vout,
        script: output.scriptPubKey,
        satoshis: Math.round(output.amount * 1e8)
    }))

    const seen = new Set(utxos.map(u => `${u.txid}:${u.vout}`))
    const mempool = await rpc('listunspent', [0, 0, [wallet.address]])
    for (const utxo of mempool || []) {
        const key = `${utxo.txid}:${utxo.vout}`
        if (seen.has(key)) continue
        utxos.push({
            txid: utxo.txid,
            vout: utxo.vout,
            script: utxo.scriptPubKey,
            satoshis: Math.round(utxo.amount * 1e8)
        })
    }

    wallet.utxos = utxos
    fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, 0, 2))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)

    console.log('balance', balance)
}


function walletBalance() {
    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)

    console.log(wallet.address, balance)
}


async function walletSend() {
    const argAddress = process.argv[4]
    const argAmount = process.argv[5]

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    if (balance == 0) throw new Error('no funds to send')

    let receiver = new Address(argAddress)
    let amount = parseInt(argAmount)

    let tx = new Transaction()
    if (amount) {
        tx.to(receiver, amount)
        fund(wallet, tx)
    } else {
        tx.from(wallet.utxos)
        tx.change(receiver)
        tx.sign(wallet.privkey)
    }

    await broadcast(tx, true)

    console.log(tx.hash)
}


async function walletSplit() {
    let splits = parseInt(process.argv[4])

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    if (balance == 0) throw new Error('no funds to split')

    let tx = new Transaction()
    tx.from(wallet.utxos)
    for (let i = 0; i < splits - 1; i++) {
        tx.to(wallet.address, Math.floor(balance / splits))
    }
    tx.change(wallet.address)
    tx.sign(wallet.privkey)

    await broadcast(tx, true)

    console.log(tx.hash)
}


const MAX_SCRIPT_ELEMENT_SIZE = 520

async function wjk20() {
    const subcmd = process.argv[3]
    if (subcmd === 'mint' || subcmd === 'transfer') {
        await wjk20MintOrTransfer(subcmd)
    } else if (subcmd === 'deploy') {
        await wjk20Deploy()
    } else {
        throw new Error('unknown subcommand: ' + subcmd + '\nusage: node wojakinals.js wjk-20 deploy|mint|transfer ...')
    }
}

function wjk20Tick(tick) {
    if (!tick || !/^[A-Za-z0-9]{2,8}$/.test(tick)) {
        throw new Error('tick must be 2-8 alphanumeric characters')
    }
    return tick.toLowerCase()
}

async function wjk20Deploy() {
    const argAddress = process.argv[4]
    const argTicker = wjk20Tick(process.argv[5])
    const argMax = process.argv[6]
    const argLimit = process.argv[7]

    if (!argAddress || !argMax || !argLimit) {
        throw new Error('usage: node wojakinals.js wjk-20 deploy <address> <tick> <max> <lim>')
    }

    const payload = {
        p: 'wjk-20',
        op: 'deploy',
        tick: argTicker,
        max: String(argMax),
        lim: String(argLimit)
    }

    console.log('deploying', JSON.stringify(payload))
    await mint(argAddress, 'text/plain;charset=utf-8', Buffer.from(JSON.stringify(payload)).toString('hex'))
}

async function wjk20MintOrTransfer(op) {
    const argAddress = process.argv[4]
    const argTicker = wjk20Tick(process.argv[5])
    const argAmount = process.argv[6]
    const argRepeat = Number(process.argv[7]) || 1

    if (!argAddress || !argAmount) {
        throw new Error(`usage: node wojakinals.js wjk-20 ${op} <address> <tick> <amt> [repeat]`)
    }

    const payload = {
        p: 'wjk-20',
        op,
        tick: argTicker,
        amt: String(argAmount)
    }

    const hex = Buffer.from(JSON.stringify(payload)).toString('hex')
    for (let i = 0; i < argRepeat; i++) {
        console.log(`${op} ${argTicker} ${i + 1} of ${argRepeat}:`, JSON.stringify(payload))
        await mint(argAddress, 'text/plain;charset=utf-8', hex)
    }
}

async function mint(paramAddress, paramContentTypeOrFilename, paramHexData) {
    const argAddress = paramAddress || process.argv[3]
    const argContentTypeOrFilename = paramContentTypeOrFilename || process.argv[4]
    const argHexData = paramHexData || process.argv[5]


    let address = new Address(argAddress)
    let contentType
    let data

    if (fs.existsSync(argContentTypeOrFilename)) {
        contentType = mime.contentType(mime.lookup(argContentTypeOrFilename))
        data = fs.readFileSync(argContentTypeOrFilename)
    } else {
        contentType = argContentTypeOrFilename
        if (!/^[a-fA-F0-9]*$/.test(argHexData)) throw new Error('data must be hex')
        data = Buffer.from(argHexData, 'hex')
    }

    if (data.length == 0) {
        throw new Error('no data to mint')
    }

    if (contentType.length > MAX_SCRIPT_ELEMENT_SIZE) {
        throw new Error('content type too long')
    }


    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

    let txs = inscribe(wallet, address, contentType, data)

    await broadcastAll(txs, false)
}

async function broadcastAll(txs, retry) {
    for (let i = 0; i < txs.length; i++) {
        console.log(`broadcasting tx ${i + 1} of ${txs.length}`)

        try {
            await broadcast(txs[i], retry)
        } catch (e) {
            console.log('broadcast failed', e)
            console.log('saving pending txs to pending-txs.json')
            console.log('to reattempt broadcast, re-run the command')
            fs.writeFileSync('pending-txs.json', JSON.stringify(txs.slice(i).map(tx => tx.toString())))
            process.exit(1)
        }
    }

    if (fs.existsSync('pending-txs.json')) fs.unlinkSync('pending-txs.json')

    console.log('inscription txid:', txs[1].hash)
}


function bufferToChunk(b, type) {
    b = Buffer.from(b, type)
    return {
        buf: b.length ? b : undefined,
        len: b.length,
        opcodenum: b.length <= 75 ? b.length : b.length <= 255 ? 76 : 77
    }
}

function numberToChunk(n) {
    return {
        buf: n <= 16 ? undefined : n < 128 ? Buffer.from([n]) : Buffer.from([n % 256, n / 256]),
        len: n <= 16 ? 0 : n < 128 ? 1 : 2,
        opcodenum: n == 0 ? 0 : n <= 16 ? 80 + n : n < 128 ? 1 : 2
    }
}

function opcodeToChunk(op) {
    return { opcodenum: op }
}


const MAX_CHUNK_LEN = 240
const MAX_PAYLOAD_LEN = 1500


function inscribe(wallet, address, contentType, data) {
    let txs = []


    let privateKey = new PrivateKey(wallet.privkey)
    let publicKey = privateKey.toPublicKey()


    let parts = []
    while (data.length) {
        let part = data.slice(0, Math.min(MAX_CHUNK_LEN, data.length))
        data = data.slice(part.length)
        parts.push(part)
    }


    let inscription = new Script()
    inscription.chunks.push(bufferToChunk('ord'))
    inscription.chunks.push(numberToChunk(parts.length))
    inscription.chunks.push(bufferToChunk(contentType))
    parts.forEach((part, n) => {
        inscription.chunks.push(numberToChunk(parts.length - n - 1))
        inscription.chunks.push(bufferToChunk(part))
    })



    let p2shInput
    let lastLock
    let lastPartial

    while (inscription.chunks.length) {
        let partial = new Script()

        if (txs.length == 0) {
            partial.chunks.push(inscription.chunks.shift())
        }

        while (partial.toBuffer().length <= MAX_PAYLOAD_LEN && inscription.chunks.length) {
            partial.chunks.push(inscription.chunks.shift())
            partial.chunks.push(inscription.chunks.shift())
        }

        if (partial.toBuffer().length > MAX_PAYLOAD_LEN) {
            inscription.chunks.unshift(partial.chunks.pop())
            inscription.chunks.unshift(partial.chunks.pop())
        }


        let lock = new Script()
        lock.chunks.push(bufferToChunk(publicKey.toBuffer()))
        lock.chunks.push(opcodeToChunk(Opcode.OP_CHECKSIGVERIFY))
        partial.chunks.forEach(() => {
            lock.chunks.push(opcodeToChunk(Opcode.OP_DROP))
        })
        lock.chunks.push(opcodeToChunk(Opcode.OP_TRUE))



        let lockhash = Hash.ripemd160(Hash.sha256(lock.toBuffer()))


        let p2sh = new Script()
        p2sh.chunks.push(opcodeToChunk(Opcode.OP_HASH160))
        p2sh.chunks.push(bufferToChunk(lockhash))
        p2sh.chunks.push(opcodeToChunk(Opcode.OP_EQUAL))


        let p2shOutput = new Transaction.Output({
            script: p2sh,
            satoshis: 100000
        })


        let tx = new Transaction()
        if (p2shInput) tx.addInput(p2shInput)
        tx.addOutput(p2shOutput)
        fund(wallet, tx)

        if (p2shInput) {
            let signature = Transaction.sighash.sign(tx, privateKey, Signature.SIGHASH_ALL, 0, lastLock)
            let txsignature = Buffer.concat([signature.toBuffer(), Buffer.from([Signature.SIGHASH_ALL])])

            let unlock = new Script()
            unlock.chunks = unlock.chunks.concat(lastPartial.chunks)
            unlock.chunks.push(bufferToChunk(txsignature))
            unlock.chunks.push(bufferToChunk(lastLock.toBuffer()))
            tx.inputs[0].setScript(unlock)
        }


        updateWallet(wallet, tx)
        txs.push(tx)

        p2shInput = new Transaction.Input({
            prevTxId: tx.hash,
            outputIndex: 0,
            output: tx.outputs[0],
            script: ''
        })

        p2shInput.clearSignatures = () => {}
        p2shInput.getSignatures = () => []
        p2shInput.isFullySigned = () => true
        p2shInput.addSignature = () => {}


        lastLock = lock
        lastPartial = partial

    }


    let tx = new Transaction()
    tx.addInput(p2shInput)
    tx.to(address, 100000)
    fund(wallet, tx)

    let signature = Transaction.sighash.sign(tx, privateKey, Signature.SIGHASH_ALL, 0, lastLock)
    let txsignature = Buffer.concat([signature.toBuffer(), Buffer.from([Signature.SIGHASH_ALL])])

    let unlock = new Script()
    unlock.chunks = unlock.chunks.concat(lastPartial.chunks)
    unlock.chunks.push(bufferToChunk(txsignature))
    unlock.chunks.push(bufferToChunk(lastLock.toBuffer()))
    tx.inputs[0].setScript(unlock)

    updateWallet(wallet, tx)
    txs.push(tx)


    return txs
}


function fund(wallet, tx) {
    tx.change(wallet.address)
    delete tx._fee

    for (const utxo of wallet.utxos) {
        if (tx.inputs.length && tx.outputs.length && tx.inputAmount >= tx.outputAmount + tx.getFee()) {
            break
        }

        delete tx._fee
        tx.from(utxo)
        tx.change(wallet.address)
        tx.sign(wallet.privkey)
    }

    if (tx.inputAmount < tx.outputAmount + tx.getFee()) {
        throw new Error('not enough funds')
    }
}


function updateWallet(wallet, tx) {
    wallet.utxos = wallet.utxos.filter(utxo => {
        for (const input of tx.inputs) {
            if (input.prevTxId.toString('hex') == utxo.txid && input.outputIndex == utxo.vout) {
                return false
            }
        }
        return true
    })

    tx.outputs
        .forEach((output, vout) => {
            if (output.script.toAddress().toString() == wallet.address) {
                wallet.utxos.push({
                    txid: tx.hash,
                    vout,
                    script: output.script.toHex(),
                    satoshis: output.satoshis
                })
            }
        })
}


async function broadcast(tx, retry) {
    while (true) {
        try {
            await rpc('sendrawtransaction', [tx.toString()])
            break
        } catch (e) {
            if (!retry) throw e
            if (e.message && e.message.includes('too-long-mempool-chain')) {
                console.warn('retrying, too-long-mempool-chain')
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                throw e
            }
        }
    }

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

    updateWallet(wallet, tx)

    fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, 0, 2))
}


function chunkToNumber(chunk) {
    if (chunk.opcodenum == 0) return 0
    if (chunk.opcodenum == 1) return chunk.buf[0]
    if (chunk.opcodenum == 2) return chunk.buf[1] * 255 + chunk.buf[0]
    if (chunk.opcodenum > 80 && chunk.opcodenum <= 96) return chunk.opcodenum - 80
    return undefined
}


async function findOutspend(txid, vout) {
    const utxo = await rpc('gettxout', [txid, vout, true])
    if (utxo) return null

    const spends = vin => vin.txid === txid && vin.vout === vout

    for (const id of await rpc('getrawmempool')) {
        const tx = await rpc('getrawtransaction', [id, true])
        if (tx.vin.some(spends)) return id
    }

    const origin = await rpc('getrawtransaction', [txid, true])
    if (!origin.blockhash) return null

    const header = await rpc('getblockheader', [origin.blockhash])
    const tip = await rpc('getblockcount')
    for (let height = header.height; height <= tip; height++) {
        const hash = await rpc('getblockhash', [height])
        const block = await rpc('getblock', [hash, 2])
        for (const tx of block.tx) {
            if (tx.vin && tx.vin.some(spends)) return tx.txid
        }
    }

    return null
}


async function extract(txid) {
    let transaction = await rpc('getrawtransaction', [txid, true])
    let script = Script.fromHex(transaction.vin[0].scriptSig.hex)
    let chunks = script.chunks


    let prefix = chunks.shift().buf.toString('utf8')
    if (prefix != 'ord') {
        throw new Error('not a wojakinal')
    }

    let pieces = chunkToNumber(chunks.shift())

    let contentType = chunks.shift().buf.toString('utf8')


    let data = Buffer.alloc(0)
    let remaining = pieces

    while (remaining && chunks.length) {
        let n = chunkToNumber(chunks.shift())

        if (n !== remaining - 1) {
            const next = await findOutspend(txid, 0)
            if (!next) {
                throw new Error(`inscription is incomplete: ${txid} has no continuation`)
            }
            txid = next
            transaction = await rpc('getrawtransaction', [txid, true])
            script = Script.fromHex(transaction.vin[0].scriptSig.hex)
            chunks = script.chunks
            continue
        }

        data = Buffer.concat([data, chunks.shift().buf])
        remaining -= 1
    }

    return {
        contentType,
        data
    }
}


function server() {
    const app = express()
    const port = process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT) : 3000

    app.get('/tx/:txid', (req, res) => {
        extract(req.params.txid).then(result => {
            res.setHeader('content-type', result.contentType)
            res.send(result.data)
        }).catch(e => res.send(e.message))
    })

    app.listen(port, () => {
        console.log(`Listening on port ${port}`)
        console.log()
        console.log(`Example:`)
        console.log(`http://localhost:${port}/tx/15f3b73df7e5c072becb1d84191843ba080734805addfccb650929719080f62e`)
    })
}


main().catch(e => {
    let reason = e.response && e.response.data && e.response.data.error && e.response.data.error.message
    console.error(reason ? e.message + ':' + reason : e.message)
})
