# AI-LOG.md

## 1. Which AI tools/models I used, and for what

- **Claude (Chat):** Used upfront before writing any code to brainstorm the architecture, challenge initial assumptions, evaluate tech stacks (Node.js/Express vs Go vs Python), draft the minimal Postgres database schema, and design the budget reservation math.
- **Google Antigravity IDE (Agent):** Used for repository scaffolding, typing out Express route handlers, generating test fixtures, wiring environment variables, and writing shell/database migration scripts.

---

## 2. One place the AI was wrong or misleading, and how I caught it

**Misdiagnosing Upstream Model Unavailability as a Network/DNS Timeout:**
When testing completions against Google Gemini, requests consistently timed out after 10 seconds and triggered gateway timeout errors.
- **The AI's misleading diagnosis:** The agent jumped to network-level conclusions, diagnosing the issue as a local dual-stack DNS or IPv6 routing problem on Windows and proposing low-level socket and DNS overrides (such as `dns.setDefaultResultOrder("ipv4first")`).
- **How I caught it:** I realized that treating every timeout as a network quirk was masking the root cause because the provider's actual error payload was not being logged. I rejected the DNS workaround and instead instrumented detailed server-side error logging to capture the exact upstream HTTP status and response body from Gemini.
- **The real root cause:** The logs immediately revealed that Gemini upstream was actually throwing a `503 Service Unavailable` with `"The model is currently experiencing high demand"` for higher-tier models (`gemini-4-hydrogen` and `gemini-3.8-flash`). I proved this by making a request with a lighter text model (`gemini-3.5-flash-lite`), which resolved cleanly without any DNS or networking workarounds.

---

## 3. One place I overrode the AI's suggestion, and why

**Refusing Auto-Migrations and Premature Feature Generation:**
During initial database setup, the coding agent wanted to immediately generate complete migration tables, seed mock keys, write ORM abstraction layers, and wire end-to-end chat routes in one giant batch.
- **Why I overrode it:** I stopped the agent and instructed it to build incrementally. I enforced starting strictly with an independent `/health` check connected to Neon Postgres to prove database connectivity, SSL handshake, and connection pooling first. Only after proving the connection worked did we define the schema and move into routes.
- **No ORM Rule:** The agent also suggested Prisma or Drizzle for "easier types". I rejected this in favor of raw SQL with `pg` so that the atomic conditional `UPDATE` for budget checks was completely transparent, query-optimized, and free of ORM abstraction leaks.

---

## 4. How I stayed in control of code I didn't type by hand

- **Secrets Isolation:** Real upstream credentials (`GEMINI_API_KEY`) and database connection strings were kept exclusively in environment variables loaded via Zod (`src/config.ts`). I ensured neither the agent nor test fixtures ever logged, persisted, or returned raw keys in response payloads or database tables.
- **Manual Verification of Budget & Concurrency Logic:** For every line of budget arithmetic, I verified that JavaScript `bigint` operations and Postgres `BIGINT` columns were used rather than standard `number` floats to eliminate sub-paisa truncation or rounding drift. I reviewed and verified the atomic `UPDATE ... WHERE spent_micro + est <= budget_micro` query and required an explicit concurrency test (`tests/concurrency.test.ts`) with 10 parallel requests to prove that zero budget overshoots occur under race conditions.
- **Defensibility Check:** If the AI introduced an unfamiliar library or an abstraction I couldn't explain from first principles (such as heavy middleware or DI containers), I stripped it out.

---

## 5. Something I had to learn from scratch this weekend

**Serverless Postgres Pooling vs. Interactive Multi-Statement Transactions:**
- When deploying with Neon Postgres on Render, I had to understand the architectural difference between `@neondatabase/serverless` (HTTP-based driver) and standard `pg` (persistent TCP socket pooler).
- HTTP-based drivers work well for single stateless queries but cannot support stateful multi-statement interactive transactions (`BEGIN ... COMMIT`) needed for atomic budget settlement.
- I learned how Neon's PgBouncer pooled connection strings work, configuring `pg.Pool` with SSL (`rejectUnauthorized: false`) and appropriate connection limits (`max: 5`) so the Express service maintains steady pooled connections without hitting Neon's connection limits during burst traffic.
