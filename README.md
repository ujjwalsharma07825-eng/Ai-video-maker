# Ultimate AI Video Maker

A real, provider-backed AI video generation app with a polished browser studio UI, a zero-dependency Node API, multi-image references, and a daily free credit wallet that refreshes to 8 videos at 00:00 UTC, plus optional pro upgrades.

## Features

- **Real AI generation, no mock mode:** the backend calls Replicate Predictions API and fails loudly if `REPLICATE_API_TOKEN` is missing.
- **Text-to-video and image-reference modes:** submit a production prompt plus up to six reference images for models that support image conditioning.
- **Daily credit system:** each browser/client gets 8 free video credits per UTC day; one credit is charged only when a provider job is successfully created, and credits return at 00:00 UTC.
- **Professional generator UI:** responsive, sharp glassmorphism interface with live job polling and video playback.
- **Configurable model:** set `REPLICATE_VIDEO_MODEL` to any Replicate video model slug/version that accepts `prompt` and optional image fields.
- **Optional upgrades:** set `UPGRADE_ACCESS_CODE` and `PRO_DAILY_CREDITS` to let users upgrade from 8 free daily credits to a larger pro allowance.
- **Phone/browser API setup:** start with `ALLOW_BROWSER_API_SETUP=true` and `SETUP_ADMIN_PIN` to save the Replicate token from the app UI without committing secrets.

## Quick start

```bash
npm install
cp .env.example .env
# add your real Replicate token to .env
# optionally set UPGRADE_ACCESS_CODE for pro upgrades
# optionally set ALLOW_BROWSER_API_SETUP=true and SETUP_ADMIN_PIN to add API from phone/browser
npm start
```

Open `http://localhost:8787` and generate videos. The same zero-dependency Node server serves the app and API.

## API

- `GET /api/health` — checks provider, free credits, pro credits, and upgrade configuration.
- `GET /api/credits` — returns the current wallet for `x-client-id`.
- `POST /api/generate-video` — multipart request with `prompt`, `negativePrompt`, `mode`, `duration`, `aspectRatio`, and optional `references` image files.
- `GET /api/jobs/:id` — polls the real provider prediction status and output.
- `POST /api/upgrade` — accepts `{ "code": "..." }` and upgrades the client when `UPGRADE_ACCESS_CODE` matches.
- `GET /api/settings` — returns masked provider/setup status for the app setup panel.
- `POST /api/settings` — when `ALLOW_BROWSER_API_SETUP=true`, saves Replicate token/model settings from the browser/phone after optional `SETUP_ADMIN_PIN` validation.

## Production notes

For production, put the Node API behind HTTPS, persist `server/data/credits.json` in durable storage, and choose a Replicate video model whose input schema matches the fields in `server/index.js` or adjust the mapping there.


## Add API key from phone/browser

1. Start the server with browser setup enabled: `ALLOW_BROWSER_API_SETUP=true SETUP_ADMIN_PIN=1234 npm start`.
2. On your phone, open `http://YOUR-COMPUTER-LAN-IP:8787` while connected to the same Wi-Fi.
3. In **Connect API from phone/browser**, paste your Replicate API token, enter the admin PIN, and tap **Save API**.
4. Turn `ALLOW_BROWSER_API_SETUP=false` again after setup if this is a public deployment.

Never commit `.env`; it contains your real API key and is ignored by git.
