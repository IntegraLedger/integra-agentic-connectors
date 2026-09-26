---
title: Channels, sessions and subscriptions
description: One ATR for a whole channel - claim the opening, serve later requests yourself, report the close.
---

# Channels, sessions and subscriptions

On a channel, session or subscription pairing, the buyer opens a channel once and then pays many requests within it.
One agreement, and so one ATR, covers the whole channel. The opening carries H; later payments are made under that
ATR.

## The calls

1. **Issue** the ATR for the opening, as for any payment.
2. **Claim the opening** only. The door records the channel on the record's `channel` leg:
   `{network, channel, until, closed}`, where `until` is the rail's deadline for the channel, or `null` when the rail
   gives none.
3. **Serve later requests yourself.** Never claim them: a claim of a payment in an open channel answers
   `409 claim/channel-open`, and a claim in a channel whose opening was never claimed answers
   `409 claim/channel-not-open`. Every later 402 in the channel repeats the legal context of the channel's ATR.
4. **Report the close** with `{atrHash, pairing, state: "closed", reference}`, where `reference` is the close
   transaction. The door reads it with the close keys recorded at the opening, and needs no `chosen`. The record
   becomes `closed`.

```json no-check
{ "atrHash": "0x…", "pairing": "x402/batch-settlement/eip155", "state": "closed", "reference": "0x…" }
```

## Subscriptions with nothing to claim

For a subscription whose payment carries nothing to claim, the opening's `report` with `outcome: "paid"` records the
channel, with the subscription's own identifier as `reference`. On a confirm-only channel pairing, send the `receipt`
the opening answered with that report; without it the door answers `422 door/receipt-required`.

## Which pairings are channels

The channel, session and subscription pairings include `x402/batch-settlement/*`, `mpp/session/*` and
`mpp/subscription/*`. See [the pairings reference](../reference/pairings.md) for each one's pattern.
