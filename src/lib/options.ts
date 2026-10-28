import { normalCdf, normalPdf } from "./stats";

export type OptionKind = "call" | "put";

export type GkInputs = {
  spot: number;
  strike: number;
  /** Years. */
  maturity: number;
  /** Decimal volatility. */
  vol: number;
  /** Domestic (INR) continuous rate. */
  rd: number;
  /** Foreign rate, or dividend yield for an equity index. */
  rf: number;
  kind: OptionKind;
};

export type GkResult = {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rhoDomestic: number;
  rhoForeign: number;
  d1: number;
  d2: number;
};

/**
 * Garman–Kohlhagen. Black–Scholes–Merton with a continuous dividend yield
 * is the same function: pass the yield as `rf` and the funding rate as `rd`.
 */
export function garmanKohlhagen(input: GkInputs): GkResult {
  const { spot, strike, maturity, vol, rd, rf, kind } = input;
  const T = Math.max(maturity, 1 / 365);
  const sig = Math.max(vol, 1e-4);
  const sqrtT = Math.sqrt(T);
  const df = Math.exp(-rf * T);
  const dd = Math.exp(-rd * T);
  const d1 = (Math.log(spot / strike) + (rd - rf + 0.5 * sig * sig) * T) / (sig * sqrtT);
  const d2 = d1 - sig * sqrtT;
  const nd1 = normalPdf(d1);
  const call = spot * df * normalCdf(d1) - strike * dd * normalCdf(d2);
  const put = strike * dd * normalCdf(-d2) - spot * df * normalCdf(-d1);
  const price = kind === "call" ? call : put;
  const gamma = (df * nd1) / (spot * sig * sqrtT);
  const vega = spot * df * nd1 * sqrtT;
  const thetaCore = (-spot * df * nd1 * sig) / (2 * sqrtT);
  let delta: number;
  let theta: number;
  let rhoDomestic: number;
  let rhoForeign: number;
  if (kind === "call") {
    delta = df * normalCdf(d1);
    theta = thetaCore + rf * spot * df * normalCdf(d1) - rd * strike * dd * normalCdf(d2);
    rhoDomestic = strike * T * dd * normalCdf(d2);
    rhoForeign = -T * spot * df * normalCdf(d1);
  } else {
    delta = df * (normalCdf(d1) - 1);
    theta = thetaCore - rf * spot * df * normalCdf(-d1) + rd * strike * dd * normalCdf(-d2);
    rhoDomestic = -strike * T * dd * normalCdf(-d2);
    rhoForeign = T * spot * df * normalCdf(-d1);
  }
  return { price, delta, gamma, vega, theta, rhoDomestic, rhoForeign, d1, d2 };
}

export function parityGap(input: Omit<GkInputs, "kind">): number {
  const call = garmanKohlhagen({ ...input, kind: "call" }).price;
  const put = garmanKohlhagen({ ...input, kind: "put" }).price;
  const T = Math.max(input.maturity, 1 / 365);
  const forwardDiff = input.spot * Math.exp(-input.rf * T) - input.strike * Math.exp(-input.rd * T);
  return call - put - forwardDiff;
}

/**
 * Newton–Raphson on vega, from a 20% start, clamped to [0.1%, 300%]. Returns
 * null when the quote is below the no-arbitrage floor (so no vol reproduces it)
 * or the iteration has not converged — never an unconverged guess.
 */
export function impliedVol(target: number, input: Omit<GkInputs, "vol">): number | null {
  if (!(target > 0)) return null;
  const tolerance = 1e-6 * Math.max(1, input.spot);
  let sig = 0.2;
  for (let i = 0; i < 60; i++) {
    const model = garmanKohlhagen({ ...input, vol: sig });
    const diff = model.price - target;
    if (Math.abs(diff) < tolerance) return sig;
    if (model.vega < 1e-8) return null;
    sig = Math.max(1e-3, Math.min(3, sig - diff / model.vega));
  }
  const final = garmanKohlhagen({ ...input, vol: sig });
  return Math.abs(final.price - target) < tolerance ? sig : null;
}

export type SmilePoint = { strike: number; vol: number; price: number; moneyness: number };

/** Parametric smile around the forward. Equity skew is steeper than USDINR. */
export function smile(
  input: Omit<GkInputs, "strike" | "vol"> & { atmVol: number; skew: number; convex: number },
  n = 17,
): SmilePoint[] {
  const T = Math.max(input.maturity, 1 / 365);
  const forward = input.spot * Math.exp((input.rd - input.rf) * T);
  const lo = input.spot * 0.86;
  const hi = input.spot * 1.16;
  const pts: SmilePoint[] = [];
  for (let i = 0; i < n; i++) {
    const strike = lo + ((hi - lo) * i) / (n - 1);
    const m = Math.log(strike / forward);
    const vol = Math.max(0.01, input.atmVol * (1 + input.skew * m + input.convex * m * m));
    const price = garmanKohlhagen({ ...input, strike, vol, kind: input.kind }).price;
    pts.push({ strike, vol, price, moneyness: strike / input.spot });
  }
  return pts;
}

export type TreeResult = {
  european: number;
  american: number;
  steps: number;
};

/** Cox–Ross–Rubinstein. Early exercise compares continuation with spot payoff. */
export function binomial(input: GkInputs, steps: number): TreeResult {
  const n = Math.max(2, Math.round(steps));
  const T = Math.max(input.maturity, 1 / 365);
  const sig = Math.max(input.vol, 1e-4);
  const dt = T / n;
  const u = Math.exp(sig * Math.sqrt(dt));
  const d = 1 / u;
  const growth = Math.exp((input.rd - input.rf) * dt);
  let p = (growth - d) / (u - d);
  p = Math.min(0.999, Math.max(0.001, p));
  const disc = Math.exp(-input.rd * dt);
  const payoff = (s: number) =>
    input.kind === "call" ? Math.max(s - input.strike, 0) : Math.max(input.strike - s, 0);

  let euro = Array<number>(n + 1);
  let amer = Array<number>(n + 1);
  for (let i = 0; i <= n; i++) {
    const s = input.spot * u ** i * d ** (n - i);
    const v = payoff(s);
    euro[i] = v;
    amer[i] = v;
  }
  for (let step = n - 1; step >= 0; step--) {
    const nextE = Array<number>(step + 1);
    const nextA = Array<number>(step + 1);
    for (let i = 0; i <= step; i++) {
      const s = input.spot * u ** i * d ** (step - i);
      const contE = disc * (p * euro[i + 1]! + (1 - p) * euro[i]!);
      const contA = disc * (p * amer[i + 1]! + (1 - p) * amer[i]!);
      nextE[i] = contE;
      nextA[i] = Math.max(contA, payoff(s));
    }
    euro = nextE;
    amer = nextA;
  }
  return { european: euro[0]!, american: amer[0]!, steps: n };
}

export function convergence(
  input: GkInputs,
): { steps: number; european: number; american: number }[] {
  return [10, 20, 40, 80, 120].map((steps) => binomial(input, steps));
}

export type SpotPoint = { spot: number; value: number; intrinsic: number };

export function valueBySpot(input: GkInputs, n = 41): SpotPoint[] {
  const lo = input.spot * 0.82;
  const hi = input.spot * 1.2;
  const pts: SpotPoint[] = [];
  for (let i = 0; i < n; i++) {
    const spot = lo + ((hi - lo) * i) / (n - 1);
    const value = garmanKohlhagen({ ...input, spot }).price;
    const intrinsic =
      input.kind === "call" ? Math.max(spot - input.strike, 0) : Math.max(input.strike - spot, 0);
    pts.push({ spot, value, intrinsic });
  }
  return pts;
}

export const FX_BASE: GkInputs = {
  spot: 83.8,
  strike: 85,
  maturity: 0.5,
  vol: 0.055,
  rd: 0.065,
  rf: 0.045,
  kind: "call",
};

export const NIFTY_BASE: GkInputs = {
  spot: 24600,
  strike: 25000,
  maturity: 0.25,
  vol: 0.14,
  rd: 0.065,
  rf: 0.012,
  kind: "put",
};

/** Notional of the dollar invoice used as the worked example. */
export const RESIN_NOTIONAL_USD = 2_400_000;
