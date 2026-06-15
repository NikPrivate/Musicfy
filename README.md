# 🎵 Musicfy — Multiplayer Music Guessing Game

A real-time, multiplayer "guess the song" party game built with **React (Vite)**
on the front end and **Node.js + Express + Socket.IO** on the back end.

When the host starts, **everyone picks a song at the same time** — search by
name, choose from live suggestions, and set the exact part of the clip to play.
Then each player's song is played in turn and everyone else races to guess the
title before the timer runs out. The masked title fills in one letter at a time
as the clock ticks.

## ✨ Features

- **Multiplayer & real-time** — powered by Socket.IO.
- **Create a lobby** and invite friends with a **shareable link** (or 5-letter code).
- **Everyone submits a song** — after the host starts, every player **searches**
  for a track (live iTunes suggestions), then picks *which part* of the ~30s
  preview to play. One round per player.
- **The twist** — you choose the snippet (start point + length) of *your* song,
  so you decide how hard it is to recognise.
- **Round timer** (default 30s, configurable). The chosen snippet loops while
  everyone guesses.
- **Automatic letter clues** — the title shows its length up front, then reveals
  one more letter every 10s (configurable). No clicking required.
- **Owner sits out** — you can't guess your own song.
- **Profiles** — set a username and pick an emoji avatar (or paste an image URL)
  when you join.
- **No duplicate players** — see below.

## 🛡️ How duplicate users are prevented

The brief specifically called out the bug where the *same* person clicking the
invite link repeatedly fills the lobby with phantom players. Musicfy avoids this
in two layers:

1. **Stable `clientId`** — each browser generates one UUID, stored in
   `localStorage` (`client/src/identity.js`). Every join is keyed by this id, so
   the server **upserts** the player (`Lobby.upsertPlayer`) instead of creating a
   new one. Refreshes, reconnects, and re-opening the link all re-attach to the
   same player.
2. **Persisted profile + auto-join** — once a user sets a username/avatar it's
   saved. Re-opening the invite link **skips the profile screen and auto-joins**
   with the existing identity, so they never get asked again and never duplicate.

Disconnects are marked (not removed) and the player is restored on reconnect;
truly empty lobbies are cleaned up after a grace period.

## 🚀 Getting started

```bash
# install root, server, and client deps
npm run install:all

# run server (:4000) + client dev server (:5173) together
npm run dev
```

Open <http://localhost:5173>, create a lobby, and share the link.

### Production build

```bash
npm run build   # builds the client into client/dist
npm start       # serves the app + API from the Node server on :4000
```

## 🎧 About the audio

Songs come from the free **iTunes Search API** (proxied through the server at
`/api/search`). Each result includes a ~30s preview clip, which is what the game
plays — no manual audio URLs needed. The player only plays the chosen segment
(`startTime` → `startTime + duration`) and loops it for the round.

## 🗂️ Project structure

```
Musicfy/
├── server/                 # Node + Express + Socket.IO
│   └── src/
│       ├── index.js        # HTTP + socket event wiring
│       └── lobby.js        # Lobby/game model (state, scoring, clues, masking)
└── client/                 # React + Vite
    └── src/
        ├── identity.js     # clientId + profile persistence (dedup)
        ├── socket.js       # socket.io-client singleton
        ├── pages/          # Home, Room (phase router)
        └── components/     # ProfileSetup, SongSearch, SnippetPlayer, …
```

## 🎮 Game flow

`lobby` → host starts → `submitting` (**everyone** searches & picks their song
at once) → host begins → `playing` (one player's snippet loops while the rest
guess; letters auto-reveal on a timer) → `roundEnd` (reveal + scores) → next
player's song … → `gameEnd` (final scoreboard, play again).

Scoring rewards fast guesses:
`points = max(20, round(20 + 80 × secondsLeft / roundTimer))`.
