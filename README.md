# CA Guru WhatsApp bot

Answers CA Guru app users on WhatsApp from a curated FAQ (`knowledge/`), and hands anything it
cannot answer to a person in the wacrm inbox.

```
student ─ WhatsApp ─ wacrm ─ POST /webhooks/wacrm (signed) ─┬─ STOP / START
                                                            ├─ with the team? → silent
                                                            ├─ hi / thanks    → fixed reply
                                                            ├─ KB match → OpenAI answer (last 6 turns as context)
                                                            └─ no match / model says HANDOVER
                                                                 → "our team will reply" + bot silent 12h
         reply ─ wacrm POST /api/v1/messages ◀──────────────┘
```

WhatsApp is wired the way `drip_engine` does it (wacrm client, HMAC-signed webhook); the answer
engine is ported from `wati_chat-bot` (markdown KB + OpenAI embeddings).

## Its own number — important

This bot needs **its own wacrm account/number and API key**. On the shared FOCAS account the
Mentor server's MCQ bot answers every incoming message, so both bots would reply to the same
student. `npm run webhook:register` refuses to register if another server already receives
`message.received` on the account.

## Setup

```bash
npm install
cp .env.example .env        # fill in wacrm, OpenAI, Mongo; keep BOT_ALLOWLIST = your team's phones
npm run check:wacrm         # key works? (sends nothing)
```

Add the knowledge (see [docs/knowledge-base-guide.md](docs/knowledge-base-guide.md)), then:

```bash
npm run check:kb            # format check
npm run ingest              # embed it
npm run chat                # talk to it in the terminal — same brain, nothing is sent
```

In `npm run chat`, `/why` shows which files matched and their scores, and `/reset` ends a handover.

## Deploy

```bash
docker compose up -d --build                                   # bot on 127.0.0.1:3007
PUBLIC_HOST=guru-bot.focasedu.com docker compose --profile tls up -d   # + Caddy TLS, if 80/443 are free
```

If the box already runs nginx, proxy `https://<host>/webhooks/wacrm` to `127.0.0.1:3007` and
publish nothing else. Then register the webhook:

```bash
# PUBLIC_BASE_URL=https://guru-bot.focasedu.com in .env
docker compose exec bot node scripts/register-webhook.js --register
# paste the printed WACRM_WEBHOOK_SECRET into .env, then:
docker compose up -d
```

wacrm shows the secret once, and disables an endpoint that keeps failing. If you want to watch
the first events arrive before you have the secret, set `WACRM_WEBHOOK_ALLOW_UNSIGNED=true` (plus
`WEBHOOK_CAPTURE_FILE`) temporarily. That setting is ignored once the secret is set.

**Go live:** message the number from an allowlisted phone and from one that is not (it must stay
silent). Try a KB question, an off-topic one (handover), and STOP / START. Then clear
`BOT_ALLOWLIST` and `docker compose up -d`.

**Leads only:** the bot stays silent for a contact until they send `BOT_TRIGGER_PHRASE`
(default `YOUR LAST ATTEMPT`, the ad's prefilled text — any case, anywhere in the message).
After that it answers everything that contact sends; the list lives in the `activations`
collection. Everyone else is logged as `not_triggered` and left to the team. Blank = answer all.

**Qualifying questions:** a brand-new lead (first trigger phrase) is asked first-time or
re-appearing, then down the branch: Sep 26 groups, when the other group is planned, confidence,
Jan 27 groups, classes, syllabus %, tests. Every path ends with the `CALCULATOR_URL` link. Replies
are read by number, then keywords, then the model; an unclear reply is asked once more, then
skipped. A question asked mid-way is answered and the pending question repeated; a handover ends
the questions, and an unfinished set is dropped after `FLOW_EXPIRY_HOURS`. Answers are kept in
`profiles` and given to the model as context for later replies. Leads activated before this
feature keep plain Q&A.

## How it behaves

| Situation | What happens |
|---|---|
| Question the KB covers | Answered from the matching files only; the last `HISTORY_TURNS` answered exchanges (within `HISTORY_HOURS`) go along so follow-ups work |
| Nothing in the KB scores ≥ `KB_MIN_SCORE` | The model is not called. `HANDOVER_MESSAGE` is sent and the bot goes silent for that chat for `HANDOVER_HOURS` |
| KB matched, but the model judges it unanswered (study doubts, account issues, "talk to a person") | Same handover |
| OpenAI down | Same handover, so a person sees it |
| Staff reply from the wacrm inbox | The bot pauses for that chat (it spots a `message.sent` whose wamid it did not send) |
| A new lead's trigger phrase during a pause | If the bot started the pause (it passed a question to the team), the pause ends and the questions start. If a person replied, the bot stays silent and the questions start the first time the student writes after the pause |
| `hi` / `thanks` / `ok` | Fixed welcome / thanks / no reply. Never reaches the KB, so greetings don't hand over |
| Photo, voice note, file | One "please type your question" per 10 minutes |
| STOP (and variants) | Confirmed once, then silence until START. "How do I stop notifications?" is still answered |
| More than `BOT_MAX_MESSAGES_PER_HOUR` from one number | Ignored for the rest of the hour |

Any wacrm automation that sends messages on this number (welcome auto-reply, broadcasts) also
counts as a staff reply and pauses the bot, so switch those off in wacrm.

## Admin

All routes need `Authorization: Bearer $ADMIN_TOKEN`; without `ADMIN_TOKEN` they are off. The
Caddyfile does not publish them, so call them from the box:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" 127.0.0.1:3007/admin/status          # KB, wacrm key, handovers
curl -H "Authorization: Bearer $ADMIN_TOKEN" -X POST 127.0.0.1:3007/admin/reindex
curl -H "Authorization: Bearer $ADMIN_TOKEN" 127.0.0.1:3007/admin/handovers
curl -H "Authorization: Bearer $ADMIN_TOKEN" -X POST 127.0.0.1:3007/admin/handover/9198XXXXXXXX/resume
curl -H "Authorization: Bearer $ADMIN_TOKEN" 127.0.0.1:3007/admin/conversations/9198XXXXXXXX
curl -H "Authorization: Bearer $ADMIN_TOKEN" 127.0.0.1:3007/admin/profiles/9198XXXXXXXX      # qualifying answers
```

## Data

MongoDB database `CA-Guru-bot` (the bot refuses to boot against `CA-Guru-Ai`):
`messages` (every turn), `handovers`, `optouts`, `activations`, `profiles` (qualifying answers),
`sent` (our wamids, 7-day TTL) and `webhook_events` (dedupe, 7-day TTL). The bot does not look
students up in the product database, and no student data is sent to OpenAI beyond the message
text and a one-line summary of their qualifying answers.

## Code map

| Folder | File | Role |
|---|---|---|
| `src/` | `config.js` | Env vars, defaults, and the startup check |
| `src/http/` | `app.js` | Express app: `/health` and the token-guarded `/admin` routes |
| | `webhook.js` | Signed webhook, dedupe, allowlist, trigger-phrase gate, one-at-a-time processing per contact |
| | `signature.js` | HMAC check (from drip_engine) |
| `src/bot/` | `handler.js` | The decision tree above; shared by the webhook and `npm run chat` |
| | `ai.js` | The prompt (rules, price handover, English only) and the grounded answer |
| | `questionnaire.js` | Qualifying questions for new leads, ending at the calculator link |
| | `handover.js`, `optout.js` | Chats paused for the team, STOP / START (from wati_chat-bot) |
| `src/kb/` | `kb.js` | Loads `knowledge/`, embeds it, searches it |
| `src/whatsapp/` | `wacrm.js` | wacrm client (from drip_engine) |
| | `outbox.js` | Sending (with one 429 retry) and telling our sends apart from staff replies |
| `src/store/` | `mongo.js`, `conversations.js`, `dedup.js` | MongoDB connection, chat log, webhook dedupe |
| `src/providers/` | `openai.js` | OpenAI chat call |

`npm test` runs everything against a fake wacrm/OpenAI and a throwaway local MongoDB database.
# ca_guru_chatbot
