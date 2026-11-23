# FinHub (Strata) — apps/noisysource/finhub

> Context: root `../../../CLAUDE.md`. Read `STATUS.md` here first.

FinHub's only UI (Strata Treasury, from AI Studio). Real financial data: no sample data in
the real book, no prod writes without Renato's OK.

- **No AI here, no server.** Atlas (`noisysource/Atlas`) reads documents and writes the data
  into the book; FinHub reads and shows it. Don't add Gemini/LLM calls or Gmail/Drive access
  to this app.
- One shared book: `finhub_books/{FINHUB_BOOK_ID}` (`src/firebase.ts`). Strata's `userId`
  field holds the book id. Rules: FinHub block of `firebase/noisysource/firestore.rules`.
- Run: `pnpm dev:finhub` (noisysource-dev). Build: `pnpm --filter finhub build:nsdev`.
- Strata's own tsconfig (not strict): keep new code typed anyway.
