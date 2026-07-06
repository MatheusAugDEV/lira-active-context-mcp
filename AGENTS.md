# Cloudflare Workers

STOP. Keep Cloudflare Workers and MCP behavior aligned with the current template and repo settings.

## Commands

- `wrangler secret put GITHUB_PAT`
- `wrangler secret put ACCESS_TOKEN`
- `npm run deploy`

## Style

- Follow the Cloudflare template style already in use.
- Do not add extra abstractions unless they reduce repetition or risk.

## Tests

- `npm run dev` for local validation.
- Then inspect the deployed MCP endpoint with MCP Inspector.

## Security

- Never commit `.env`.
- `GITHUB_PAT` must be a fine-grained PAT with read-only access to this repo.
- `ACCESS_TOKEN` is internal and can be any random value.

## Git

- Commit message: `feat: implement lira-active-context MCP tools`
