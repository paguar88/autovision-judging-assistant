# Running the Ferrari upload without a local development environment

Everything below happens in a web browser. No Node, no terminal, no local install.

The work runs on a **GitHub Actions runner** — a temporary machine GitHub provides,
which already has Node installed. It runs only when you click Run, and it does not
touch your Netlify site: it does not build, deploy, or change the deployed application.

---

## Why not run this from Netlify?

Netlify was the obvious candidate since the credentials already live there, but both
routes are worse:

- **A Netlify Function** would need a live HTTPS endpoint that writes to your vector
  store. That is a permanent production attack surface created for a one-off task, and
  the synchronous 10-second limit cannot upload 155 files anyway.
- **A Netlify build step** would run on every deploy, coupling vector-store writes to
  site deployment, and a failed upload would break your deploys.

GitHub Actions costs one manual click, exposes no endpoint, and can be deleted the
moment the milestone is done.

---

## Step 1 — Get the files into the repository

1. Download `autovision-judging-assistant-stage1.zip` and unzip it.
2. Go to `github.com/<you>/autovision-judging-assistant`.
3. Click **Add file → Upload files**, then drag in these folders and files:
   `config/`, `scripts/`, `src/`, `tests/`, `package.json`, `package-lock.json`,
   `.gitignore`, `README.md`, `SETUP-UPLOAD.md`
4. Drag the three PDFs into an `approved-source-docs/` folder. To create the folder in
   the browser: **Add file → Create new file**, type `approved-source-docs/.gitkeep`,
   commit, then upload the PDFs into it.
   The largest PDF is 21 MB, under GitHub's 25 MB browser limit.
5. Commit.

**The workflow file must be created by hand.** Folders beginning with a dot are hidden
and usually will not drag from Finder or Explorer. Click **Add file → Create new file**,
type the filename exactly as:

```
.github/workflows/ferrari-corpus-upload.yml
```

then paste the contents of that file from the zip and commit.

---

## Step 2 — Provide credentials to Actions

Netlify environment variables are not visible to GitHub, so the two values must exist
in both places.

Go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Value |
|---|---|
| `OPENAI_API_KEY` | see the note below |
| `OPENAI_VECTOR_STORE_ID_FERRARI` | the same `vs_…` id configured in Netlify |

**On the API key — create a second one rather than copying the first.** In the OpenAI
dashboard, generate a new key scoped to the same project, name it something like
`github-actions-ingestion`, and use that. Two reasons: if you marked the Netlify
variable as secret, Netlify will not show you the value again anyway; and a separate
key can be revoked after this milestone without disturbing the running application.

Revoke it when Stage 1 is signed off.

---

## Step 3 — Dry run first

**Actions** tab → **Ferrari Corpus Upload and Retrieval Test** → **Run workflow**:

- mode: `dry-run`
- leave everything else as-is

This installs dependencies, regenerates the Stage 1 artifacts, runs the citation
regression test, and contacts OpenAI to count what is already in the store — but
writes nothing. It confirms the credentials work before anything is created.

Expected: ingestion `PASSED_WITH_WARNINGS`, citation test `10 passed`, and a plan of
155 units to upload.

---

## Step 4 — Live upload and retrieval test

**Run workflow** again:

- mode: `upload`
- confirm: `UPLOAD` (typed exactly; the run aborts otherwise)
- question: leave the default, or type your own
- run_retrieval_test: checked

Takes a few minutes, mostly the 155 file uploads.

---

## Step 5 — Read the result

Open the run and read the **Summary** page. The milestone report is rendered there
with every item requested: units uploaded, vector store id, upload status, test
question, retrieved document, verified physical page, citation-resolver result, and
warnings. The same JSON files are attached under **Artifacts**.

The last line states plainly whether the chain is live.

---

## Notes

- **Re-running is safe.** The upload skips any unit already present by `unit_id`, so a
  second run adds nothing and cannot create duplicates.
- **Stage 1 artifacts are regenerated, not committed.** Ingestion is deterministic —
  all 150 As-Built page slices produce identical checksums on every run — so the
  runner reproduces the accepted Stage 1 output exactly. Ingestion and citation logic
  are unchanged from the accepted run.
- **If the vector store id is wrong**, the dry run fails immediately on a 404 and
  nothing is written.
- **If some uploads fail**, the run reports `PARTIAL` with the failing unit ids; re-run
  and only the missing units are retried.
