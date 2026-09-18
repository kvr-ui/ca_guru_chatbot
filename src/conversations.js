import { config } from './config.js';
import { collection } from './mongo.js';

/**
 * The conversation log, one document per message in `messages`. It is also where the model's
 * short-term memory comes from: only turns the bot actually answered (`inHistory`) are replayed,
 * so a handover or an ignored message never reaches the prompt.
 *
 * Never throws into the caller — losing a log line is cheaper than not replying to a student.
 */
export async function logTurn({ waId, name, text, replies = [], meta = {}, elapsedMs = null }) {
  try {
    const now = new Date();
    const inHistory = meta.reason === 'answered';
    const base = { waId, name: name ?? null, reason: meta.reason ?? null, inHistory, createdAt: now };
    const docs = [{ ...base, role: 'user', text: String(text ?? ''), type: meta.type ?? 'text' }];
    for (const reply of replies) {
      docs.push({
        ...base,
        role: 'assistant',
        text: reply,
        model: meta.model ?? null,
        sources: meta.sources ?? null,
        elapsedMs,
        // One millisecond later so the reply always sorts after the question.
        createdAt: new Date(now.getTime() + 1),
      });
    }
    await (await collection('messages')).insertMany(docs);
  } catch (err) {
    console.error('conversation log failed:', err.message);
  }
}

/** The last HISTORY_TURNS answered exchanges from the last HISTORY_HOURS, oldest first. */
export async function lastTurns(waId, { turns = config.bot.historyTurns, hours = config.bot.historyHours } = {}) {
  if (!turns) return [];
  try {
    const since = new Date(Date.now() - hours * 3_600_000);
    const docs = await (await collection('messages'))
      .find({ waId, inHistory: true, createdAt: { $gte: since } }, { projection: { role: 1, text: 1 } })
      .sort({ createdAt: -1 })
      .limit(turns * 2)
      .toArray();
    return docs.reverse().map((d) => ({ role: d.role, content: d.text }));
  } catch (err) {
    console.error('history lookup failed:', err.message);
    return [];
  }
}

export async function conversation(waId, { limit = 100 } = {}) {
  const docs = await (await collection('messages')).find({ waId }).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.reverse().map(({ _id, ...d }) => d);
}
