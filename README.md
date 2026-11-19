# ARC STREETRACING

4-player highway survival street racing in Three.js against 3 adaptive AI rivals (`Vortex_02`, `Kenshin_01`, `Apex_03`) with Arc Testnet USDC wagering and Orion `RandomnessHub v2` beacon settlement.

## Features

- **Instant 4P Highway Survival**: Launch straight into a 4-lane highway race with `P1 • YOU` + 3 AI bots driving identical **Lancer Evo VIII MR** chassis with auto-swapping unique paint liveries.
- **Zero-HUD Immersion**: Clean fullscreen 3D gameplay during active races with procedural Web Audio engine synthesis and turbo blow-off audio.
- **Arc Testnet USDC Wagering**: Built-in embedded Arc Testnet wallet (with `+50 USDC` faucet) plus MetaMask / Rabby support (`chainId: 5042002`), preset (`$1`, `$5`, `$10`, `$25`) and custom USDC stakes, winner-takes-all `4×` pot, and post-race Orion `RandomnessHub v2` drand beacon proof.
- **Desktop & Mobile Controls**:
  - **Keyboard**: `A` / `D` or `←` / `→` to switch lanes, `C` to cycle camera, `M` to mute audio, `Esc` / `P` to return to lobby.
  - **Touch / Mouse**: Tap the left or right half of the screen during a race to switch lanes.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Build & Tests

```bash
npm run lint
npm run build
npx tsx --test src/game/rules.test.ts
```

## Deployment

### Option 1: Vercel (Recommended — Static 1-Click Deploy)

This AI-bots edition runs 100% client-side with zero backend dependencies.

1. Push the repository to GitHub / GitLab / Bitbucket.
2. Import the repository in [Vercel](https://vercel.com/new) — `vercel.json` is preconfigured (`vite` framework, `npm run build`, `dist`, SPA rewrites, immutable asset caching, and security headers).
3. Click **Deploy**.

### Option 2: Fly.io (Containerized Node/Express)

Preconfigured with `fly.toml`, `Dockerfile`, and `deploy-fly.sh`:

```bash
chmod +x deploy-fly.sh
./deploy-fly.sh
```
