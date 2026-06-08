# Deployment

This backend is designed for Cloudflare Workers plus Cloudflare D1.

## 1. Create D1

```bash
npx wrangler d1 create motorheads_registry
```

Copy the returned `database_id` into `wrangler.toml`.

## 2. Migrate D1

```bash
npm run db:migrate:prod
```

For local testing:

```bash
npm run db:migrate:local
```

## 3. Configure Vars

Update `wrangler.toml`:

```toml
CORS_ORIGIN = "https://your-motorheads-site.pages.dev"
ALLOW_UNVERIFIED_WRITES = "false"
```

Keep `ALLOW_UNVERIFIED_WRITES` false for production until real wallet signature verification and ownership checks are enabled.

## 4. Deploy

```bash
npm run deploy
```

## 5. Website Integration Later

The website should call:

- `GET /v1/config`
- `GET /v1/parts`
- `GET /v1/tokens/:tokenId/state`
- `GET /v1/agent/:tokenId`

When the owner editor is ready, the wallet signs an edit message. The backend verifies it, confirms token ownership, and then saves custom positions/colors.

