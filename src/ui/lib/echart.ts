// EChartWrapper - every chart (including stat bars and gauges) goes through
// here: lifecycle (init/dispose), ResizeObserver, light/dark palette from the
// CSS tokens, axis discipline (M/k labels, whisper dashed gridlines),
// zero-delay tooltips, and echarts.connect() groups for cross-chart crosshair
// sync on the time-series stack.
import * as echarts from 'echarts';
import { fmtAxis } from './h.js';

export interface ChartPalette {
  text: string;
  axisText: string;
  muted: string;
  accent: string;
  grid: string;
  border: string;
  surface: string;
  success: string;
  danger: string;
  warning: string;
  info: string;
  categorical: string[];
}

const cssVar = (n: string, fb = ''): string =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;

export function chartPalette(): ChartPalette {
  return {
    text: cssVar('--text-primary', '#17191c'),
    axisText: cssVar('--chart-axis', '#757c86'),
    muted: cssVar('--text-muted', '#757c86'),
    accent: cssVar('--accent', '#cd2026'),
    grid: cssVar('--chart-grid', '#eef1f4'),
    border: cssVar('--border-standard', '#e3e6ea'),
    surface: cssVar('--bg-surface', '#ffffff'),
    success: cssVar('--intent-success', '#1f9d64'),
    danger: cssVar('--intent-danger', '#cf3742'),
    warning: cssVar('--intent-warning', '#c9821a'),
    info: cssVar('--intent-info', '#3f8ecc'),
    categorical: Array.from({ length: 8 }, (_, i) => cssVar(`--chart-categorical-${i + 1}`, '#757c86')),
  };
}

/** Shared axis styling: axis-discipline labels + whisper dashed gridlines. */
export function axisDefaults(col: ChartPalette, opts: { numeric?: boolean } = {}) {
  return {
    axisLine: { lineStyle: { color: col.border } },
    axisLabel: {
      color: col.axisText, fontSize: 11,
      ...(opts.numeric ? { formatter: (v: number) => fmtAxis(v) } : {}),
    },
    nameTextStyle: { color: col.axisText, fontSize: 11 },
    splitLine: { lineStyle: { color: col.grid, type: 'dashed' as const } },
  };
}

/** Zero-delay themed tooltip (brief pattern #5 - density via tooltips). */
export function tooltipDefaults(col: ChartPalette, trigger: 'axis' | 'item' = 'axis') {
  return {
    trigger,
    showDelay: 0,
    transitionDuration: 0.18,
    backgroundColor: col.surface,
    borderColor: col.border,
    textStyle: { color: col.text, fontSize: 12 },
    extraCssText: 'box-shadow: var(--shadow-sm); border-radius: 8px;',
  };
}

export class EChartWrapper {
  private chart: echarts.ECharts | null = null;
  private ro: ResizeObserver | null = null;
  private el: HTMLElement;
  private group?: string;

  constructor(elOrId: string | HTMLElement, opts: { group?: string } = {}) {
    this.el = typeof elOrId === 'string' ? document.getElementById(elOrId)! : elOrId;
    this.group = opts.group;
  }

  /** (Re)build the chart with a full option. Re-init keeps theme-change simple. */
  setOption(option: echarts.EChartsCoreOption): void {
    this.chart?.dispose();
    this.chart = echarts.init(this.el);
    this.chart.setOption(option);
    if (this.group) {
      this.chart.group = this.group;
      echarts.connect(this.group); // crosshair/tooltip sync across the stack
    }
    if (!this.ro) {
      this.ro = new ResizeObserver(() => this.resizeIfVisible());
      this.ro.observe(this.el);
    }
  }

  /** Centered muted message for the no-data case (chart canvas kept for layout). */
  setEmpty(text: string, col: ChartPalette): void {
    this.setOption({
      title: { text, left: 'center', top: 'center', textStyle: { color: col.muted, fontSize: 13, fontWeight: 'normal' } },
    });
  }

  on(event: string, handler: (p: any) => void): void {
    this.chart?.off(event);
    this.chart?.on(event, handler);
  }

  resizeIfVisible(): void {
    try {
      if (this.chart && (this.el as HTMLElement).offsetParent !== null) this.chart.resize();
    } catch { /* disposed */ }
  }

  dispose(): void {
    this.ro?.disconnect(); this.ro = null;
    this.chart?.dispose(); this.chart = null;
  }
}
