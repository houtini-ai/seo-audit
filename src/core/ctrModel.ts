// Position → expected-CTR curve (desktop+mobile blended). Single source of truth shared by the
// audit engine (ctr-below-expected check, priority model) and the dashboard (quick-wins matrix),
// so "expected CTR" means exactly the same thing in findings and in the UI.
const CTR_CURVE: Record<number, number> = { 1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.06, 6: 0.05, 7: 0.04, 8: 0.032, 9: 0.028, 10: 0.025 };

export const expectedCtr = (pos: number): number => CTR_CURVE[Math.max(1, Math.min(10, Math.round(pos)))] ?? 0.02;
