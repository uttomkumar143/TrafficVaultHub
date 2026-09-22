TrafficVaultHub — AI Build Kit (README, read this first)
This folder contains a ready-made "prompt kit" for building your TrafficVaultHub project (CPA Affiliate Network, PRD v10.0) from start to finish. The idea: you build the whole project step by step using the free trial of Claude Fable 5.1 on genspark.com, stay connected to GitHub the whole time, and as soon as a small chunk of work is done it gets committed/pushed to GitHub — so that even if the trial limit or session ends suddenly, none of your work is lost.
All the prompt files are written in English (code-generating models follow English instructions best and make the fewest mistakes). Only this README and the deployment guide are in Bengali.
---
What's in this folder
File	What it's for
`docs/PRD.md`	Your actual PRD (v10.0), copied as-is. This also needs to live inside the repo.
`01-MASTER-SYSTEM-PROMPT.md`	The most important file. Paste this at the start of every new chat session. It tells Claude what the project is, what the architecture is, and which rules to follow.
`02-AUTO-COMMIT-PROTOCOL.md`	The second most important file. Also paste this at the start of every session, right after the master prompt. This is the system that guarantees "auto commit + push as soon as a small unit of work is done," so nothing is lost even if the limit runs out.
Files `03` through `12`	The project's 9 phases (Phase 0 → Phase 8). Paste the next one once the previous phase is finished.
`13-DEPLOYMENT-GUIDE-BN.md`	A Bengali step-by-step guide to connecting everything — genspark.com, GitHub, and Cloudflare.
`STATE-TEMPLATE.md`	Save this as `STATE.md` at the repo root — this is the project's "memory." Claude reads this to understand how far the work has progressed and what's left.
---
How the whole system works, at a glance
```
Every time you start a new session:
  1) Paste 01-MASTER-SYSTEM-PROMPT.md
  2) Paste 02-AUTO-COMMIT-PROTOCOL.md
  3) Send this: "First, read docs/PRD.md and STATE.md from the repo, then tell me
      exactly what phase we are on and what you'll do next."
  4) Claude reads STATE.md and tells you which phase you're currently on
  5) Paste that phase's prompt file (03/04/05...)
  6) Claude does the work — after every small unit is finished, it
     git commits + pushes on its own and updates STATE.md
  7) If the limit runs out / the session cuts off — no problem.
     Everything up to the last commit is already saved on GitHub.
  8) Open a new session and start again from step 1 — Claude will read
     STATE.md and continue exactly where it left off.
```
This loop is your real "safety net" — running out of limit or credits isn't a problem, because:
Work never lives only in Claude's chat memory; it always lives on GitHub.
`STATE.md` acts as the "briefing note" for the next session.
---
Steps to use this (in brief)
Create a new private repo on GitHub — name it `trafficvaulthub`.
Commit this folder's `docs/PRD.md` and `STATE-TEMPLATE.md` (renamed to `STATE.md`) to the repo root — right at the start.
Follow `13-DEPLOYMENT-GUIDE-BN.md` to set up Claude Fable 5.1 on genspark.com and connect GitHub + Cloudflare.
Follow the "at a glance" section above, step by step.
---
Important warnings
Never paste secrets/API keys into the chat. Put them in genspark's or GitHub's "Secrets/Environment Variables" section instead — this is also stated in `02-AUTO-COMMIT-PROTOCOL.md` and `13-DEPLOYMENT-GUIDE-BN.md`.
Free trial/limit terms are set by genspark and Anthropic themselves and can change — this kit only makes sure your work is never lost, it doesn't increase your limits.
If any phase's prompt is large, Claude will break it into smaller sub-tasks on its own and commit one at a time — this rule is written in file `02`.
