# Dominoes

Mobile-first, 2-player online domino game. Web app, no accounts — the host shares a
6-digit code and the guest joins with it.

Played as the classic **double-six draw game**: 28 tiles, 7 each, 14 in the boneyard.
Play to 100 points.

## Run it

```bash
npm install
npm start            # http://localhost:3000
PORT=8080 npm start  # different port
```

The server prints the LAN address at startup, so a phone on the same Wi-Fi can open
`http://<your-ip>:3000`. Both players need to reach the same URL.

## How a game works

1. Host taps **Create game** → gets a 6-digit code. The lobby also shows the LAN
   invite link (and **Copy invite link** copies it), so the other player can just
   open that URL.
2. Guest opens the invite link → they drop straight into the game, no typing. If
   they'd rather enter it by hand, the code works too. Any error (dead code, game
   already full) is shown both as a toast and inline under the Join button.
3. Highest double leads; if nobody holds a double, the heaviest tile leads.
4. Tap a tile, then pick the end it fits. The board is a single chain; doubles lie
   crosswise.
5. Can't play? **Draw** from the boneyard until you can. If the boneyard is empty,
   **Pass**. Two passes in a row end the round as blocked.
6. Round ends when someone plays their last tile (they score the pips left in the
   opponent's hand) or the game blocks (lower pip count scores the difference).
   First to 100 points wins the match.

Reloading the page rejoins your seat automatically (a per-room token is kept in
`localStorage`), so a dropped connection doesn't lose the game.

## Layout

```
server.js            authoritative game state + WebSocket rooms (in-memory)
public/index.html    home / lobby / game screens
public/style.css     felt-table theme, tile + pip rendering
public/client.js     WebSocket client, board and hand rendering
test/playthrough.js  headless 2-client playthroughs (asserts chain + scoring)
test/rules.js        illegal-move enforcement + blocked-game resolution
```

## Tests

Start the server first, then:

```bash
node test/playthrough.js   # GAMES=n to change the sample
node test/rules.js         # ~120 games, checks every rejection path
```

Both drive real WebSocket clients against a running server — no mocks.

## Cloud Run

The container is just the game + its two dependencies; no database.

```bash
./deploy.sh
```

Preflight needs three things, all one-time:

```bash
~/google-cloud-sdk/bin/gcloud auth login                              # your Google account
~/google-cloud-sdk/bin/gcloud config set project YOUR_PROJECT_ID      # create one at
                                                                     # https://console.cloud.google.com/projectcreate
# and attach a billing account to that project (Cloud Run has a free tier, but a
# billing account must exist): https://console.cloud.google.com/billing/linkedaccount
```

`deploy.sh` then enables `run`/`cloudbuild`/`artifactregistry` and builds the image
with Cloud Build, so no local Docker is needed. It prints the `https://…run.app` URL
when it finishes; both players open that URL and the lobby's invite link is built from it.

Flags that are not defaults, and why:

- `--timeout 3600` — a WebSocket stream is an HTTP request and is killed at the service
  timeout. 3600s is the maximum. Clients already auto-reconnect on close.
- `--min-instances 1 --max-instances 1` — rooms live in the process's memory, and Cloud
  Run's session affinity is best-effort: two sockets can land on different instances and
  see different rooms. One instance removes that class of bug entirely. It also means the
  service never scales to zero, so a room survives an idle spell.
- `--concurrency 200` — many sockets share the one instance instead of scaling out.
- `--allow-unauthenticated` — the game is public; the 6-digit code is the only access control.

Two runtime notes: Cloud Run throttles CPU between requests, so the in-process room-expiry
timer only fires when the instance is handling traffic (harmless — rooms are keyed and few).
And `/api/info` reports the container's private IP on Cloud Run, which is why the client only
substitutes the LAN address when the page itself was opened on `localhost`.

## Firestore mode (no server, no billing)

`public/client.js` talks straight to Firestore; nothing runs on a server. This is
the Spark-plan path: Hosting serves the files, Firestore holds the game, and
`firestore.rules` is the only thing standing between a player and an illegal move.

```bash
npx firebase-tools emulators:start --only auth,firestore,hosting --project dominoes-demo
# → http://127.0.0.1:5000
```

The Firestore emulator is a Java program: `brew install --cask temurin@21` (or any
JDK 21 on your PATH) is required locally. Deploying needs no Java.

To go live: create a free Firebase project, paste its web config into
`public/firebase-config.js`, set the project id in `.firebaserc`, then

```bash
npx firebase-tools login
npx firebase-tools deploy --only hosting,firestore
```

Firestore layout — the opponent's hand is never readable, which is why hands live
in their own documents (`allow update`/`read` are owner-only; a rules read cannot
hide individual fields, only whole documents):

```
rooms/{code}                    status, members, turn, board, ends, handCounts,
                                boneyardCount, round, scores, over, result, rematch
rooms/{code}/hands/{uid}        { tiles: [ {id,a,b} ], pips }     owner-only
rooms/{code}/private/pile       { top, tiles: { "0": {id,a,b}, ... } }
rooms/{code}/pipTotals/{uid}    { pips }   published to settle a blocked round
rooms/{code}/quit/{seat}        { at }     a player left; its presence ends the game
```

### What the rules do and don't enforce

Enforced (verified against the emulator with two real clients):

- only the two seats can touch a room; nobody can enumerate rooms
- only the seat on turn may play, draw or pass; the turn always flips
- exactly one end may change per move, and the board is append/prepend-only —
  nothing already on the table can be altered or removed
- your hand is readable only by you, and it may change by exactly one tile —
  the tile you played, or the top tile of the pile
- the pile is a pointer into an append-only map: it advances by one and its
  contents can never be edited, so nobody can prune tiles they don't like
- a score can be written once, only when the round is over, and only if the
  arithmetic matches the hands themselves — a player cannot award themselves points

Deliberately trusted, so you know what you're getting:

- **the tile you play need not match that end.** The rules check that one end
  changed and one tile left your hand, not that the tile actually fits. A client
  that lies will corrupt its own board, not gain ground.
- **the board's rendered contents** are covered only by the append-only check
  above; that check is what stops a rewrite, but it identifies tiles by value, so
  two identical tiles on the table would be indistinguishable.
- **pips are self-reported** on your own hand document (a rule cannot sum a list).
  You can only lie about your own hand, and the rules verify that the *score*
  matches whatever you claimed — so the lie costs you, it doesn't gain you.
- **both players can read the undrawn pile.** The drawing client has to know which
  tile it drew. Draws are forced and always take the top tile, so seeing the pile
  cannot change a decision — but the future order is visible to anyone who looks.

In short: no cheating for advantage, and griefing is bounded. This is not
server-authoritative, and `server.js` still is.

## Notes / limits

- Rooms live in server memory and expire 30 minutes after both players disconnect.
  Restarting the server clears all games.
- Nothing is persisted: no database, no accounts, no chat.
- Single server process, so it does not scale horizontally as written.
