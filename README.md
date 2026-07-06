<h1 align="center">💼 Steam Inventory Value</h1>

<p align="center">
  <b>A BetterDiscord plugin that shows anyone's CS2 inventory value right on their Discord profile.</b>
  <br/>
  <sub>Real Doppler phase pricing · live prices in your currency · Trade Offer &amp; Steam buttons · shared cache so it loads instantly for everyone.</sub>
</p>

<p align="center">
  <a href="https://github.com/VisaHolder/steam-inventory-value/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/VisaHolder/steam-inventory-value?style=flat-square&color=5865f2"/></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-5865f2?style=flat-square"/></a>
  <a href="https://betterdiscord.app"><img alt="BetterDiscord" src="https://img.shields.io/badge/BetterDiscord-plugin-3e82e5?style=flat-square"/></a>
  <a href="https://vsi-cache.reap-dev.workers.dev/health"><img alt="Cache" src="https://img.shields.io/badge/shared%20cache-online-23a55a?style=flat-square"/></a>
</p>

---

## 📥 Install — easy as fuck (2 minutes)

1. **Get BetterDiscord** *(skip if you have it)* → https://betterdiscord.app
2. **Download** [`SteamInventoryValue.plugin.js`](https://github.com/VisaHolder/steam-inventory-value/releases/latest/download/SteamInventoryValue.plugin.js)
3. In Discord: **Settings → Plugins → Open Plugins Folder** → drop the file in
4. Back in **Settings → Plugins**, flip **SteamInventoryValue** to **ON**

✅ Open anyone's profile (with a linked Steam) and their CS2 inventory value shows up.

> **Optional — exact Doppler phase prices:** grab a free CSFloat key (csfloat.com → Profile → Developer) and paste it into the plugin's settings. Rubies, Sapphires, Black Pearls and Phases price correctly instead of the generic Doppler number.

Full guide: [`betterdiscord/README.md`](betterdiscord/README.md)

## ✨ Features

- **Inventory value** on every profile — total in your currency (CSFloat prices + live FX), top items, item count
- **Doppler / Gamma Doppler phase pricing** — Ruby, Sapphire, Black Pearl, Emerald, Phase 1–4 (with the optional CSFloat key)
- **Send Trade Offer** + **Steam Profile** buttons, auto-detected from a linked Steam or a trade URL in the bio
- **Shared cache** — once anyone prices a profile it loads **instantly** for everyone else, and phase-accurate prices propagate even to users without a key
- 100% client-side; only your **public** SteamID + inventory value is ever shared — no Discord identity, no accounts

## 🗂️ Repo layout

| Path | What |
|------|------|
| [`betterdiscord/`](betterdiscord) | The plugin — TypeScript source + esbuild build → the drag-and-drop `.plugin.js` |
| [`worker/`](worker) | `vsi-cache` — the Cloudflare Worker + KV backing the shared inventory-value cache |

## 🛠️ Build

```bash
cd betterdiscord && npm install && npm run build   # → SteamInventoryValue.plugin.js
```

The worker deploys via the **Deploy Worker** GitHub Action (`workflow_dispatch`), or `cd worker && npm i && wrangler deploy`.

## 📄 License

[MIT](LICENSE) © VisaHolder
