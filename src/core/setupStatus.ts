// What is configured on this machine, read locally (no network): the Search Console key file, the
// optional keys, the data dir and its properties, the job-runner mode. It reaches the model two
// ways: one line in the server instructions (the only text a model sees before its first call), and
// a block at the top of seo_audit_help, which every credentials error points to. Before this, a
// missing or placeholder key surfaced only on stderr or as the error of whichever tool hit it first.
import { existsSync, readFileSync } from 'node:fs';
import { dataForSeoCredentials, optionalSecret, placeholderReason } from './secrets.js';
import { listLocalProperties } from './webServer.js';
import { jobRunnerModeFromEnv } from './JobManager.js';

export interface SourceStatus { ok: boolean; detail: string; fix?: string }
export interface SetupStatus {
  gsc: SourceStatus & { clientEmail?: string };
  dataforseo: SourceStatus;
  majestic: SourceStatus;
  crux: SourceStatus;
  dataDir: string;
  properties: number;
  runner: 'in-process' | 'external';
}

const GSC_FIX = 'Set GOOGLE_APPLICATION_CREDENTIALS to the path of a Google Cloud service-account JSON key, then add that key\'s client_email as a user on the property in Search Console (manual/getting-started.md, step 2).';

function gscStatus(env: NodeJS.ProcessEnv): SetupStatus['gsc'] {
  const raw = env.GOOGLE_APPLICATION_CREDENTIALS;
  const reason = placeholderReason(raw);
  if (reason === 'unset' || reason === 'empty') return { ok: false, detail: 'GOOGLE_APPLICATION_CREDENTIALS is not set', fix: GSC_FIX };
  if (reason) return { ok: false, detail: `GOOGLE_APPLICATION_CREDENTIALS looks like a placeholder (${raw})`, fix: GSC_FIX };
  const file = raw!.trim();
  if (!existsSync(file)) return { ok: false, detail: `the key file ${file} does not exist`, fix: GSC_FIX };
  try {
    const key = JSON.parse(readFileSync(file, 'utf8')) as { type?: string; client_email?: string };
    if (key.type !== 'service_account' || !key.client_email) return { ok: false, detail: `${file} is not a service-account key (no type "service_account" / client_email)`, fix: GSC_FIX };
    return { ok: true, detail: `service account ${key.client_email} (access to a property is checked by list_properties)`, clientEmail: key.client_email };
  } catch {
    return { ok: false, detail: `${file} is not readable JSON`, fix: GSC_FIX };
  }
}

const optional = (on: boolean, names: string, what: string, fix: string): SourceStatus =>
  on ? { ok: true, detail: `${names} set` } : { ok: false, detail: `${names} not set (or a placeholder): ${what} off`, fix };

export function setupStatus(dataDir: string, env: NodeJS.ProcessEnv = process.env): SetupStatus {
  let properties = 0;
  try { properties = listLocalProperties(dataDir).length; } catch { /* unreadable data dir */ }
  return {
    gsc: gscStatus(env),
    dataforseo: optional(!!dataForSeoCredentials(env), 'DATAFORSEO_USERNAME / DATAFORSEO_PASSWORD', 'the paid keyword, SERP, competitor and backlink tools are', 'Optional, paid: a DataForSEO account (manual/dataforseo.md).'),
    majestic: optional(!!optionalSecret('MAJESTIC_API_KEY', env), 'MAJESTIC_API_KEY', 'Trust Flow enrichment is', 'Optional, paid (manual/majestic.md).'),
    crux: optional(!!optionalSecret('CRUX_API_KEY', env), 'CRUX_API_KEY', 'real-user Core Web Vitals (sync_crux) are', 'Optional, free: a Google Cloud API key with the Chrome UX Report API (manual/getting-started.md, "CrUX key").'),
    dataDir,
    properties,
    runner: jobRunnerModeFromEnv(env) === 'external' ? 'external' : 'in-process',
  };
}

const mark = (s: SourceStatus): string => (s.ok ? 'on' : 'OFF');

/** One line for the server instructions. */
export function setupStatusLine(s: SetupStatus): string {
  return `SETUP AT START: Search Console ${mark(s.gsc)}${s.gsc.ok ? '' : ` (${s.gsc.detail})`}; DataForSEO ${mark(s.dataforseo)}; Majestic ${mark(s.majestic)}; CrUX ${mark(s.crux)}; ${s.properties} propert${s.properties === 1 ? 'y' : 'ies'} with local data.`;
}

/** The block at the top of seo_audit_help. */
export function setupStatusText(s: SetupStatus): string {
  const row = (name: string, x: SourceStatus): string => `- **${name}: ${x.ok ? 'on' : 'off'}** - ${x.detail}.${x.ok || !x.fix ? '' : ` ${x.fix}`}`;
  return [
    '## Setup on this machine',
    row('Search Console', s.gsc),
    row('DataForSEO', s.dataforseo),
    row('Majestic', s.majestic),
    row('CrUX', s.crux),
    `- **Data:** ${s.properties} propert${s.properties === 1 ? 'y' : 'ies'} with local data in ${s.dataDir}.${s.properties ? '' : ' Run refresh_property for a property list_properties shows.'}`,
    `- **Jobs:** ${s.runner === 'external' ? 'queued for a separate seo-audit-runner process (SAC_JOB_RUNNER=external)' : 'run inside this server'}.`,
    s.gsc.ok ? '- Next: `list_properties` (free) confirms the service account can see your properties; an empty list means its email is not yet a user on them.' : '- Search Console is required for most of this tool; everything that needs it fails until it is set.',
    '',
  ].join('\n');
}
