import { describe, expect, it } from "vitest";
import {
  FX_BASE,
  NIFTY_BASE,
  binomial,
  convergence,
  garmanKohlhagen,
  impliedVol,
  parityGap,
  smile,
  valueBySpot,
  type GkInputs,
} from "./options";

function withoutVol({ spot, strike, maturity, rd, rf, kind }: GkInputs): Omit<GkInputs, "vol"> {
  return { spot, strike, maturity, rd, rf, kind };
}

/** Black–Scholes–Merton reference case: S = K = 100, T = 1, σ = 20%, r = 5%, q = 0. */
const TEXTBOOK: GkInputs = {
  spot: 100,
  strike: 100,
  maturity: 1,
  vol: 0.2,
  rd: 0.05,
  rf: 0,
  kind: "call",
};

describe("closed form", () => {
  it("reproduces the textbook Black–Scholes values", () => {
    expect(garmanKohlhagen(TEXTBOOK).price).toBeCloseTo(10.4506, 3);
    expect(garmanKohlhagen({ ...TEXTBOOK, kind: "put" }).price).toBeCloseTo(5.5735, 3);
  });

  it("prices the base contracts at sensible levels", () => {
    const fx = garmanKohlhagen(FX_BASE);
    expect(fx.price).toBeGreaterThan(0);
    expect(fx.price).toBeLessThan(FX_BASE.spot * 0.05);
    const nifty = garmanKohlhagen(NIFTY_BASE);
    expect(nifty.price).toBeGreaterThan(NIFTY_BASE.strike - NIFTY_BASE.spot);
  });

  it("satisfies put–call parity on both books", () => {
    expect(Math.abs(parityGap(FX_BASE))).toBeLessThan(1e-9);
    expect(Math.abs(parityGap(NIFTY_BASE))).toBeLessThan(1e-6);
    expect(Math.abs(parityGap(TEXTBOOK))).toBeLessThan(1e-9);
  });

  it("call delta is in (0, e^{-rT}) and put delta is call delta minus e^{-rT}", () => {
    const call = garmanKohlhagen(FX_BASE);
    const put = garmanKohlhagen({ ...FX_BASE, kind: "put" });
    const df = Math.exp(-FX_BASE.rf * FX_BASE.maturity);
    expect(call.delta).toBeGreaterThan(0);
    expect(call.delta).toBeLessThan(df);
    expect(put.delta).toBeCloseTo(call.delta - df, 12);
    expect(call.gamma).toBeCloseTo(put.gamma, 12);
    expect(call.vega).toBeCloseTo(put.vega, 12);
  });
});

describe("Greeks against finite differences", () => {
  const bump = <K extends keyof GkInputs>(key: K, h: number, base: GkInputs = FX_BASE) => {
    const up = garmanKohlhagen({ ...base, [key]: (base[key] as number) + h }).price;
    const down = garmanKohlhagen({ ...base, [key]: (base[key] as number) - h }).price;
    return (up - down) / (2 * h);
  };

  for (const [label, base] of [
    ["USDINR call", FX_BASE],
    ["Nifty put", NIFTY_BASE],
  ] as const) {
    it(`${label}: delta, gamma, vega, theta and the two rhos`, () => {
      const g = garmanKohlhagen(base);
      const hS = base.spot * 1e-4;
      expect(bump("spot", hS, base) / g.delta).toBeCloseTo(1, 7);
      const gammaFd =
        (garmanKohlhagen({ ...base, spot: base.spot + hS }).price -
          2 * g.price +
          garmanKohlhagen({ ...base, spot: base.spot - hS }).price) /
        (hS * hS);
      expect(gammaFd / g.gamma).toBeCloseTo(1, 5);
      expect(bump("vol", 1e-5, base) / g.vega).toBeCloseTo(1, 7);
      // Theta is the derivative with respect to calendar time, minus the derivative in T.
      expect(-bump("maturity", 1e-5, base) / g.theta).toBeCloseTo(1, 7);
      expect(bump("rd", 1e-5, base) / g.rhoDomestic).toBeCloseTo(1, 7);
      expect(bump("rf", 1e-5, base) / g.rhoForeign).toBeCloseTo(1, 7);
    });
  }
});

describe("implied volatility", () => {
  it("round-trips the model price", () => {
    const price = garmanKohlhagen(FX_BASE).price;
    expect(impliedVol(price, withoutVol(FX_BASE))).toBeCloseTo(FX_BASE.vol, 6);
    const nifty = garmanKohlhagen(NIFTY_BASE).price;
    expect(impliedVol(nifty, withoutVol(NIFTY_BASE))).toBeCloseTo(NIFTY_BASE.vol, 6);
  });

  it("returns null for a quote no volatility can reproduce", () => {
    const deepItm = withoutVol({ ...TEXTBOOK, strike: 50 });
    // Floor for this call is S − K·e^{−rT} ≈ 52.44; a quote of 40 is below it.
    expect(impliedVol(40, deepItm)).toBeNull();
    expect(impliedVol(0, deepItm)).toBeNull();
  });
});

describe("binomial tree", () => {
  it("converges to the closed form as steps grow", () => {
    const closed = garmanKohlhagen(TEXTBOOK).price;
    const coarse = Math.abs(binomial(TEXTBOOK, 10).european - closed);
    const fine = Math.abs(binomial(TEXTBOOK, 400).european - closed);
    expect(fine).toBeLessThan(coarse);
    expect(fine / closed).toBeLessThan(2e-3);
  });

  it("an American option is worth at least a European one, and at least intrinsic", () => {
    for (const base of [FX_BASE, NIFTY_BASE, TEXTBOOK, { ...TEXTBOOK, kind: "put" as const }]) {
      const t = binomial(base, 150);
      expect(t.american).toBeGreaterThanOrEqual(t.european - 1e-12);
      const intrinsic =
        base.kind === "call"
          ? Math.max(base.spot - base.strike, 0)
          : Math.max(base.strike - base.spot, 0);
      expect(t.american).toBeGreaterThanOrEqual(intrinsic - 1e-12);
    }
  });

  it("never exercises an American call early when the underlying pays nothing", () => {
    const t = binomial(TEXTBOOK, 200);
    expect(t.american).toBeCloseTo(t.european, 8);
  });

  it("finds early-exercise value on a deep in-the-money put", () => {
    const t = binomial({ ...TEXTBOOK, kind: "put", strike: 150 }, 200);
    expect(t.american).toBeGreaterThan(t.european + 0.5);
    expect(t.american).toBeGreaterThanOrEqual(50 - 1e-9);
    expect(t.american).toBeLessThan(52);
  });

  it("reports the step ladder used on the page", () => {
    expect(convergence(FX_BASE).map((c) => c.steps)).toEqual([10, 20, 40, 80, 120]);
  });
});

describe("smile and spot ladder", () => {
  it("prices each strike at its own vol and keeps the ATM vol at the forward", () => {
    const pts = smile({ ...FX_BASE, atmVol: FX_BASE.vol, skew: 0.45, convex: 0.35 }, 33);
    expect(pts).toHaveLength(33);
    const forward = FX_BASE.spot * Math.exp((FX_BASE.rd - FX_BASE.rf) * FX_BASE.maturity);
    const nearest = pts.reduce((a, b) =>
      Math.abs(b.strike - forward) < Math.abs(a.strike - forward) ? b : a,
    );
    expect(nearest.vol).toBeCloseTo(FX_BASE.vol, 2);
    for (const p of pts) {
      expect(p.vol).toBeGreaterThanOrEqual(0.01);
      expect(p.price).toBeCloseTo(
        garmanKohlhagen({ ...FX_BASE, strike: p.strike, vol: p.vol }).price,
        12,
      );
    }
  });

  it("a call's value rises with spot and never falls below its discounted intrinsic", () => {
    const ladder = valueBySpot(FX_BASE);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]?.value ?? 0).toBeGreaterThan(ladder[i - 1]?.value ?? 0);
    }
    const df = Math.exp(-FX_BASE.rf * FX_BASE.maturity);
    const dd = Math.exp(-FX_BASE.rd * FX_BASE.maturity);
    for (const p of ladder) {
      expect(p.value).toBeGreaterThanOrEqual(Math.max(p.spot * df - FX_BASE.strike * dd, 0) - 1e-9);
    }
  });
});
