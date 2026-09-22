# TrafficVaultHub — AUTO-COMMIT & SESSION-RESUME PROTOCOL
### Paste this right after the Master System Prompt, in every session.

This chat session may end at any time — usage limit, timeout, or trial expiry — without warning and without me getting a chance to finish or save anything through the chat interface itself. Because of that, GitHub (not this chat) is the only source of truth for progress. Follow this protocol exactly, without exception, for the rest of this session.

## 1. Work in small, committable units

Never treat a task as "one big block of work to finish and commit at the end." Instead, break every task into the smallest unit that leaves the repository in a working, non-broken state, for example:
- one database migration file
- one backend module/route added or completed
- one frontend component or page completed
- one test file added and passing
- one config/infra file added

After **each** such unit — not after the whole feature — do the full commit sequence in section 2. A session that produces ten small units should produce roughly ten commits, not one.

## 2. Commit sequence (run after every unit of work)

```bash
git add -A
git commit -m "<type>(<module>): <short description>"
git push origin <current-branch>
```

Commit message types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `migration`. Example: `feat(offers): add offer versioning table and migration 0007`.

If `git push` fails (network hiccup, auth token expired, etc.), retry once; if it still fails, say so explicitly and keep the local commit — do not silently continue as if it succeeded, and do not lose the working tree.

**Never wait to accumulate multiple units of work before committing.** A half-finished feature that at least compiles/builds is committed. If something is genuinely too incomplete to commit safely (e.g. a syntax error), say so, fix it to at least a valid state, then commit.

## 3. STATE.md — the project's memory across sessions

`STATE.md` lives at the repo root (template provided in this kit as `STATE-TEMPLATE.md` — rename it to `STATE.md` on first use and commit it). After every commit in section 2, also update `STATE.md` in the same commit (or an immediate follow-up commit) with:

- **Current phase** (e.g. "Phase 2 — Offers & Marketplace")
- **Last completed unit** (one line, plain language)
- **Next planned unit** (one line, plain language — what you'd do next if the session continued)
- **Open questions / blockers**, if any
- **Timestamp** (UTC)

Keep `STATE.md` short and current — it should always describe *right now*, not a full history. A full history belongs in git log and commit messages, not in `STATE.md`.

## 4. Starting (or resuming) a session

At the very start of every session, before writing any code:
1. Read `docs/PRD.md` for the relevant section(s).
2. Read `STATE.md` in full.
3. State back, in one short paragraph, what phase the project is in and what the next unit of work is, based on what you just read — not from memory of a previous chat.
4. Only then proceed with the phase prompt given to you.

If `STATE.md` doesn't exist yet, this is the very first session: create it from `STATE-TEMPLATE.md`, commit it, and start from Phase 0.

## 5. If you hit the usage limit mid-task

You cannot detect your own limit in advance, so the only defense is discipline, not prediction: as long as you are following sections 1–3 continuously, the repo is never more than one small unit of work behind. There is nothing else to do in this situation except keep following the protocol — do not save up work "to commit at the end," because there may be no "end" from the chat's perspective.

## 6. Secrets — never in git, never in chat

Never write real API keys, Cloudflare tokens, database credentials, payout provider secrets, or webhook secrets into any file that gets committed, and never paste them into this chat. Use `.env.example` (with placeholder values only) in the repo, and real values only in Cloudflare's environment variable / secrets configuration or GitHub Actions secrets, as covered in the deployment guide. If a `.gitignore` doesn't already exclude `.env`, `.dev.vars`, and similar files, create/update it before the first commit.

## 7. What "done" looks like at the end of any session

Before ending a response, or if you sense the conversation is being wrapped up, do one final check: is the latest work committed and pushed, and is `STATE.md` accurate? If not, do that now, then confirm it explicitly in your reply (e.g. "Pushed commit `abc1234`, STATE.md updated — safe to end session here").

Acknowledge that you will follow this protocol for the rest of the session, then wait for the phase prompt.
