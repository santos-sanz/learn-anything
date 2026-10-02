# Execution queue

Execute the earliest ready story in this queue. Skip blocked stories until every prerequisite is closed and verified. Epics are tracking, not implementation work. IDs match BACKLOG.md; GitHub issue numbers will be recorded after recreation.

| Order | ID | Story | Prerequisites |
| --- | --- | --- | --- |
| 01 | S01 | Record architecture and runtime decisions | None |
| 02 | S02 | Scaffold TypeScript workspace and developer commands | S01 |
| 03 | S03 | Set up reproducible Convex development backend and schema lifecycle | S02 |
| 04 | S11 | Add NaN adapters and document provider policy gate | S02 |
| 05 | S23 | Add CI quality gates and factory contribution templates | S02 |
| 06 | S04 | Implement project and conversation data schema | S03 |
| 07 | S05 | Enforce Convex function authorization and private file access | S04 |
| 08 | S06 | Implement Convex Auth sign-in and verified agent sessions | S05 |
| 09 | S07 | Host project-scoped agents on Cloudflare Free plan | S01, S06 |
| 10 | S08 | Implement safe document uploads and metadata | S05, S06 |
| 11 | S15 | Implement short-turn microphone capture and Whisper STT | S06, S11 |
| 12 | S21 | Build accessible project dashboard and onboarding | S04, S06 |
| 13 | S09 | Build resumable ingestion job runner | S08 |
| 14 | S18 | Implement explicit translation behaviour | S11, S15 |
| 15 | S10 | Implement source-aware document chunking | S09 |
| 16 | S12 | Validate NaN 4096-dimension embeddings with Convex vector search | S03, S10, S11 |
| 17 | S13 | Build scoped retrieval, reranking and citation contract | S05, S10, S11, S12 |
| 18 | S14 | Implement grounded tutor orchestration | S06, S11, S13 |
| 19 | S22 | Build document management and citation source viewer | S08, S13, S21 |
| 20 | S16 | Add Kokoro speech synthesis and playback | S11, S14 |
| 21 | S19 | Build language-practice tutor mode | S14, S18 |
| 22 | S20 | Build concept-learning tutor mode and progress events | S04, S14 |
| 23 | S17 | Assemble spoken conversation state machine | S14, S15, S16 |
| 24 | S24 | Add bounded observability, rate limits and privacy lifecycle | S08, S11, S17 |
| 25 | S25 | Document agent-only Cloudflare Free/Convex deployment and recovery | S01, S07, S12, S23, S24 |
| 26 | S26 | Verify v0.1 end-to-end release acceptance | S05, S17, S19, S20, S21, S22, S23, S24, S25 |
