import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        _url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse();
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import {
  _parseDataSlotBillingData,
  _parseDataSlotPaymentData,
  _parseNewSsrBillingData,
  _parseNewSsrPaymentData,
  _parseSsrBillingData,
  _parseSsrPaymentData,
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  queryOpenCodeZenQuota,
} from "../src/lib/opencode-zen.js";

function response(body: string, status = 200): Response {
  return new Response(body, { status });
}

function ssrHtml(balance: number, monthlyLimit?: number, monthlyUsage?: number): string {
  const fields = [
    `monthlyUsage:${monthlyUsage ?? ""}`,
    `balance:${balance}`,
    `monthlyLimit:${monthlyLimit ?? ""}`,
  ].join(",");
  return `<html><script>$R[42]={billing:{${fields}}}</script></html>`;
}

function dataSlotHtml(): string {
  return `<div data-slot="billing-item">
    <span data-slot="billing-label">Balance</span>
    <span data-slot="billing-value">$42.50</span>
  </div>
  <div data-slot="billing-item">
    <span data-slot="billing-label">Monthly Limit</span>
    <span data-slot="billing-value">$100.00</span>
  </div>
  <div data-slot="billing-item">
    <span data-slot="billing-label">Monthly Usage</span>
    <span data-slot="billing-value">$12.50</span>
  </div>`;
}

function newSsrBillingHtml(balance: number, monthlyLimit?: number, monthlyUsage?: number): string {
  const fields = [
    'customerID:"cus_1"',
    `balance:${balance}`,
    ...(monthlyLimit === undefined ? [] : [`monthlyLimit:${monthlyLimit}`]),
    ...(monthlyUsage === undefined ? [] : [`monthlyUsage:${monthlyUsage}`]),
    `timeMonthlyUsageUpdated:$R[26]=new Date("2026-08-11T07:05:05.000Z")`,
    "lite:$R[27]={useBalance:!0}",
  ].join(",");
  return (
    `<html><script>_$HY.r["billing.get[\\"wrk_X\\"]"]=$R[21]=$R[2]($R[22]={p:0,s:0,f:0});` +
    `$R[16]($R[22],$R[25]={${fields}});</script></html>`
  );
}

function newSsrPaymentHtml(
  amounts: Array<number | { amount: number; refunded?: boolean }>,
): string {
  const entries = amounts
    .map((entry, index) => {
      const amount = typeof entry === "number" ? entry : entry.amount;
      const refunded = typeof entry === "number" ? false : Boolean(entry.refunded);
      const timeRefunded = refunded ? `new Date("2026-08-01T00:00:00.000Z")` : "null";
      return `$R[${39 + index * 2}]={id:"pay_${index}",amount:${amount},timeRefunded:${timeRefunded}}`;
    })
    .join(",");
  return (
    `<html><script>_$HY.r["payment.list[\\"wrk_X\\"]"]=$R[34]=$R[2]($R[35]={p:0,s:0,f:0});` +
    `$R[16]($R[35],$R[38]=[${entries}]);</script></html>`
  );
}

describe("OpenCode Zen billing parser", () => {
  it("parses SolidJS fields independently of field order", () => {
    expect(_parseSsrBillingData(ssrHtml(425_000_000, 20, 12_500_000))).toEqual({
      balance: 425_000_000,
      monthlyLimit: 20,
      monthlyUsage: 12_500_000,
      lastPayment: null,
    });
  });

  it("accepts a zero balance and omits missing optional values", () => {
    expect(_parseSsrBillingData("$R[1]={billing:{balance:0}}")).toEqual({
      balance: 0,
      monthlyLimit: null,
      monthlyUsage: null,
      lastPayment: null,
    });
  });

  it.each([
    ["empty HTML", ""],
    ["missing balance", "$R[1]={billing:{monthlyLimit:20}}"],
    ["negative balance", "$R[1]={billing:{balance:-1}}"],
  ])("rejects %s", (_label, html) => {
    expect(_parseSsrBillingData(html)).toBeNull();
  });

  it("parses the data-slot fallback and preserves PR #140 units", () => {
    expect(_parseDataSlotBillingData(dataSlotHtml())).toEqual({
      balance: 42.5 * OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
      monthlyLimit: 100,
      monthlyUsage: 12.5 * OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
      lastPayment: null,
    });
  });

  it("parses the original SSR payment-list fallback", () => {
    expect(
      _parseSsrPaymentData('$R["payment.list"]=[{"amount":2100000000,"workspaceID":"wrk"}]'),
    ).toBe(21);
  });

  it("uses the first non-refunded positive data-slot payment", () => {
    const html = `<table data-slot="payments-table-element">
      <tr><td data-slot="payment-amount" data-refunded="true">$10.00</td></tr>
      <tr><td data-slot="payment-amount">$20.00</td></tr>
    </table>`;
    expect(_parseDataSlotPaymentData(html)).toBe(20);
  });

  it("clamps a negative new-SSR balance to zero and keeps dollars as-is", () => {
    expect(_parseNewSsrBillingData(newSsrBillingHtml(-14_496, 50, 17_321_332))).toEqual({
      balance: 0,
      monthlyLimit: 50,
      monthlyUsage: 17_321_332,
      lastPayment: null,
    });
  });

  it("keeps a positive new-SSR balance in billing units", () => {
    expect(_parseNewSsrBillingData(newSsrBillingHtml(425_000_000, 20, 12_500_000))).toEqual({
      balance: 425_000_000,
      monthlyLimit: 20,
      monthlyUsage: 12_500_000,
      lastPayment: null,
    });
  });

  it("returns the first positive payment in provider order", () => {
    expect(
      _parseNewSsrPaymentData(newSsrPaymentHtml([500_000_000, 2_000_000_000, 1_000_000_000])),
    ).toBe(5);
  });

  it("skips refunded payments in the new payment.list array", () => {
    expect(
      _parseNewSsrPaymentData(
        newSsrPaymentHtml([{ amount: 2_000_000_000, refunded: true }, { amount: 1_000_000_000 }]),
      ),
    ).toBe(10);
  });

  it("parses reordered payment fields and skips malformed or explicitly refunded entries", () => {
    const html =
      `<html><script>_$HY.r["payment.list[\\"wrk_X\\"]"]=$R[34]=$R[2]($R[35]={p:0,s:0,f:0});` +
      `$R[16]($R[35],$R[38]=[` +
      `$R[39]={timeRefunded:null,amount:"invalid"},` +
      `$R[41]={timeRefunded:new Date("2026-08-01T00:00:00.000Z"),id:"refunded",amount:2000000000},` +
      `$R[43]={refunded:true,note:"skip",amount:1500000000},` +
      `$R[45]={timeRefunded:null,note:"brace } and escaped \\" quote {",id:"valid",amount:1000000000},` +
      `$R[47]={amount:3000000000}` +
      `]);</script></html>`;

    expect(_parseNewSsrPaymentData(html)).toBe(10);
  });

  it("returns null when the new payment.list has no positive amount", () => {
    expect(_parseNewSsrPaymentData(newSsrPaymentHtml([0, 0]))).toBeNull();
  });

  it("returns null when the new SSR keys are absent", () => {
    expect(_parseNewSsrBillingData("<html><body>Nothing here</body></html>")).toBeNull();
    expect(_parseNewSsrPaymentData("<html><body>Nothing here</body></html>")).toBeNull();
  });

  it("parses a nested object literal inside the new billing object", () => {
    const html =
      `<html><script>_$HY.r["billing.get[\\"wrk_X\\"]"]=$R[21]=$R[2]($R[22]={p:0,s:0,f:0});` +
      `$R[16]($R[22],$R[25]={customerID:"cus_1",balance:425000000,` +
      `lite:$R[27]={useBalance:!0},monthlyLimit:20,monthlyUsage:12500000});</script></html>`;
    expect(_parseNewSsrBillingData(html)).toEqual({
      balance: 425_000_000,
      monthlyLimit: 20,
      monthlyUsage: 12_500_000,
      lastPayment: null,
    });
  });

  it("scopes billing fields and ignores escaped quotes or braces inside strings", () => {
    const html =
      `<script>const unrelated={balance:999,monthlyLimit:999};</script>` +
      `<script>_$HY.r["billing.get[\\"wrk_X\\"]"]=$R[21]=$R[2]($R[22]={p:0,s:0,f:0});` +
      `$R[16]($R[22],$R[25]={note:"brace } and escaped \\" quote {",` +
      `balance:425000000,monthlyLimit:20,monthlyUsage:12500000});</script>`;

    expect(_parseNewSsrBillingData(html)).toEqual({
      balance: 425_000_000,
      monthlyLimit: 20,
      monthlyUsage: 12_500_000,
      lastPayment: null,
    });
  });

  it("returns null for missing optional fields in the new billing object", () => {
    expect(_parseNewSsrBillingData(newSsrBillingHtml(425_000_000))).toEqual({
      balance: 425_000_000,
      monthlyLimit: null,
      monthlyUsage: null,
      lastPayment: null,
    });
  });

  it("returns null for unbalanced or unterminated new SSR assignments", () => {
    const unbalancedBilling =
      `<script>_$HY.r["billing.get[\\"wrk_X\\"]"]=$R[21]=$R[2]($R[22]={p:0,s:0,f:0});` +
      `$R[16]($R[22],$R[25]={note:"unterminated },balance:425000000});</script>`;
    const unbalancedPayments =
      `<script>_$HY.r["payment.list[\\"wrk_X\\"]"]=$R[34]=$R[2]($R[35]={p:0,s:0,f:0});` +
      `$R[16]($R[35],$R[38]=[$R[39]={amount:100000000,timeRefunded:null});</script>`;

    expect(_parseNewSsrBillingData(unbalancedBilling)).toBeNull();
    expect(_parseNewSsrPaymentData(unbalancedPayments)).toBeNull();
  });
});

describe("queryOpenCodeZenQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the exact fixed GET contract from PR #140", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(response("$R[1]={billing:{balance:50000000}}"));

    await queryOpenCodeZenQuota("wrk /unsafe", "cookie-secret", {
      requestTimeoutMs: 4_321,
    });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://opencode.ai/workspace/wrk%20%2Funsafe/billing",
      {
        request: {
          method: "GET",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
            Accept: "text/html",
            Cookie: "auth=cookie-secret",
          },
        },
        timeoutMs: 4_321,
        consume: expect.any(Function),
      },
    );
    const options = mocks.fetchWithTimeout.mock.calls[0]?.[1];
    expect(options?.request.body).toBeUndefined();
  });

  it("returns parsed SSR data and attaches the payment fallback", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(
      response(
        "$R[1]={billing:{balance:4250000000,monthlyLimit:100,monthlyUsage:575000000}}" +
          '$R["payment.list"]=[{"amount":2100000000}]',
      ),
    );

    await expect(queryOpenCodeZenQuota("wrk_abc", "cookie")).resolves.toEqual({
      success: true,
      data: {
        balance: 4_250_000_000,
        monthlyLimit: 100,
        monthlyUsage: 575_000_000,
        lastPayment: 21,
      },
    });
  });

  it("parses the new SolidJS SSR format end to end", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(
      response(
        newSsrBillingHtml(-14_496, 50, 17_321_332) +
          newSsrPaymentHtml([500_000_000, 2_000_000_000, 1_000_000_000]),
      ),
    );

    await expect(queryOpenCodeZenQuota("wrk_abc", "cookie")).resolves.toEqual({
      success: true,
      data: {
        balance: 0,
        monthlyLimit: 50,
        monthlyUsage: 17_321_332,
        lastPayment: 5,
      },
    });
  });

  it("falls back to data-slot billing HTML", async () => {
    mocks.fetchResponse.mockResolvedValueOnce(response(dataSlotHtml()));

    await expect(queryOpenCodeZenQuota("wrk_abc", "cookie")).resolves.toEqual({
      success: true,
      data: {
        balance: 4_250_000_000,
        monthlyLimit: 100,
        monthlyUsage: 1_250_000_000,
        lastPayment: null,
      },
    });
  });

  it.each([
    "",
    "<html><body>Nothing here</body></html>",
  ])("returns a stable parse error for malformed or empty HTML", async (html) => {
    mocks.fetchResponse.mockResolvedValueOnce(response(html));
    await expect(queryOpenCodeZenQuota("wrk_abc", "cookie")).resolves.toEqual({
      success: false,
      error: expect.stringContaining("Could not parse OpenCode Zen billing data"),
    });
  });

  it("does not expose an HTTP response body", async () => {
    const secretBody = "private-html-body-cookie-secret";
    mocks.fetchResponse.mockResolvedValueOnce(response(secretBody, 403));

    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-secret");

    expect(result).toEqual({
      success: false,
      error: "OpenCode Zen billing error 403",
    });
    expect(JSON.stringify(result)).not.toContain(secretBody);
    expect(JSON.stringify(result)).not.toContain("cookie-secret");
  });

  it("sanitizes network and timeout errors and redacts configured secrets", async () => {
    mocks.fetchResponse.mockRejectedValueOnce(
      new Error("\u001b[31mtimeout for wrk_secret with cookie-secret\nretry\u001b[0m"),
    );

    const result = await queryOpenCodeZenQuota("wrk_secret", "cookie-secret");

    expect(result).toEqual({
      success: false,
      error: "timeout for [redacted] with [redacted] retry",
    });
    expect(JSON.stringify(result)).not.toContain("wrk_secret");
    expect(JSON.stringify(result)).not.toContain("cookie-secret");
  });
});
