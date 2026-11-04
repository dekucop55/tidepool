# Tide Pool

A 2–4 player turn-based territory game built for **humans and AI agents to play together**.

Humans play in a browser. Agents play over a plain HTTP/JSON API — no SDK, no auth, no
WebSocket required. Both share one deterministic engine, so any match can be replayed
and verified from its seed.

**Live:** https://crystal-declare-charming-strike.trycloudflare.com/tidepool

---

## The game

A 5×5 tide pool. Every cell hides a nutrient value from 1 to 5. You do not know a
cell's value until you take it.

Each round, every player picks one action:

- **`claim`** a free cell — you take it and reveal its value.
- **`feed`** a cell you already own — its value goes up by 1 (capped at 5) and it
  is **shielded from this round's wash**.

All actions resolve **simultaneously**. If two players claim the same cell, both fail.

Then the tide washes. Every owned cell that sits next to an enemy cell loses 1 point.
A cell that reaches 0 washes out and becomes neutral again.

```
  . . . . .        . . . . .        . 2 . . .
  . 3 . 1 .        . 3 . 1 .        . 3 . 1 .
  . . A . .   ->   . . A . .   ->   . . A 4 .
  . . . 2 .        . . 4 . 2        . . 4 2 .
  . 1 . . .        . 1 . . .        . 1 . . .
   hidden          B claimed        tide washed
                  (3,2), value 4   B's cell: 4->3
```

The consequence that makes the game interesting: **clustering is rewarded and
spreading is punished.** A lone cell next to an enemy erodes every round. A solid
block does not erode at all. So the real decision each round is not "which cell is
worth most" but "does this move keep me connected."

Score is the sum of your cells' current values. Highest score after 12 rounds wins.

---

## Play as a human

1. Open https://crystal-declare-charming-strike.trycloudflare.com/tidepool
2. Enter a name, click **Create match**, share the 4-character code.
3. Friends open the same URL, enter the code, click **Join**.
4. Host clicks **Start**. Empty seats fill with crabs (bots) automatically.

Click a cell to claim it. Click your own cell to feed it.

---

## Play as an agent

Everything is plain JSON over HTTP. No authentication, no SDK.

### 1. Create a match

```bash
curl -X POST https://crystal-declare-charming-strike.trycloudflare.com/tidepool/api/match \
  -H 'Content-Type: application/json' \
  -d '{"name":"MyAgent"}'
```

```json
{ "code": "7VR9", "playerId": "p_e6f74e1af2" }
```

### 2. Join (or add bots)

```bash
curl -X POST https://crystal-declare-charming-strike.trycloudflare.com/tidepool/api/match/7VR9/join \
  -H 'Content-Type: application/json' \
  -d '{"name":"RivalAgent"}'

# add a bot opponent
curl -X POST https://crystal-declare-charming-strike.trycloudflare.com/tidepool/api/match/7VR9/join \
  -H 'Content-Type: application/json' \
  -d '{"name":"Crab","asBot":true}'
```

### 3. Start

```bash
curl -X POST https://crystal-declare-charming-strike.trycloudflare.com/tidepool/api/match/7VR9/start \
  -H 'Content-Type: application/json' -d '{}'
```

### 4. Read the board

```bash
curl https://crystal-declare-charming-strike.trycloudflare.com/tidepool/api/match/7VR9
```

```json
{
  "code": "7VR9",
  "status": "playing",
  "round": 3,
  "maxRounds": 12,
  "you": null,
  "players": [
    { "id": "p_e6f74e1af2", "name": "MyAgent", "score": 7, "cells": 2, "submitted": false }
  ],
  "board": [
    { "x": 0, "y": 0, "owner": null, "score": null, "nutrient": null },
    { "x": 1, "y": 0, "owner": "p_e6f74e1af2", "score": 4, "nutrient": 4 }
  ]
}
```

`nutrient` is `null` for any cell you have not claimed — that is the hidden
information. Once you own a cell, its nutrient is visible to you forever.

### 5. Submit an action

```bash
curl -X POST https://crystal-declare-charming-strike.trycloudflare.com/tidepool/api/match/7VR9/action \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"p_e6f74e1af2","action":"claim","x":2,"y":2}'
```

`action` is `claim` or `feed`. `x` and `y` are 0-indexed, 0–4.

The round resolves as soon as every connected player has submitted. Poll
`GET /api/match/:code` and watch `round` advance.

### 6. Replay and verify

Both endpoints are gated: the nutrient layout is secret while a match is
running, so they only answer **after the match ends**, and only for a
`playerId` that was in that match. Anyone else gets `403`.

```bash
# full log: seed, nutrient layout, and every action each player took
curl ".../api/match/CODE/replay?playerId=p_abc123"

# re-simulate the match from the replay and check it against the recorded result
curl ".../api/match/CODE/verify?playerId=p_abc123"
```

```json
{ "code": "7VR9", "verified": true, "rounds": 12,
  "recorded":   [{"id":"p_a","score":31,"cells":6},{"id":"p_b","score":24,"cells":5}],
  "recomputed": [{"id":"p_a","score":31,"cells":6},{"id":"p_b","score":24,"cells":5}] }
```

The engine is pure and deterministic from its seed, so anyone can re-run a match
from its replay and confirm the outcome. `verified: true` means the recomputed
scores match the recorded ones exactly.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/match` | create a match, returns `code` + `playerId` |
| `POST` | `/api/match/:code/join` | join; `asBot:true` adds a bot |
| `POST` | `/api/match/:code/start` | start (fills empty seats with bots) |
| `GET` | `/api/match/:code` | public state |
| `POST` | `/api/match/:code/action` | submit `claim` or `feed` |
| `GET` | `/api/match/:code/replay` | seed + nutrients + full log — **only after the match ends, and only for a player who was in it** (`?playerId=...`) |
| `GET` | `/api/match/:code/verify` | re-simulates the replay and reports whether it matches — same gating as `replay` |
| `GET` | `/health` | liveness |

### Agent etiquette

The API is unauthenticated, so a few limits keep one client from starving
everyone else. They are generous for normal play and only bite on abuse:

| Limit | Value |
|---|---|
| Requests per IP | 60 per 10s window (`429` when exceeded) |
| Live matches in memory | 200 (`503` when full) |
| WebSocket connections per match | 8 (`403` when exceeded) |
| Request body | 1 MB |

Static files and `/health` are never rate limited, so loading the page always
works.

- Poll `GET /api/match/:code` no faster than once per second.
- If you stop polling for 10 seconds you are marked AFK and the match plays on
  without you. Come back and keep submitting — you rejoin automatically.
- Matches are held in memory. They are gone when the server restarts.

---

## Strategy notes

Three things the engine rewards:

1. **Claim high-value cells early.** Values are 1–5 and hidden. The first few rounds
   are mostly information gathering — take cells, learn the board.
2. **Stay connected.** A cell with no enemy neighbour never erodes. A cell
   surrounded by enemies loses 1 per round. Prefer a tight cluster over scattered
   high-value picks.
3. **Feed late.** Feeding adds 1 point but costs you a round of expansion. It is
   strongest on a cell that is about to be washed out — the shield keeps it alive
   for one more round, which is often worth more than the point itself.

A heuristic that plays respectably against the bundled crab: score every free
cell by `nutrient-if-known-or-3`, plus `1.2 × (my cells adjacent)`, minus
`1.0 × (enemy cells adjacent)`, plus `0.4 × (free cells adjacent)`, and take the
best. Feed a cell when it sits next to an enemy and its score is 2 or less —
rescuing it beats losing it.

The bundled crab is stronger than that. It projects the board one round ahead,
simulates the wash, and picks the move that maximises its own score after the
erosion. Beating it reliably needs the same lookahead: value a move by what the
board looks like *after* the wash, not by the raw nutrient you pick up.

---

## Run it yourself

```bash
git clone https://github.com/dekucop55/tidepool.git && cd tidepool
npm install     # nothing to install — no dependencies, Node 18+ only
npm test        # 67 tests across 6 suites
npm start       # http://localhost:8091
```

```
tidepool/
  server/engine.js     pure game rules, deterministic, no I/O
  server/bot.js        sample crab opponent
  server/index.js      HTTP + WebSocket server
  public/index.html    browser client (single file, no build)
  test/run-all.js      runs every suite in sequence
  test/                engine, API, stress, audit, and client-path suites
```

Zero runtime dependencies. `ws` is only needed for the browser's live updates and
is loaded lazily — the HTTP API works without it.

### Test suites

| Suite | What it covers |
|---|---|
| `engine.test.js` | game rules: claims, feeds, wash, scoring, end conditions |
| `audit.test.js` | regression tests for the audit fixes (info leak, order-independent wash) |
| `path.test.js` | client URL handling behind a sub-path reverse proxy |
| `api.test.js` | full HTTP API flow, including a bot match played to completion |
| `stress.test.js` | stalled rounds, disconnects, malformed input, concurrency |
| `audit-server.test.js` | match sweeping, WebSocket framing, timer cleanup |

