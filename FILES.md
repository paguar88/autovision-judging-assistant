# Stage 1 repository contents

Every file below must exist in the GitHub repository before the workflow can run.
The workflow's first step verifies this list and names anything missing.

| Path | Size | SHA-256 (first 12) |
|---|---|---|
| `.gitignore` | 36 B | `ac70f3a4d5fd` |
| `README.md` | 898 B | `66f77cca799d` |
| `SETUP-UPLOAD.md` | 4,827 B | `c17dd985a948` |
| `approved-source-docs/330-GTC-GTS-As-Built-Configuration-and-Judging-Notes-Document-Version-8_0-July-2023.pdf` | 22,010,449 B | `62a4a8031c26` |
| `approved-source-docs/330-GTC-GTS-Concours-Judging-Checklist-VER-1.pdf` | 258,529 B | `56694ec59f5c` |
| `approved-source-docs/iac_pfa_judging_guidelines__.pdf` | 59,494 B | `7bc23f307ce9` |
| `config/brands.json` | 1,517 B | `3e662dfddaca` |
| `config/model-aliases.json` | 1,761 B | `35116605f69c` |
| `config/score-sheet-mappings.json` | 1,032 B | `aeb428d795aa` |
| `config/source-index.json` | 5,216 B | `852bb29b736d` |
| `package-lock.json` | 10,397 B | `8012433e53ee` |
| `package.json` | 805 B | `ee3d534e5379` |
| `scripts/ingest.mjs` | 28,198 B | `09060ce3fe4b` |
| `scripts/milestone-report.mjs` | 4,410 B | `6448cd23e214` |
| `scripts/retrieval-test.mjs` | 5,240 B | `25f6e5e44bb9` |
| `scripts/upload-vector-store.mjs` | 5,951 B | `6a6779ddd089` |
| `src/services/citation-resolver.mjs` | 3,747 B | `935289367ec0` |
| `tests/citation-chain.test.mjs` | 5,290 B | `d051cc96047e` |

Also required, and already present in your repository:

| Path | Note |
|---|---|
| `.github/workflows/ferrari-corpus-upload.yml` | **Replace with the updated version** — it now preflights the repo contents |
| `README.md` | already committed |

**Total: 18 files, 22,407,797 bytes.**

`.gitignore` is a hidden dot-file and may not drag from Finder or Explorer. It is optional — the workflow runs without it.
