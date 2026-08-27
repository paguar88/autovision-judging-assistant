# Concours Judging Assistant

Stage 1: source ingestion, page-level retrieval units, and verified citations.

| Command | Purpose |
|---|---|
| `npm run ingest` | Run the ingestion pipeline over `approved-source-docs/` |
| `npm run test:citations` | Citation-chain machinery regression test (offline) |
| `npm run upload:dry` | Plan the vector-store upload without writing |
| `npm run upload` | Upload retrieval units to the brand vector store |
| `npm run retrieval:test` | Live retrieval smoke test |
| `npm run report` | Render the milestone report from run artifacts |

`build/` is generated and git-ignored. Ingestion is deterministic: the same sources
produce byte-identical artifacts, so `build/` is regenerated rather than committed.

Upload and retrieval require `OPENAI_API_KEY` and `OPENAI_VECTOR_STORE_ID_FERRARI`.
See `SETUP-UPLOAD.md` to run these from GitHub with no local install.
