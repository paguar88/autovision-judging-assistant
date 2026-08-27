# Putting the Stage 1 package into GitHub

Your repository currently has `README.md` and the workflow. Everything the workflow
executes is still missing, which is why it reported a missing lock file and no
`build/ferrari/` output. Nothing is wrong with the code — it was never transferred.

This is a browser-only procedure. No Node, no terminal, no local install.

---

## Step 1 — Download and unzip

Download `autovision-judging-assistant-stage1.zip` and unzip it. You will get a folder
containing `config`, `scripts`, `src`, `tests`, `approved-source-docs`, `package.json`,
`package-lock.json`, and `FILES.md`.

The three source PDFs are already inside `approved-source-docs/`. You do not need to
find them again.

---

## Step 2 — Upload the contents

1. Open `github.com/<you>/autovision-judging-assistant`
2. **Add file → Upload files**
3. Open the unzipped folder. Select **everything inside it** — `Cmd+A` on macOS,
   `Ctrl+A` on Windows — and drag the selection into the browser window.

> **Drag the contents, not the folder.** If you drag the folder itself, GitHub nests
> everything under `autovision-judging-assistant-stage1/…` and the workflow will not
> find any of it. You should see `config`, `scripts`, `src`, `tests`, and
> `approved-source-docs` listed at the top level of the upload preview — not a single
> folder name.

4. Commit to `main`.

GitHub preserves folder structure on drag-and-drop, so the directories are created for
you. The upload is about 22 MB, almost all of it the As-Built PDF; the browser limit is
25 MB per file, so it fits.

**If the upload stalls on the large PDF**, do it in two commits: first drag everything
except `approved-source-docs`, commit, then drag `approved-source-docs` on its own.

**If drag-and-drop misbehaves**, press `.` (full stop) on the repository page. That
opens github.dev, a full editor in the browser, where you can drag files into the
explorer and commit from the Source Control panel.

`.gitignore` is a hidden dot-file and may not appear when dragging. It is optional —
the workflow runs without it.

---

## Step 3 — Replace the workflow file

The workflow has been updated to check the repository contents before doing anything,
so an incomplete upload now names the missing files instead of failing on an npm error.

1. Open `.github/workflows/ferrari-corpus-upload.yml` in GitHub
2. Click the pencil icon
3. Select all, delete, paste the new contents from `ferrari-corpus-upload.yml`
4. Commit

---

## Step 4 — Verify before spending anything

Run the workflow with mode `dry-run`.

The first step now prints a checklist of every required file. If anything is missing it
stops there, names it, and contacts nothing. If everything is present you will see 12
`ok` lines, `source PDFs found: 3`, then dependency install, ingestion, and the citation
test.

**Expected on a complete repository:**

- ingestion status `PASSED_WITH_WARNINGS`, 155 units, 155 slices, 0 blocking errors
- citation chain test `10 passed, 0 failed`
- upload plan: 155 units, nothing written

Only then run mode `upload` with confirm `UPLOAD`.

---

## What was and was not changed

Ingestion and citation logic are byte-for-byte the frozen versions. Re-verified after
these edits: `PASSED_WITH_WARNINGS`, 155 units, 155 slices, 0 blocking errors, citation
tests 10/10.

Two changes, both in the workflow file only:

- a preflight step that verifies repository contents and names what is missing
- `if-no-files-found: ignore` on the artifact step, so a run that stops early reports
  the real error instead of an unrelated warning about `build/ferrari/`

`FILES.md` in the zip lists every required file with its size and checksum, and the
preflight step checks the same list.
