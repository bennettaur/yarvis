# AGENTS.md

Welcome to the Yarvis codebase! This file provides information for AI agents working on this project.

## Project Overview

Yarvis is a personal-assistant desktop app for macOS, built with Tauri v2. It features an LLM chat interface with memory and work tracking.

## Architecture

The project consists of three main processes:

- **Rust core (`src-tauri/`)**: Handles native OS integration, secret storage (macOS Keychain), and sidecar supervision.
- **React frontend (`src/`)**: Built with Vite, TypeScript, and Tailwind. Communicates with the Rust core via Tauri `invoke` and with the sidecar over HTTP.
- **Bun sidecar (`sidecar/`)**: A Hono HTTP service that manages PostgreSQL access (Drizzle ORM), LLM calls, and memory.

## Development Environment

- **Runtime & Package Manager**: [Bun](https://bun.sh/) is used throughout the project.
- **Linting & Formatting**: [Biome](https://biomejs.dev/) is used for both linting and formatting.
- **Database**: PostgreSQL with the `pgvector` extension.
- **Git Hooks**: [Lefthook](https://github.com/evilmartians/lefthook) manages pre-commit hooks (Biome and Rust formatting).

## Key Commands

### Setup
- `bun install`: Install all dependencies (root and sidecar).
- `lefthook install`: Set up git hooks.

### Development
- `bun run tauri dev`: Run the full application (frontend + Rust core + sidecar).
- `bun run sidecar:dev`: Run the sidecar process standalone.

### Testing
- `bun run test`: Run frontend tests (in `src/`) using happy-dom.
- `bun test sidecar/`: Run sidecar unit and integration tests.

### Quality Control
- `bun run lint`: Run Biome linter.
- `bun run format:write`: Format code using Biome.
- `bun run typecheck`: Run TypeScript type checks for the frontend.
- `bun run sidecar:typecheck`: Run TypeScript type checks for the sidecar.

## Project Structure

- `src/`: React frontend source code.
- `src-tauri/`: Rust core (Tauri) source code.
- `sidecar/`: Bun sidecar service source code.
- `docs/`: Project documentation.
- `public/`: Static assets for the frontend.

## Coding Standards

- Follow the existing TypeScript and Rust patterns.
- Use Biome for formatting and linting.
- Ensure all new features have accompanying tests in the appropriate directory.
