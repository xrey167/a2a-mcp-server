/**
 * Revenue Forecasting with Confidence Intervals
 *
 * Simple exponential smoothing + trend decomposition for
 * revenue time series. Generates point forecasts with
 * confidence bands.
 */

function log(msg: string) {
  process.stderr.write(`[revenue-forecast] ${msg}\n`);
}

export interface RevenueDataPoint {
  period: string;        // YYYY-MM
  revenue: number;
  orderCount: number;
}

export interface ForecastPoint {
  period: string;
  forecast: number;
  lowerBound: number;   // 80% CI
  upperBound: number;
  isActual: boolean;
}

export interface RevenueForecast {
  historicalPeriods: number;
  forecastPeriods: number;
  model: "exponential_smoothing" | "linear_trend";

  points: ForecastPoint[];

  // Summary
  totalForecastedRevenue: number;
  avgMonthlyForecast: number;
  growthRate: number;        // % month-over-month
  confidenceLevel: number;   // %

  // Risk indicators
  volatility: number;        // Coefficient of variation
  seasonalityDetected: boolean;
  trendDirection: "up" | "flat" | "down";
}

/**
 * Forecast revenue for future periods.
 *
 * @param history - Historical revenue data (at least 3 periods)
 * @param horizonMonths - Number of months to forecast
 * @param options - Smoothing parameters
 */
export function forecastRevenue(
  history: RevenueDataPoint[],
  horizonMonths: number,
  options?: { alpha?: number; confidenceLevel?: number },
): RevenueForecast {
  const alpha = options?.alpha ?? 0.3;
  const confidenceLevel = options?.confidenceLevel ?? 80;

  if (history.length < 2) {
    const avg = history.length > 0 ? history[0].revenue : 0;
    return emptyForecast(history, horizonMonths, avg);
  }

  // Sort by period
  const sorted = [...history].sort((a, b) => a.period.localeCompare(b.period));
  const values = sorted.map((d) => d.revenue);

  // Detect trend (simple linear regression)
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) * (i - xMean);
  }
  const slope = den > 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;

  // Exponential smoothing
  const smoothed: number[] = [values[0]];
  for (let i = 1; i < n; i++) {
    smoothed.push(alpha * values[i] + (1 - alpha) * smoothed[i - 1]);
  }

  // Calculate residuals for confidence interval
  const residuals = values.map((v, i) => v - smoothed[i]);
  const stdDev = Math.sqrt(
    residuals.reduce((s, r) => s + r * r, 0) / Math.max(1, n - 1),
  );

  // Z-score for confidence level
  const zScore = confidenceLevel === 80 ? 1.28
    : confidenceLevel === 90 ? 1.645
      : confidenceLevel === 95 ? 1.96
        : 1.28;

  // Build forecast points
  const points: ForecastPoint[] = [];

  // Historical points
  for (let i = 0; i < sorted.length; i++) {
    points.push({
      period: sorted[i].period,
      forecast: Math.round(smoothed[i] * 100) / 100,
      lowerBound: Math.round((smoothed[i] - zScore * stdDev) * 100) / 100,
      upperBound: Math.round((smoothed[i] + zScore * stdDev) * 100) / 100,
      isActual: true,
    });
  }

  // Future points
  const lastSmoothed = smoothed[smoothed.length - 1];
  const monthlyGrowth = slope;
  let totalForecasted = 0;

  for (let i = 1; i <= horizonMonths; i++) {
    const forecast = lastSmoothed + monthlyGrowth * i;
    // Uncertainty grows with horizon
    const expandedStdDev = stdDev * Math.sqrt(1 + i * 0.2);

    const period = addMonths(sorted[sorted.length - 1].period, i);
    const forecastValue = Math.max(0, Math.round(forecast * 100) / 100);
    totalForecasted += forecastValue;

    points.push({
      period,
      forecast: forecastValue,
      lowerBound: Math.max(0, Math.round((forecast - zScore * expandedStdDev) * 100) / 100),
      upperBound: Math.round((forecast + zScore * expandedStdDev) * 100) / 100,
      isActual: false,
    });
  }

  // Volatility (coefficient of variation)
  const cv = yMean > 0 ? Math.round((stdDev / yMean) * 100) : 0;

  // Seasonality detection (simple: check if autocorrelation at lag 12 is significant)
  const seasonality = n >= 12 ? detectSeasonality(values) : false;

  // Growth rate (month-over-month from trend)
  const growthRate = yMean > 0 ? Math.round((slope / yMean) * 100 * 10) / 10 : 0;

  const trendDirection: RevenueForecast["trendDirection"] =
    growthRate > 1 ? "up" : growthRate < -1 ? "down" : "flat";

  log(`forecast: ${horizonMonths} months, growth=${growthRate}%, volatility=${cv}%, trend=${trendDirection}`);

  return {
    historicalPeriods: n,
    forecastPeriods: horizonMonths,
    model: "exponential_smoothing",
    points,
    totalForecastedRevenue: Math.round(totalForecasted * 100) / 100,
    avgMonthlyForecast: horizonMonths > 0 ? Math.round(totalForecasted / horizonMonths * 100) / 100 : 0,
    growthRate,
    confidenceLevel,
    volatility: cv,
    seasonalityDetected: seasonality,
    trendDirection,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function addMonths(period: string, months: number): string {
  const [y, m] = period.split("-").map(Number);
  const date = new Date(y, m - 1 + months, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function detectSeasonality(values: number[]): boolean {
  if (values.length < 24) return false;
  // Simple autocorrelation at lag 12
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    den += (values[i] - mean) * (values[i] - mean);
    if (i >= 12) {
      num += (values[i] - mean) * (values[i - 12] - mean);
    }
  }
  const acf12 = den > 0 ? num / den : 0;
  return acf12 > 0.3;
}

function emptyForecast(history: RevenueDataPoint[], horizonMonths: number, avg: number): RevenueForecast {
  const points: ForecastPoint[] = history.map((h) => ({
    period: h.period, forecast: h.revenue, lowerBound: h.revenue, upperBound: h.revenue, isActual: true,
  }));
  for (let i = 1; i <= horizonMonths; i++) {
    const period = history.length > 0 ? addMonths(history[history.length - 1].period, i) : `2026-${String(i).padStart(2, "0")}`;
    points.push({ period, forecast: avg, lowerBound: 0, upperBound: avg * 2, isActual: false });
  }
  return {
    historicalPeriods: history.length,
    forecastPeriods: horizonMonths,
    model: "exponential_smoothing",
    points,
    totalForecastedRevenue: avg * horizonMonths,
    avgMonthlyForecast: avg,
    growthRate: 0,
    confidenceLevel: 80,
    volatility: 0,
    seasonalityDetected: false,
    trendDirection: "flat",
  };
}
