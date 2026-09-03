# wojakinals

Inscriptions on [Wojakcoin](https://wojakcoin.cash) — a command line minter,
and the protocol the marketplace and indexer read.

This is a fork of [doginals](https://github.com/apezord/doginals) by apezord,
MIT licensed; the original notice is unchanged in [LICENSE](LICENSE) and the
upstream history is kept. The protocol is apezord's. What changed here is the
chain it points at.

## Setup

```sh
npm install
```

Create a `.env`:

```
NODE_RPC_URL=http://127.0.0.1:20760
NODE_RPC_USER=your-rpc-user
NODE_RPC_PASS=your-rpc-password

FEE_PER_KB=100000
```

## Wallet

```sh
node wojakinals.js wallet new
node wojakinals.js wallet sync      # pull UTXOs from the explorer API
node wojakinals.js wallet balance
node wojakinals.js wallet split 10  # split into spendable outputs
```

Send WJK to the address it prints, then `wallet sync`.

## Minting

```sh
node wojakinals.js mint <address> <path/to/file>
node wojakinals.js mint <address> text/plain "hello world"
```

Content larger than one transaction is written as a chain: a commit, then a
hop per group of data, each spending the last. See "How it is written" below —
that detail matters if you are indexing it.

## Reading one back

```sh
node wojakinals.js wallet sync
node wojakinals.js server            # serves inscriptions on :3000
```

## How it is written

Each transaction reveals part of an envelope in its scriptSig:

```
"ord" <number of chunks> <content type> (<chunks remaining> <chunk>)*
```

Two rules are easy to get wrong and produce inscriptions that confirm and then
never appear:

- A chunk and the count that introduces it must be in the **same**
  transaction. An indexer reads the first element of each continuation
  scriptSig as the next count, and rejects anything longer than eight bytes.
- Revealing N groups takes **N+1** transactions. The commit reveals nothing —
  it only pays into the first lock — and transaction *i* reveals group *i−1*.

## What differs from doginals

- `bitcore-lib-wojak` instead of `bitcore-lib-doge`, so addresses, WIFs and
  network magic are Wojakcoin's.
- UTXOs and transactions come from an Esplora-compatible API rather than
  dogechain.info. Esplora does not return a scriptPubKey with a UTXO, so it is
  derived from the wallet address; and following a chain uses `/outspend`
  rather than a `spent` field on the transaction.
- An inscription whose chain stops part-way now says so, instead of failing on
  an undefined transaction id.
- Fees are `FEE_PER_KB` in `.env` (satoshis per KB), same as pepinals.

## License

MIT — see [LICENSE](LICENSE).
