# ChatFlow

Embeddable website chat widget platform — visitor-facing widget, agent dashboard, and NestJS API.

## Structure

```
chatbuild/
├── apps/
│   ├── api/        NestJS backend (REST + Socket.IO)     :4000
│   ├── dashboard/  React agent/admin dashboard           :5173
│   └── widget/     Embeddable React widget (IIFE build)
├── packages/
│   ├── types/      Shared wire-contract TypeScript types
│   └── config/     Shared tsconfig presets
├── docker-compose.yml
└── package.json    npm workspaces root
```

## Prerequisites

- Node.js >= 20.19 (developed on Node 24)
- npm >= 10
- Docker + Docker Compose (from Phase 2 on)

## Quick start

```bash
npm install        # install all workspaces
npm run build      # build types -> api -> dashboard -> widget (ordered)
npm run typecheck  # tsc --noEmit in every workspace
npm run dev        # run api + dashboard + widget dev servers together
```

Individual workspaces:

```bash
npm run dev  -w @chatflow/api
npm run dev  -w @chatflow/dashboard
npm run dev  -w @chatflow/widget
```

Copy `.env.example` to `.env` before starting backend-dependent phases.

## Roadmap

Development proceeds in 20 phases, from monorepo scaffolding through database,
auth, realtime messaging, assignment, embeddable widget, analytics, security
hardening, testing, and deployment preparation. See the project log for phase
details.
