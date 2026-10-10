# ChatFlow

Embeddable website chat platform — a visitor-facing widget, a real-time staff
dashboard, a NestJS API, and an optional AI agent that answers first from a
per-tenant FAQ knowledge base.

```
Visitor website ──<script>──> Widget ──HTTP + Socket.IO──> API ──> Postgres
                                                              │
Staff dashboard <──HTTP + Socket.IO───────────────────────────┘
```

## Structure

```
chatbuild/
├── apps/
│   ├── api/         NestJS backend (REST + Socket.IO)      :4000
│   ├── dashboard/   React staff/admin dashboard            :5173
│   ├── widget/      Embeddable React widget (IIFE + shadow DOM)
│   └── demo/        Example storefront that embeds the widget
├── packages/
│   ├── types/       Shared wire-contract TypeScript types
│   └── config/      Shared tsconfig presets
├── scripts/         Demo helpers
├── docker-compose.yml
└── package.json     npm workspaces root
```

## Prerequisites

- Node.js >= 20.19 (developed on Node 24)
- npm >= 10
- Docker + Docker Compose (for Postgres)

## Quick start

```bash
cp .env.example .env          # then fill in the values below
docker compose up -d          # Postgres on :5544
npm install
npm run db:migrate
npm run build
npm run dev                   # api + dashboard + widget
```

`npm run dev` starts the API (`:4000`), the dashboard (`:5173`) and the widget
dev host (`:5174`). To also see the widget embedded in a real third-party site:

```bash
npm run demo                  # seeds a demo website, prints its publicKey
npm run demo:storefront       # storefront on :5175 with the chat bubble
```

Put the printed key in `.env` as `VITE_DEMO_WEBSITE_KEY`, then start the
storefront. `npm run demo:storefront` rebuilds the widget and copies it into
`apps/demo/public/` automatically — that bundle is a build artifact and is not
committed.

## Seeded admin

`npm run db:seed` creates the first ADMIN from `ADMIN_EMAIL` / `ADMIN_PASSWORD`
in `.env`. It is never used for public registration.

## AI agent ("Connect Agent")

The dashboard's **AI Agent** panel connects a website to a model backend. The
agent is deliberately narrow:

- **Data scope** — it may read _only_ that website's FAQ entries plus its name
  and domain. It never reads conversations, visitors, staff accounts or other
  tenants. This is enforced by which rows are queried, and restated in the prompt.
- **Grounding** — answers come only from the knowledge base. Out-of-scope
  questions are handed to a human instead of improvised.
- **Handoff** — an escalation posts the website's configured acknowledgement and
  moves the thread to the human queue. The agent keeps acknowledging new visitor
  messages while it waits, and goes silent once a staff member actually replies.

### Model backends

Set one of these in `.env`, then restart the API:

| Provider                      | Variables                                              |
| ----------------------------- | ------------------------------------------------------ |
| Groq (free tier, recommended) | `AI_PROVIDER=groq`, `GROQ_API_KEY`, `GROQ_MODEL`       |
| OpenAI                        | `AI_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_MODEL` |
| Offline mock (no key)         | leave unset                                            |

Both real backends speak the OpenAI `/chat/completions` wire format, so a single
provider implementation serves them. With no key configured the agent uses a
deterministic offline responder, so a misconfigured deployment can never call a
paid API.

> **Model availability is account-specific.** Run
> `curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models`
> to list the models your key can actually reach, and set `GROQ_MODEL` to one of
> them.

## Reporting

Read-only, per-website, and authorized by the same tenant guard as the inbox.
Aggregates run in Postgres, so a month of traffic is reduced by the database and
only small results cross the wire.

| Route                                         | Returns                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/websites/:id/reports/summary`       | Volume, open/pending/closed, AI-handled and handoff rates, avg first response, avg resolution |
| `GET /api/websites/:id/reports/timeseries`    | Volume bucketed by `hour` / `day` / `week`                                                    |
| `GET /api/websites/:id/reports/agents`        | Per-agent assigned / resolved / open / reassigned-away                                        |
| `GET /api/websites/:id/reports/conversations` | Per-conversation drill-down                                                                   |
| `GET /api/websites/:id/reports/export.csv`    | CSV export                                                                                    |
| `GET /api/websites/:id/reports/overview`      | All of the above in one call                                                                  |

## Embedding the widget

```html
<script src="https://your-cdn.example.com/widget.js" data-website-key="pk_..." defer></script>
```

The bundle mounts into a shadow root, so the host page's CSS cannot leak in and
the widget's cannot leak out. The website public key is an identifier, not a
secret — it grants no authority on its own. Allowed origins must be listed in
`CORS_ORIGINS`.

## Scripts

```bash
npm run build       # types -> api -> dashboard -> widget (ordered)
npm run typecheck   # tsc --noEmit in every workspace
npm test            # jest (api e2e) + vitest (dashboard, widget)
npm run format      # prettier --write
```

## Known limitations

Deliberate and self-documented in the code:

- Rate limiting, the login throttle, and the realtime event bus are in-process
  (`Map` / `EventEmitter`), so they are **single-instance only**. Horizontal
  scaling needs Redis for shared counters and pub/sub.
- Prisma connection-pool settings (`connection_limit` / `pool_timeout`) are unset.
- The AI worker processes `5` jobs per tick sequentially; throughput is bounded
  per instance.
- The staff JWT is kept in `localStorage` — an accepted XSS surface, chosen
  deliberately because in-memory storage would log staff out on every refresh.

## Roadmap

See the project log for phase-by-phase detail.
