import { PortfolioStore, PORTFOLIO_JOB_SCOPE } from './PortfolioStore.js';
import { planRefresh, quotePlan, type PortfolioTierSel } from './portfolioPlan.js';
import { liveJobTypes } from './JobManager.js';
import type { PortfolioRefreshArgs } from './PortfolioRefresh.js';

/**
 * Scheduled portfolio refreshes. Recording a schedule is
 * the user's consent to spend up to a monthly cap. The rules:
 *  - a due run is CLAIMED atomically in _portfolio.db (BEGIN IMMEDIATE + compare-and-set on the due
 *    dates), so two processes ticking at once (Claude Desktop + Claude Code + the runner) start it once;
 *  - nothing is claimed while a portfolio job is live or queued (the `_portfolio.db` job scope);
 *  - the next due date is computed from NOW, so a machine that was off catches up once, not per missed week;
 *  - a run whose quote rose >25% since consent is skipped with "re-confirm" (domains were added);
 *  - the monthly cap is enforced again inside the job, between endpoint families.
 */
export const SCHEDULE_TICK_MS = 15 * 60_000;
const DRIFT_LIMIT = 1.25;

export interface ScheduleInput { budgetUsd: number; weeklyDow?: number; monthlyDom?: number; enabled?: boolean }
export interface SchedulePreview {
  budgetUsd: number; weeklyDow: number; monthlyDom: number;
  domains: number; weeklyQuote: number; monthlyQuote: number; projectedMonthUsd: number;
  fitsBudget: boolean; nextWeeklyDue: string; nextMonthlyDue: string; note: string;
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Next occurrence (UTC, 06:00) of a weekday strictly after `now`. */
export function nextWeekly(now: Date, dow: number): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6));
  let add = (dow - d.getUTCDay() + 7) % 7;
  if (add === 0 && d.getTime() <= now.getTime()) add = 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d;
}
/** Next occurrence (UTC, 06:00) of a day of the month (1-28) strictly after `now`. */
export function nextMonthly(now: Date, dom: number): Date {
  const day = Math.min(Math.max(1, dom), 28);
  let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, 6));
  if (d.getTime() <= now.getTime()) d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day, 6));
  return d;
}

/** What a schedule would cost, without saving it (the preview step of the two-step consent). */
export function previewSchedule(dataDir: string, input: ScheduleInput, now: Date = new Date()): SchedulePreview {
  const store = new PortfolioStore(dataDir);
  try {
    store.syncOwned();
    const ds = store.list();
    const wq = quotePlan(planRefresh(ds, 'weekly'), 'weekly', ds.length).usd;
    const mq = quotePlan(planRefresh(ds, 'monthly'), 'monthly', ds.length).usd;
    const projected = round2(wq * 4.35 + mq);
    const weeklyDow = input.weeklyDow ?? 1, monthlyDom = input.monthlyDom ?? 3;
    return {
      budgetUsd: input.budgetUsd, weeklyDow, monthlyDom, domains: ds.length,
      weeklyQuote: wq, monthlyQuote: mq, projectedMonthUsd: projected, fitsBudget: projected <= input.budgetUsd,
      nextWeeklyDue: nextWeekly(now, weeklyDow).toISOString(), nextMonthlyDue: nextMonthly(now, monthlyDom).toISOString(),
      note: `Weekly on ${DOW[weeklyDow]} ($${wq} a run) plus monthly on day ${monthlyDom} ($${mq}): about $${projected} a month for ${ds.length} domains. `
        + (projected <= input.budgetUsd ? `That fits the $${input.budgetUsd} cap.` : `That exceeds the $${input.budgetUsd} cap, so once it's reached the rest of the month's work is skipped.`)
        + ' The cap covers portfolio refreshes only.',
    };
  } finally { store.close(); }
}

/** Save the schedule (the confirm step). Records the consent: domain count + quotes at this moment. */
export function saveSchedule(dataDir: string, input: ScheduleInput, now: Date = new Date()): SchedulePreview & { enabled: boolean } {
  const p = previewSchedule(dataDir, input, now);
  const enabled = input.enabled !== false;
  const store = new PortfolioStore(dataDir);
  try {
    store.db.prepare(
      `INSERT INTO portfolio_schedule (id, enabled, weekly_dow, monthly_dom, budget_usd_month, consent_domains, consent_quote_weekly, consent_quote_monthly, consented_at, next_weekly_due, next_monthly_due, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, weekly_dow=excluded.weekly_dow, monthly_dom=excluded.monthly_dom,
         budget_usd_month=excluded.budget_usd_month, consent_domains=excluded.consent_domains, consent_quote_weekly=excluded.consent_quote_weekly,
         consent_quote_monthly=excluded.consent_quote_monthly, consented_at=excluded.consented_at,
         next_weekly_due=excluded.next_weekly_due, next_monthly_due=excluded.next_monthly_due, updated_at=excluded.updated_at`,
    ).run(enabled ? 1 : 0, p.weeklyDow, p.monthlyDom, input.budgetUsd, p.domains, p.weeklyQuote, p.monthlyQuote, now.toISOString(),
      enabled ? p.nextWeeklyDue : null, enabled ? p.nextMonthlyDue : null, now.toISOString());
    return { ...p, enabled };
  } finally { store.close(); }
}

export function disableSchedule(dataDir: string, now: Date = new Date()): void {
  const store = new PortfolioStore(dataDir);
  try {
    store.db.prepare(`UPDATE portfolio_schedule SET enabled = 0, next_weekly_due = NULL, next_monthly_due = NULL, updated_at = ? WHERE id = 1`).run(now.toISOString());
  } finally { store.close(); }
}

export interface Claim { tier: PortfolioTierSel; args: PortfolioRefreshArgs }

/**
 * Claim whatever is due, atomically. Returns the run to submit, or null (nothing due, another process
 * claimed it, a portfolio job is live, or the quote drifted past consent: recorded as a skipped run).
 */
export function claimDue(dataDir: string, now: Date = new Date()): Claim | null {
  const live = liveJobTypes(dataDir, PORTFOLIO_JOB_SCOPE);
  if (live && (live.has('portfolio') || live.queued?.has('portfolio'))) return null;
  const store = new PortfolioStore(dataDir);
  try {
    // Owned rows are synced before the transaction (syncOwned opens property DBs).
    store.syncOwned();
    const ds = store.list();
    const q = (t: 'weekly' | 'monthly') => quotePlan(planRefresh(ds, t), t, ds.length).usd;
    return store.db.transaction((): Claim | null => {
      const s = store.db.prepare(`SELECT * FROM portfolio_schedule WHERE id = 1 AND enabled = 1`).get() as any;
      if (!s) return null;
      const nowIso = now.toISOString();
      const weeklyDue = !!s.next_weekly_due && s.next_weekly_due <= nowIso;
      const monthlyDue = !!s.next_monthly_due && s.next_monthly_due <= nowIso;
      if (!weeklyDue && !monthlyDue) return null;
      const tier: PortfolioTierSel = weeklyDue && monthlyDue ? 'all' : weeklyDue ? 'weekly' : 'monthly';
      // Compare-and-set on the due dates read above: only one process advances them.
      const r = store.db.prepare(
        `UPDATE portfolio_schedule SET next_weekly_due = ?, next_monthly_due = ?, updated_at = ?
         WHERE id = 1 AND COALESCE(next_weekly_due,'') = COALESCE(?,'') AND COALESCE(next_monthly_due,'') = COALESCE(?,'')`,
      ).run(
        weeklyDue ? nextWeekly(now, s.weekly_dow).toISOString() : s.next_weekly_due,
        monthlyDue ? nextMonthly(now, s.monthly_dom).toISOString() : s.next_monthly_due,
        nowIso, s.next_weekly_due, s.next_monthly_due,
      );
      if (r.changes !== 1) return null;
      const drifted: string[] = [];
      if (weeklyDue && s.consent_quote_weekly > 0 && q('weekly') > s.consent_quote_weekly * DRIFT_LIMIT) drifted.push(`weekly $${q('weekly')} vs $${s.consent_quote_weekly} agreed`);
      if (monthlyDue && s.consent_quote_monthly > 0 && q('monthly') > s.consent_quote_monthly * DRIFT_LIMIT) drifted.push(`monthly $${q('monthly')} vs $${s.consent_quote_monthly} agreed`);
      if (drifted.length) {
        store.db.prepare(`INSERT INTO portfolio_run (started_at, finished_at, tier, trigger, quoted_usd, status, note) VALUES (?, ?, ?, 'schedule', NULL, 'skipped-reconfirm', ?)`)
          .run(nowIso, nowIso, tier, `Skipped: the cost rose more than 25% since the schedule was agreed (${drifted.join('; ')}), most likely because domains were added. Re-confirm the schedule in chat.`);
        return null;
      }
      return { tier, args: { tier, trigger: 'schedule', budgetUsd: s.budget_usd_month } };
    }).immediate();
  } finally { store.close(); }
}

/**
 * Start the in-process scheduler: first tick after 30 s, then every 15 minutes, `unref`'d so it never
 * keeps a process alive. `submit` hands the claimed run to the job system. Returns a stop function.
 */
export function startPortfolioScheduler(opts: {
  dataDir: () => string;
  submit: (args: PortfolioRefreshArgs) => string;
  log?: (msg: string) => void;
  tickMs?: number;
}): () => void {
  const log = opts.log ?? ((m: string) => console.error(`[portfolio] ${m}`));
  const tick = () => {
    try {
      const c = claimDue(opts.dataDir());
      if (c) log(`scheduled ${c.tier} refresh submitted as job ${opts.submit(c.args)}`);
    } catch (e) { log(`scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const first = setTimeout(tick, 30_000);
  first.unref?.();
  const t = setInterval(tick, opts.tickMs ?? SCHEDULE_TICK_MS);
  t.unref?.();
  return () => { clearTimeout(first); clearInterval(t); };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
