## 1. Tools used

1. **Before coding (Claude chat):** I used Claude for initial research, clarify ambiguities, pick a stack I could defend (Node.js, Express, TypeScript, Neon Postgres, Gemini), and draft the schema,

2. **Implementation (Google Antigravity IDE):** Project scaffolding, generating boilerplate, and speeding up development.
   - Used the AI Agent for connecting the Neon database with the Node.js application following Neon's recommended practices (CLI deployment, connection pooling with `pg`, and environment variable management).

## 2. Agent Control

- During DB connection, the agent was rushing towards implementing the full migration scripts and database schema right away. I intervened and stopped it to first focus strictly on the `/health` endpoint and verify a successful, live end-to-end database connection to Neon before touching schema definitions.