# CLAUDE.md

## Workspace Information

- **Project Name**: Yarvis
- **Root Directory**: You are currently in the root directory of the Yarvis project.
- **Main Components**:
    - `src/`: React + TypeScript frontend.
    - `src-tauri/`: Rust core (Tauri).
    - `sidecar/`: Bun + TypeScript backend service.

## Helpful Context

- **Package Management**: This project uses `bun`. Always prefer `bun` over `npm` or `yarn`.
- **Formatting & Linting**: We use `biome`. Run `bun run check:write` to fix linting and formatting issues.
- **Tauri**: The app is built with Tauri v2. Native interactions happen in `src-tauri/`.
- **Database**: We use PostgreSQL with `pgvector` and Drizzle ORM (in `sidecar/`).

## Common Tasks

### Testing
- Frontend: `bun run test`
- Sidecar: `bun test sidecar/`

### Running the App
- Full App: `bun run tauri dev`
- Sidecar Only: `bun run sidecar:dev`

### Verification
- Run `bun run lint` and `bun run typecheck` before submitting any changes.

## Directory Map

- `/src`: Frontend components and logic.
- `/src-tauri`: Rust backend code.
- `/sidecar`: Sidecar service (Hono, Drizzle, LLM logic).
- `/docs`: Additional documentation.
- `/public`: Static assets.
