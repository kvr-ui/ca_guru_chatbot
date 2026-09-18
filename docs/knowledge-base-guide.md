# Writing the knowledge base

Everything the bot is allowed to say lives in `knowledge/`. If a fact is not in there, the bot
hands the question to the team instead of guessing.

## One topic per file

```markdown
# Login — Forgot password / OTP not received

Asked as: forgot password, can't login, otp not coming, reset password, login problem

<facts, steps, and any instruction to the bot, in plain sentences>

Send: <the WhatsApp reply, written exactly as a student should read it>
```

| Part | What it does |
|---|---|
| `# Heading` | Names the topic. Search matches on it. |
| `Asked as:` | The words students actually type. The more real phrasings, the more often this file is found. Never sent. |
| Plain lines | Facts and instructions ("If they paid twice, hand over"). Followed, never sent. |
| `Send:` | The reply. The model sends it nearly word for word. |

## Rules

1. **Keep a file under ~800 characters.** Past 900 it is cut in two and the second half loses its
   heading. `npm run check:kb` warns you.
2. **No TODO / TBD / XXX** in a file — `check:kb` fails on them, because the bot would send them.
3. **Only publishable facts.** Anything account-specific (a student's payment, refund, order,
   login) should say "hand over to the team" rather than answer.
4. Notes for humans go in `docs/`, never `knowledge/` — every file in there is searchable.
5. A `.json` file of `[{ "question": "…", "answer": "…" }]` also works, one chunk per row.

## After editing

```bash
npm run check:kb       # format check
npm run chat           # ask it questions in the terminal
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" 127.0.0.1:<PORT>/admin/reindex   # server run with npm start (PORT from .env)
```

In Docker the knowledge folder is baked into the image, so rebuild (`docker compose up -d --build`).

## Tuning

`KB_MIN_SCORE` (default 0.3) decides "nothing here is about this question". Use `/why` in
`npm run chat` to see the scores. If real questions are handed over although a file covers them,
add phrasings to `Asked as:` first, then lower the score a little.
