import { config, assertConfig } from './src/config.js';
import { app } from './src/app.js';
import { ensureIndex } from './src/kb.js';
import { loadHandovers } from './src/handover.js';
import { loadOptOuts } from './src/optout.js';
import { closeMongo } from './src/mongo.js';

assertConfig();

if (!config.wacrm.webhookSecret) {
  console.warn(
    config.wacrm.webhookAllowUnsigned
      ? 'WACRM_WEBHOOK_SECRET is not set — accepting UNSIGNED webhooks (setup mode).'
      : 'WACRM_WEBHOOK_SECRET is not set — every webhook will be rejected until it is.'
  );
}

await ensureIndex({ log: (m) => console.log(`[kb] ${m}`) });
const [handovers, optouts] = await Promise.all([loadHandovers(), loadOptOuts()]);
console.log(`${handovers} chat(s) with the team, ${optouts} opted out.`);
console.log(
  config.bot.allowlist.size
    ? `Allowlist mode: answering only ${config.bot.allowlist.size} number(s).`
    : 'LIVE: answering every number that messages the bot.'
);

const server = app.listen(config.port, config.host, () => {
  console.log(`${config.bot.name} bot listening on http://${config.host}:${config.port}`);
});

async function shutdown(signal) {
  console.log(`${signal} — shutting down`);
  server.close();
  await closeMongo().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
