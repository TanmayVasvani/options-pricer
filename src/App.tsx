import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Field,
  Method,
  Metric,
  Panel,
  Reading,
  Reset,
  Segment,
  StudyHeader,
} from "./components/bits";
import { ChartBox, Tip, axisLine, tick } from "./components/chart-box";
import { Shell } from "./components/shell";
import { num, pct, rupees } from "./lib/format";
import {
  FX_BASE,
  NIFTY_BASE,
  RESIN_NOTIONAL_USD,
  binomial,
  convergence,
  garmanKohlhagen,
  impliedVol,
  parityGap,
  smile,
  valueBySpot,
  type GkInputs,
  type OptionKind,
} from "./lib/options";

type Book = "fx" | "nifty";

export function App() {
  const [book, setBook] = useState<Book>("fx");
  const [input, setInput] = useState<GkInputs>(FX_BASE);
  const [quoteScale, setQuoteScale] = useState(1);

  const model = useMemo(() => garmanKohlhagen(input), [input]);
  const quote = model.price * quoteScale;
  const iv = useMemo(() => impliedVol(quote, { ...input, kind: input.kind }), [quote, input]);
  const gap = useMemo(() => parityGap(input), [input]);
  const tree = useMemo(() => binomial(input, 120), [input]);
  const path = useMemo(() => valueBySpot(input), [input]);
  const conv = useMemo(() => convergence(input), [input]);
  const wing = useMemo(
    () =>
      smile({
        ...input,
        atmVol: input.vol,
        skew: book === "fx" ? 0.45 : -0.85,
        convex: book === "fx" ? 0.35 : 0.7,
      }),
    [input, book],
  );

  const intrinsic =
    input.kind === "call"
      ? Math.max(input.spot - input.strike, 0)
      : Math.max(input.strike - input.spot, 0);
  const early = tree.american - tree.european;
  const invoiceInr = RESIN_NOTIONAL_USD * input.spot;
  const premiumInr = model.price * RESIN_NOTIONAL_USD;

  const set = <K extends keyof GkInputs>(key: K, value: GkInputs[K]) => {
    setInput((prev) => ({ ...prev, [key]: value }));
  };

  const switchBook = (next: Book) => {
    setBook(next);
    setInput(next === "fx" ? FX_BASE : NIFTY_BASE);
    setQuoteScale(1);
  };

  const bounds =
    book === "fx"
      ? {
          spot: [75, 96] as const,
          strike: [75, 96] as const,
          vol: [0.02, 0.16] as const,
          rf: [0, 0.08] as const,
          step: 0.1,
        }
      : {
          spot: [18000, 32000] as const,
          strike: [18000, 32000] as const,
          vol: [0.08, 0.4] as const,
          rf: [0, 0.04] as const,
          step: 50,
        };

  return (
    <Shell project="Options pricer">
      <StudyHeader
        kicker="Derivatives"
        title="Options pricer"
        lede="A Garman–Kohlhagen pricer. The base contract is a six-month dollar call on a materials invoice. Switch the book to a Nifty put, where a dividend yield stands in for the foreign rate. Greeks, a parametric smile, and a binomial tree sit next to the closed form. Put-call parity is an identity check."
      />

      <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label={book === "fx" ? "Premium, per dollar" : "Premium, per index unit"}
          value={book === "fx" ? rupees(model.price) : model.price.toFixed(1)}
          hint={
            book === "fx"
              ? `On $${(RESIN_NOTIONAL_USD / 1e6).toFixed(1)} m, the cover costs ₹${(premiumInr / 1e5).toFixed(1)} lakh.`
              : "Black–Scholes–Merton with a continuous dividend yield."
          }
          tone="teal"
        />
        <Metric
          label="Delta"
          value={num(model.delta)}
          hint={`Gamma ${num(model.gamma, 4)} · vega ${book === "fx" ? rupees(model.vega / 100, 2) : (model.vega / 100).toFixed(1)} per vol point.`}
        />
        <Metric
          label="Implied vol of the quote"
          value={iv == null ? "—" : pct(iv)}
          hint={
            iv == null
              ? "No volatility reproduces this quote: it sits below the no-arbitrage floor."
              : quoteScale === 1
                ? "Quote equals the model, so implied vol matches the input."
                : `Quote is ${pct(quoteScale - 1, 0)} versus the model premium.`
          }
        />
        <Metric
          label="Early exercise"
          value={
            early > model.price * 0.005
              ? book === "fx"
                ? rupees(early, 3)
                : early.toFixed(1)
              : "None"
          }
          hint={
            early > model.price * 0.005
              ? "American minus European, 120-step tree."
              : "American and European agree at this point."
          }
          tone={early > model.price * 0.005 ? "rust" : "ink"}
        />
      </div>

      <div className="mt-8">
        <Reading title={book === "fx" ? "Dollar call" : "Index put"}>
          {book === "fx" ? (
            <>
              The order is ${RESIN_NOTIONAL_USD.toLocaleString("en-US")} of resin, about ₹
              {(invoiceInr / 1e7).toFixed(2)} crore at the spot on screen. A {input.kind} struck at{" "}
              {input.strike.toFixed(2)} costs {rupees(model.price)} per dollar, or ₹
              {(premiumInr / 1e5).toFixed(1)} lakh for the whole order —{" "}
              {pct(premiumInr / invoiceInr)} of the invoice. Delta of {num(model.delta)} means a
              one-rupee rise in USDINR marks the cover by about ₹
              {((model.delta * RESIN_NOTIONAL_USD) / 1e5).toFixed(1)} lakh. Theta is{" "}
              {rupees(model.theta / 365, 4)} per dollar per day. Put-call parity residual is{" "}
              {Math.abs(gap) < 1e-6 ? "zero" : gap.toExponential(1)}. The 120-step European tree is{" "}
              {rupees(Math.abs(tree.european - model.price), 3)} off the closed form.
            </>
          ) : (
            <>
              A {input.maturity < 0.5 ? "short-dated" : "longer"} {input.kind} on the index, spot{" "}
              {input.spot.toFixed(0)}, strike {input.strike.toFixed(0)}, dividend yield{" "}
              {pct(input.rf)}. Model premium {model.price.toFixed(1)} per unit. European tree at 120
              steps is {Math.abs(tree.european - model.price).toFixed(1)} away from the closed form.
              American value is {tree.american.toFixed(1)}
              {early > 1
                ? `, so early exercise is worth about ${early.toFixed(1)} per unit on this put.`
                : ". Early exercise adds nothing here."}{" "}
              Price minus raw intrinsic is {(model.price - intrinsic).toFixed(1)}. Parity residual{" "}
              {Math.abs(gap) < 1e-2 ? "is a rounding error" : `is ${gap.toFixed(2)}`}.
            </>
          )}
        </Reading>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-2xl">Contract</h2>
            <Reset
              onClick={() => {
                setInput(book === "fx" ? FX_BASE : NIFTY_BASE);
                setQuoteScale(1);
              }}
            />
          </div>
          <Segment
            label="Underlying"
            value={book}
            options={[
              { value: "fx", label: "USD call" },
              { value: "nifty", label: "Nifty put book" },
            ]}
            onChange={switchBook}
          />
          <Segment
            label="Right"
            value={input.kind}
            options={[
              { value: "call", label: "Call" },
              { value: "put", label: "Put" },
            ]}
            onChange={(kind: OptionKind) => set("kind", kind)}
          />
          <Field
            label={book === "fx" ? "Spot USDINR" : "Index spot"}
            value={input.spot}
            min={bounds.spot[0]}
            max={bounds.spot[1]}
            step={bounds.step}
            display={book === "fx" ? input.spot.toFixed(2) : input.spot.toFixed(0)}
            onChange={(value) => set("spot", value)}
          />
          <Field
            label="Strike"
            value={input.strike}
            min={bounds.strike[0]}
            max={bounds.strike[1]}
            step={bounds.step}
            display={book === "fx" ? input.strike.toFixed(2) : input.strike.toFixed(0)}
            onChange={(value) => set("strike", value)}
          />
          <Field
            label="Maturity"
            value={input.maturity}
            min={0.05}
            max={1.5}
            step={0.01}
            display={`${(input.maturity * 12).toFixed(1)} mo`}
            onChange={(value) => set("maturity", value)}
          />
          <Field
            label="Volatility"
            value={input.vol}
            min={bounds.vol[0]}
            max={bounds.vol[1]}
            step={0.005}
            display={pct(input.vol)}
            onChange={(value) => set("vol", value)}
          />
          <Field
            label="Domestic rate"
            value={input.rd}
            min={0.02}
            max={0.1}
            step={0.005}
            display={pct(input.rd)}
            onChange={(value) => set("rd", value)}
          />
          <Field
            label={book === "fx" ? "Dollar rate" : "Dividend yield"}
            value={input.rf}
            min={bounds.rf[0]}
            max={bounds.rf[1]}
            step={0.002}
            display={pct(input.rf)}
            onChange={(value) => set("rf", value)}
          />
          <Field
            label="Quoted premium vs model"
            value={quoteScale}
            min={0.6}
            max={1.5}
            step={0.01}
            display={pct(quoteScale - 1, 0)}
            onChange={setQuoteScale}
          />
        </div>
        <div className="lg:col-span-8">
          <Panel title="Value as the spot moves">
            <ChartBox>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={path} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--color-line)" vertical={false} />
                  <XAxis
                    dataKey="spot"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tick={tick}
                    axisLine={axisLine}
                    tickLine={false}
                    tickFormatter={(value: number) =>
                      book === "fx" ? value.toFixed(0) : `${(value / 1000).toFixed(0)}k`
                    }
                  />
                  <YAxis tick={tick} axisLine={false} tickLine={false} width={40} />
                  <Tooltip
                    content={(props) => (
                      <Tip
                        active={props.active}
                        label={
                          typeof props.label === "number"
                            ? `Spot ${props.label.toFixed(book === "fx" ? 1 : 0)}`
                            : props.label
                        }
                        payload={props.payload?.map((row) => ({
                          name: String(row.name ?? ""),
                          value: Number(row.value),
                        }))}
                        format={(value) => (book === "fx" ? rupees(value) : value.toFixed(0))}
                      />
                    )}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    name="Model value"
                    stroke="var(--color-teal)"
                    dot={false}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="intrinsic"
                    name="Intrinsic"
                    stroke="var(--color-ink)"
                    dot={false}
                    strokeWidth={1.5}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartBox>
            <p className="mt-2 text-sm text-muted">
              Strike, vol, rates and maturity stay put. Intrinsic is the exercise value with no
              discount. A European contract can sit below it.
            </p>
          </Panel>
          <div className="mt-10 grid gap-10 md:grid-cols-2">
            <Panel title="Smile used to reprice the strikes">
              <ChartBox className="h-64 w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={wing} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--color-line)" vertical={false} />
                    <XAxis
                      dataKey="strike"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tick={tick}
                      axisLine={axisLine}
                      tickLine={false}
                      tickFormatter={(value: number) =>
                        book === "fx" ? value.toFixed(0) : `${(value / 1000).toFixed(0)}k`
                      }
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tick={tick}
                      axisLine={false}
                      tickLine={false}
                      width={44}
                      tickFormatter={(value: number) => `${(value * 100).toFixed(1)}%`}
                    />
                    <Tooltip
                      content={(props) => (
                        <Tip
                          active={props.active}
                          label={
                            typeof props.label === "number"
                              ? `K ${props.label.toFixed(book === "fx" ? 1 : 0)}`
                              : props.label
                          }
                          payload={props.payload?.map((row) => ({
                            name: String(row.name ?? ""),
                            value: Number(row.value),
                          }))}
                          format={(value, name) =>
                            name === "Vol"
                              ? pct(value)
                              : book === "fx"
                                ? rupees(value)
                                : value.toFixed(0)
                          }
                        />
                      )}
                    />
                    <Line
                      type="monotone"
                      dataKey="vol"
                      name="Vol"
                      stroke="var(--color-teal)"
                      dot={false}
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartBox>
              <p className="mt-2 text-sm text-muted">
                {book === "fx"
                  ? "USDINR is given a mild upside skew: higher strikes, a more expensive dollar, carry more vol."
                  : "The index is given the usual equity skew: low strikes carry more vol than high ones."}{" "}
                It is a parametric smile around the input volatility, not a fitted surface.
              </p>
            </Panel>
            <Panel title="Tree against the closed form">
              <ChartBox className="h-64 w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={conv} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--color-line)" vertical={false} />
                    <XAxis dataKey="steps" tick={tick} axisLine={axisLine} tickLine={false} />
                    <YAxis
                      tick={tick}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip
                      content={(props) => (
                        <Tip
                          active={props.active}
                          label={
                            typeof props.label === "number" ? `${props.label} steps` : props.label
                          }
                          payload={props.payload?.map((row) => ({
                            name: String(row.name ?? ""),
                            value: Number(row.value),
                          }))}
                          format={(value) => (book === "fx" ? rupees(value) : value.toFixed(1))}
                        />
                      )}
                    />
                    <Line
                      type="monotone"
                      dataKey="european"
                      name="European"
                      stroke="var(--color-ink)"
                      dot={false}
                      strokeWidth={1.5}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="american"
                      name="American"
                      stroke="var(--color-teal)"
                      dot={false}
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartBox>
              <p className="mt-2 text-sm text-muted">
                Cox–Ross–Rubinstein. Closed form is{" "}
                {book === "fx" ? rupees(model.price) : model.price.toFixed(1)}. European should
                approach it. American peels away only when exercise before expiry pays.
              </p>
            </Panel>
          </div>
        </div>
      </div>

      <div className="mt-12">
        <Panel title="Greeks and the two trees">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs tracking-widest text-muted uppercase">
                <tr>
                  {["Quantity", "Value", "Reading"].map((heading) => (
                    <th key={heading} className="py-2 pr-3 font-medium">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <Greek
                  name="Delta"
                  value={num(model.delta, 3)}
                  reading="Change in premium for a one-unit move in the spot."
                />
                <Greek
                  name="Gamma"
                  value={num(model.gamma, 4)}
                  reading="Change in delta for a one-unit move in the spot."
                />
                <Greek
                  name="Vega, per vol point"
                  value={
                    book === "fx" ? rupees(model.vega / 100, 3) : (model.vega / 100).toFixed(2)
                  }
                  reading="Premium change for a 1 percentage-point rise in vol."
                />
                <Greek
                  name="Theta, per day"
                  value={
                    book === "fx" ? rupees(model.theta / 365, 4) : (model.theta / 365).toFixed(2)
                  }
                  reading="Calendar decay, holding spot and vol fixed."
                />
                <Greek
                  name="Rho, domestic"
                  value={
                    book === "fx"
                      ? rupees(model.rhoDomestic / 100, 3)
                      : (model.rhoDomestic / 100).toFixed(2)
                  }
                  reading="Premium change for a 1 point rise in the INR rate."
                />
                <Greek
                  name={book === "fx" ? "Rho, foreign" : "Rho, dividend"}
                  value={
                    book === "fx"
                      ? rupees(model.rhoForeign / 100, 3)
                      : (model.rhoForeign / 100).toFixed(2)
                  }
                  reading={
                    book === "fx"
                      ? "Premium change for a 1 point rise in the dollar rate."
                      : "Premium change for a 1 point rise in the dividend yield."
                  }
                />
                <Greek
                  name="European tree, 120"
                  value={book === "fx" ? rupees(tree.european) : tree.european.toFixed(1)}
                  reading={`Gap to closed form: ${book === "fx" ? rupees(tree.european - model.price, 3) : (tree.european - model.price).toFixed(2)}.`}
                />
                <Greek
                  name="American tree, 120"
                  value={book === "fx" ? rupees(tree.american) : tree.american.toFixed(1)}
                  reading="Early exercise is checked at every node against the spot payoff."
                />
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="mt-8">
        <Method title="Method">
          <p>
            d1 is the log moneyness of the prepaid forward, plus half the variance, scaled by vol
            times root time. The call is the spot, discounted at the foreign rate or dividend yield,
            times N(d1), minus the strike, discounted at the domestic rate, times N(d2). The put
            follows by symmetry. Vega, gamma and theta use the normal density. Rho is split into the
            domestic rate and the foreign rate, because a currency option has two of them.
          </p>
          <p>
            Implied vol is Newton on that price, using vega, starting at 20% and clamped to a
            sensible range. The smile is atm vol times one plus a skew times log-moneyness plus a
            convexity times moneyness squared. It is illustrative. The tree is Cox–Ross–Rubinstein
            with the risk-neutral probability built from the same two rates. American value is the
            maximum of continuation and exercise. Put-call parity for these rates is call minus put
            equals the prepaid forward minus the discounted strike. The residual on screen should be
            numerical dust.
          </p>
          <p>
            The notional is {RESIN_NOTIONAL_USD.toLocaleString("en-US")} dollars, one imported
            invoice. Premium is quoted per dollar and for the whole notional. The smile is
            parametric, not fitted to a market.
          </p>
        </Method>
      </div>
    </Shell>
  );
}

function Greek({ name, value, reading }: { name: string; value: string; reading: string }) {
  return (
    <tr className="border-t border-line">
      <td className="py-2 pr-3">{name}</td>
      <td className="py-2 pr-3 tabular-nums">{value}</td>
      <td className="py-2 pr-3 text-muted">{reading}</td>
    </tr>
  );
}
