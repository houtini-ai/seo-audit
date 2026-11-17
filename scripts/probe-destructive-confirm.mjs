// The "are you sure" gate on destructive data_storage prunes: the USER decides, not the model.
//   npm run build:server && node scripts/probe-destructive-confirm.mjs
// Real server over the SDK's in-memory transport, three clients: one that answers the elicitation
// yes, one that declines, one without elicitation (typed-name confirmation instead).
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sac-confirm-'));
process.env.SAC_DATA_DIR = dataDir;
const { createServer } = await import('../dist/server.js');
const { AuditDatabase } = await import('../dist/core/AuditDatabase.js');
const { dbPathFor } = await import('../dist/core/paths.js');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ` :: ${detail}` : ''}`); cond ? pass++ : fail++; };

const SITE = 'sc-domain:gate.test';
const make = () => { const a = new AuditDatabase(dbPathFor(dataDir, SITE)); a.upsertProperty(SITE, 'apex'); a.close(); };
const exists = () => existsSync(dbPathFor(dataDir, SITE));

async function connect({ elicit } = {}) {
  const { server } = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'probe', version: '0' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  const asked = [];
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => { asked.push(req.params.message); return elicit(req); });
  await server.connect(st);
  await client.connect(ct);
  return { client, asked, close: async () => { await client.close(); await server.close(); } };
}
const del = (client, confirm) => client.callTool({ name: 'data_storage', arguments: { prune: { siteUrl: SITE, action: 'delete-property' }, ...(confirm === undefined ? {} : { confirm }) } });
const text = (r) => r.content?.map(c => c.text).join('\n') ?? '';

try {
  // 1. A client that can ask the user, and the user says no.
  make();
  {
    const c = await connect({ elicit: async () => ({ action: 'accept', content: { confirm: false } }) });
    const r0 = await del(c.client);
    ok(/REFUSED/.test(text(r0)) && exists() && c.asked.length === 0, 'no confirm: a dry run that names what would go; the user is not asked yet');
    const r = await del(c.client, true);
    ok(c.asked.length === 1 && /cannot be undone/.test(c.asked[0]) && c.asked[0].includes(SITE), 'confirm:true asks the user, naming the property and that it is irreversible', c.asked[0]);
    ok(exists() && r.structuredContent?.refused === 'user_declined', 'the user unticked "Yes": nothing deleted', text(r));
    await c.close();
  }
  {
    const c = await connect({ elicit: async () => ({ action: 'decline' }) });
    await del(c.client, true);
    ok(exists(), 'the user declined the form: nothing deleted');
    await c.close();
  }
  // 2. The user says yes.
  {
    const c = await connect({ elicit: async () => ({ action: 'accept', content: { confirm: true } }) });
    const r = await del(c.client, true);
    ok(!exists() && /Deleted/.test(text(r)), 'the user confirmed: deleted', text(r));
    await c.close();
  }
  // 3. A client without elicitation: confirm:true alone is not enough; the typed name is.
  make();
  {
    const c = await connect();
    const r = await del(c.client, true);
    ok(exists() && r.structuredContent?.refused === 'typed_confirm_required' && text(r).includes(`confirm:"${SITE}"`), 'no elicitation: confirm:true is refused and asks for the typed property name', text(r));
    const wrong = await del(c.client, 'sc-domain:other.test');
    ok(exists() && /REFUSED/.test(text(wrong)), 'a different name does not confirm');
    const r2 = await del(c.client, SITE);
    ok(!exists() && /Deleted/.test(text(r2)), 'the typed property name confirms', text(r2));
    await c.close();
  }
  // 4. vacuum is not destructive: no gate.
  make();
  {
    const c = await connect({ elicit: async () => ({ action: 'decline' }) });
    const r = await c.client.callTool({ name: 'data_storage', arguments: { prune: { siteUrl: SITE, action: 'vacuum' } } });
    ok(/Vacuumed/.test(text(r)) && c.asked.length === 0, 'vacuum runs without asking', text(r));
    await c.close();
  }
} finally {
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
