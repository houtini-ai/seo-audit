/**
 * Optional API keys, read placeholder-safe (#58).
 *
 * Optional tiers (DataForSEO, Majestic, CrUX) used to switch on whenever their env var was truthy,
 * so `MAJESTIC_API_KEY="your-majestic-key-here"`, `"<your key>"`, `" "` or an unsubstituted
 * `${user_config.majestic_api_key}` from an MCP host all read as "configured": the client was
 * built, the dashboard said the tier was on, and every call then failed at the provider with a
 * 401/403. One helper reads every optional key, so "set" means "looks like a real value".
 */

/** The optional keys the server reads, and the tier each one switches on (for the stderr note). */
export const OPTIONAL_SECRETS = {
  DATAFORSEO_USERNAME: 'DataForSEO tier',
  DATAFORSEO_PASSWORD: 'DataForSEO tier',
  MAJESTIC_API_KEY: 'Majestic tier',
  CRUX_API_KEY: 'CrUX tier',
} as const;
export type OptionalSecretName = keyof typeof OPTIONAL_SECRETS;

// Template text people paste and forget to replace. Deliberately narrow: a real key/password that
// happens to contain one of these words is possible but rare, and the failure mode of letting a
// placeholder through (a tier that claims to be on and then 401s) is the one this exists to stop.
const PLACEHOLDER_RE = /your[-_ ]|key[-_ ]?here|changeme|^x{3,}$|placeholder|example/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The documentation domains (RFC 2606) no real account uses: you@example.com, me@example.org.
const RESERVED_EMAIL_RE = /@(example\.(com|org|net)|[^@]*\.(example|invalid|test))$/i;

/** Why a raw value counts as unset, or null when it looks like a real value. Pure, for tests. */
export function placeholderReason(raw: string | undefined | null): 'unset' | 'empty' | 'template' | 'placeholder' | null {
  if (raw == null) return 'unset';
  const v = raw.trim();
  if (!v) return 'empty';
  if (v.includes('${')) return 'template';            // an MCP host's unsubstituted ${user_config.x}
  if (/^<.*>$/.test(v)) return 'placeholder';
  // An email address (a DataForSEO login is one) is judged on its reserved domain only: the word
  // patterns below match inside real addresses (seo@example-agency.co.uk, bob@your-seo.com) and
  // would switch the whole tier off for a working account.
  if (EMAIL_RE.test(v)) return RESERVED_EMAIL_RE.test(v) ? 'placeholder' : null;
  return PLACEHOLDER_RE.test(v) ? 'placeholder' : null;
}

const warned = new Set<string>();

/**
 * The trimmed value of an optional key, or undefined when it is missing, blank or a placeholder.
 * A non-empty value that is rejected writes ONE stderr line per name per process (never stdout:
 * MCP speaks JSON-RPC there), e.g. "MAJESTIC_API_KEY looks like a placeholder; Majestic tier disabled."
 */
export function optionalSecret(name: OptionalSecretName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[name];
  const reason = placeholderReason(raw);
  if (!reason) return raw!.trim();
  if ((reason === 'template' || reason === 'placeholder') && !warned.has(name)) {
    warned.add(name);
    console.error(`${name} looks like a placeholder; ${OPTIONAL_SECRETS[name]} disabled.`);
  }
  return undefined;
}

/** DataForSEO needs both halves; either one missing or a placeholder leaves the tier off. */
export function dataForSeoCredentials(env: NodeJS.ProcessEnv = process.env): { user: string; pass: string } | null {
  const user = optionalSecret('DATAFORSEO_USERNAME', env);
  const pass = optionalSecret('DATAFORSEO_PASSWORD', env);
  return user && pass ? { user, pass } : null;
}

/** For the coming CrUX work (#55 item 4): the key, or undefined when unset or a placeholder. */
export const cruxApiKey = (env: NodeJS.ProcessEnv = process.env): string | undefined => optionalSecret('CRUX_API_KEY', env);
