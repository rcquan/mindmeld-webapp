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

Every push to `main` deploys to production through `.github/workflows/deploy.yml`. The workflow first runs the CI checks from `ci.yml` and then runs `npm run deploy`. You can also start it by hand from the Actions tab, but only a run from `main` deploys. Deploys queue rather than cancel each other. There's no staging environment. Expect open WebSockets to drop on deploy; room state is in storage, and `partysocket` reconnects clients.

The workflow reads two secrets from the GitHub `production` environment, which is restricted to the `main` branch:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`: a custom token with these permissions:
  - Account: Workers Scripts:Edit, Account Settings:Read
  - Zone mindmeld-game.com: Workers Routes:Edit, Zone:Read
  - User: Memberships:Read, User Details:Read

  Workers Routes and Zone access are there because the Custom Domain in `routes` is re-attached on every deploy. DNS:Edit isn't needed, because Cloudflare manages the domain's DNS record. If a deploy fails on a missing permission, the error names it.

### When CI or a deploy fails

- Find the failing step with `gh run list --limit 5`, then `gh run view <id> --log-failed`.
- Lint, typecheck and the dry-run fail the same way locally, so rerun the matching `npm run` command.
- When the smoke test fails, the log shows which step timed out or failed its assertion, plus the full `wrangler dev` output. Reproduce it with `npm run smoke`.
  - It uses ports 8799 and 9239 and a temporary state directory, so it can run alongside `npm run dev`.
  - If it fails with "did not start in time", something is probably still holding port 8799 (`lsof -i :8799`).
- If the smoke test passes but the deploy step fails, the cause is usually the token. Check its permissions against the list above.
- A failed deploy leaves the previous version live. To ship a fix, push it to `main` or rerun the workflow.

Don't add `push` to `ci.yml`. `deploy.yml` already runs CI on `main`, and a second run there wastes runner time.

To deploy by hand, for example in an emergency:

```bash
npx wrangler login
npm run deploy
```

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

**After rolling back, any `npm run deploy`, and so any merge to `main`, takes the domain back.** Remove `routes` from `wrangler.jsonc` first if you still need to deploy.
