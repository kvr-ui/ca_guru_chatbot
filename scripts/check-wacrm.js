import { config } from '../src/config.js';
import { check } from '../src/whatsapp/wacrm.js';

// Verifies WACRM_BASE_URL / WACRM_API_KEY against /api/v1/me. Sends nothing.
const result = await check();
if (!result.ok) {
  console.error(`✗ ${result.error}`);
  process.exit(1);
}
console.log(`✓ wacrm key works (${config.wacrm.baseUrl})`);
console.log(JSON.stringify(result.account, null, 2));
console.log('\nMake sure this is the CA Guru bot\'s OWN account — not the shared FOCAS one the MCQ bot answers on.');
