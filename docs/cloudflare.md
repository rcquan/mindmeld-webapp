# Cloudflare in Mind Meld

How this app is configured, run and deployed. Reference: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

## `wrangler.jsonc`

| Setting | Purpose |
|---|---|
| `name` | The Worker: `mindmeld-game`. Changing it creates a new Worker with empty rooms. |
| `main` | Worker entry point, `src/server.ts`. |
| `compatibility_date`, `compatibility_flags` | Runtime version. `nodejs_compat` follows the PartyServer migration guide. |
| `durable_objects.bindings` | Binds `MindMeld` as `Main`, which produces the `/parties/main/:room` route. |
| `migrations` | Durable Object class history. See below. |
| `routes` | Attaches mindmeld-game.com as a Custom Domain. |
| `workers_dev`, `preview_urls` | Both off, so the app is only reachable on mindmeld-game.com. |
| `assets` | Serves `public/`. |
| `build` | Runs `npm run build:client` before `dev` and `deploy`, and watches `src`. |
| `observability` | Keeps Worker logs in the Cloudflare dashboard. |

## Durable Object migrations

Wrangler doesn't generate these. [Add a new `migrations` entry](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) with a new tag whenever a Durable Object class is added, renamed or removed, and never edit an entry that has been deployed.

`MindMeld` uses SQLite-backed storage, and an existing class can't switch storage backend. The app only uses the key-value API (`ctx.storage.get`, `put`, `setAlarm`).

## Client build and assets

esbuild bundles `src/client.ts`, and the CSS it imports, into `public/dist/client.js` and `client.css`, which `public/index.html` loads. `public/dist/` is generated and gitignored.

[Static assets](https://developers.cloudflare.com/workers/static-assets/) are served first, and any path that doesn't match a file reaches the Worker. That's how `/parties/*` gets through. Don't add files under `public/parties/`.

## Types

Workers globals conflict with the browser's DOM types, so there are two TypeScript projects: `tsconfig.client.json` and `tsconfig.worker.json`, tied together by `tsconfig.json`. `npm run typecheck` runs both. `src/shared.ts` is in both, so it can't use anything specific to either runtime.

## Local development

`npm run dev` serves at `http://localhost:8787` using the same `workerd` runtime as production. Durable Object state lives in `.wrangler/`, which is gitignored; delete it to clear local rooms. The debugger attaches on port 9229 (see `.vscode/launch.json`).

## Deploying

```bash
npx wrangler login
npm run deploy
```

`npm run deploy` goes straight to production, and there's no staging environment. Expect open WebSockets to drop on deploy; room state is in storage, and `partysocket` reconnects clients.

## Secrets

The app has none today. If one is needed, use `npx wrangler secret put NAME`, not `vars`. For local dev, put it in `.dev.vars`, and add that file to `.gitignore` first because the current `*.env` pattern doesn't cover it.

## Logs

- Live production logs: `npx wrangler tail`
- Local logs: the `npm run dev` terminal
- History: Workers & Pages → `mindmeld-game` → Logs in the Cloudflare dashboard

## Domain and rollback

mindmeld-game.com is a [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) on `mindmeld-game`, set by `routes` in `wrangler.jsonc`. `www` isn't configured, and the zone is in the same account as the Worker.

Wrangler moves a Custom Domain between Workers without asking: the cutover from `rcquan-mindmeld` happened on a plain `npm run deploy`, with no prompt.

To roll back to the PartyKit Worker, go to Workers & Pages → `rcquan-mindmeld` → Domains in the dashboard and add mindmeld-game.com as a Custom Domain. This hasn't been tested. Games in progress are lost, and it restores old code that can't take new deploys.

**After rolling back, any `npm run deploy` takes the domain back.** Remove `routes` from `wrangler.jsonc` first if you still need to deploy.
