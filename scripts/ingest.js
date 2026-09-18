import { assertConfig } from '../src/config.js';
import { ensureIndex, indexStats } from '../src/kb.js';

// Re-embeds knowledge/ now. The server also does this on boot and on POST /admin/reindex.
assertConfig({ requireWacrm: false });
await ensureIndex({ force: true, log: (m) => console.log(m) });
console.log('Done:', indexStats());
