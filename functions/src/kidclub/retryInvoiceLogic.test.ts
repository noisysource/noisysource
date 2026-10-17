import { describe, it, expect } from "vitest";
import { retryInvoiceRefusal } from "./retryInvoiceLogic";
// Test-only import from packages/shared (tests are excluded from the functions
// build). The KidClub app has no test runner; this pins the UI side too.
import { hasOpenInvoiceError } from "../../../packages/shared/models/billingInvoiceState";

// The prod bill that showed the hazard: invoiced, number recorded, stale error.
const OK6G = {
  status: "invoiced",
  invoiceNumber: "FR 01P2026/226",
  vendusId: 123456789,
  invoiceError: "A001 You are trying to generate too many documents simultaneously",
};

describe("retryInvoiceRefusal (retryVendusInvoice)", () => {
  it("refuses an invoiced bill with an invoice number AND a stale invoiceError, naming the invoice", () => {
    const d = retryInvoiceRefusal(OK6G);
    expect(d).toEqual({ code: "already-exists", message: "Invoice already created: FR 01P2026/226 (Vendus id 123456789)" });
  });

  it("refuses an invoiced bill with an invoice number and no error", () => {
    const d = retryInvoiceRefusal({ status: "invoiced", invoiceNumber: "FR 01P2026/226", vendusId: 123456789 });
    expect(d).toMatchObject({ code: "already-exists" });
    expect(d?.message).toContain("FR 01P2026/226");
  });

  it("refuses whatever the status once a number or a Vendus id is on the bill", () => {
    expect(retryInvoiceRefusal({ status: "paid", invoiceNumber: "FR 01P2026/9", invoiceError: "x" }))
      .toMatchObject({ code: "already-exists", message: "Invoice already created: FR 01P2026/9" });
    expect(retryInvoiceRefusal({ status: "paid", vendusId: 42, invoiceError: "x" }))
      .toMatchObject({ code: "already-exists", message: "Invoice already created: Vendus id 42" });
  });

  it("allows a paid bill with an invoiceError and no invoice recorded (the normal 'Fatura por emitir')", () => {
    expect(retryInvoiceRefusal({ status: "paid", invoiceError: "NIF inválido" })).toBeNull();
  });

  it("allows 'criada mas não registada': the number is only in the error text, not on the bill", () => {
    const bill = { status: "paid", invoiceError: "Fatura Vendus FR 01P2026/300 (id 9) criada mas não registada — confirmar no Vendus antes de repetir. (x)" };
    expect(retryInvoiceRefusal(bill)).toBeNull();
  });

  it("force overrides the invoice check (explicit admin override, unchanged)", () => {
    expect(retryInvoiceRefusal(OK6G, true)).toBeNull();
    expect(retryInvoiceRefusal({ status: "invoiced", invoiceNumber: "FR 01P2026/226" }, true)).toBeNull();
  });

  it("keeps the old refusal of an invoiced bill with no error, even with nothing recorded", () => {
    expect(retryInvoiceRefusal({ status: "invoiced" })).toMatchObject({ code: "already-exists" });
  });

  it("refuses statuses other than paid/invoiced, even with force", () => {
    for (const status of ["pending", "processing", "failed", "cancelled", "dry-run", undefined]) {
      expect(retryInvoiceRefusal({ status, invoiceError: "x" }, true)).toEqual({
        code: "failed-precondition", message: `Cannot create invoice for status=${status}`,
      });
    }
    expect(retryInvoiceRefusal(undefined)).toMatchObject({ code: "failed-precondition" });
  });
});

describe("hasOpenInvoiceError (admin UI) agrees with the backend", () => {
  it("only an error with no invoice recorded is open", () => {
    expect(hasOpenInvoiceError(OK6G)).toBe(false);
    expect(hasOpenInvoiceError({ invoiceError: "x", invoiceNumber: "FR 01P2026/1" })).toBe(false);
    expect(hasOpenInvoiceError({ invoiceError: "x", vendusId: 1 })).toBe(false);
    expect(hasOpenInvoiceError({ invoiceError: "x" })).toBe(true);
    expect(hasOpenInvoiceError({ invoiceError: "" })).toBe(false);
    expect(hasOpenInvoiceError({})).toBe(false);
    expect(hasOpenInvoiceError(null)).toBe(false);
  });

  it("the UI never offers a retry the backend would refuse, nor one for a bill that has its invoice", () => {
    for (const status of ["paid", "invoiced"]) {
      for (const invoiceError of [undefined, "x"]) {
        for (const invoiceNumber of [undefined, "FR 01P2026/1"]) {
          for (const vendusId of [undefined, 7]) {
            const bill = { status, invoiceError, invoiceNumber, vendusId };
            const backendRefusesExisting = retryInvoiceRefusal(bill)?.code === "already-exists";
            // Where the UI shows the retry, the backend must not refuse it.
            if (hasOpenInvoiceError(bill)) expect(retryInvoiceRefusal(bill), JSON.stringify(bill)).toBeNull();
            // Where an invoice is recorded, the UI must not show the retry and the backend must refuse.
            if (invoiceNumber || vendusId) {
              expect(hasOpenInvoiceError(bill), JSON.stringify(bill)).toBe(false);
              expect(backendRefusesExisting, JSON.stringify(bill)).toBe(true);
            }
          }
        }
      }
    }
  });
});
