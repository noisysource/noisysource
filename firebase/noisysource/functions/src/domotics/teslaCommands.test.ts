import { describe, it, expect } from "vitest";
import { AMPS_MAX, buildCommand, commandOutcome, counterField, reasonText } from "./teslaCommands";

describe("buildCommand", () => {
  it("maps the app's actions to Tesla's REST commands", () => {
    expect(buildCommand("lock")).toMatchObject({ path: "command/door_lock", charging: false, patch: { locked: true } });
    expect(buildCommand("climate_off").path).toBe("command/auto_conditioning_stop");
    expect(buildCommand("wake")).toMatchObject({ path: "wake_up", wake: true });
    expect(buildCommand("charge_start")).toMatchObject({ path: "command/charge_start", charging: true });
  });

  it("clamps every value", () => {
    expect(buildCommand("set_temp", 40).body).toEqual({ driver_temp: 28, passenger_temp: 28 });
    expect(buildCommand("set_temp", 21.3).body).toEqual({ driver_temp: 21.5, passenger_temp: 21.5 });
    expect(buildCommand("charge_limit", 20).body).toEqual({ percent: 50 });
    expect(buildCommand("charging_amps", 32).body).toEqual({ charging_amps: AMPS_MAX });
    expect(buildCommand("charging_amps", 2).body).toEqual({ charging_amps: 5 });
  });

  it("refuses anything else, and missing values", () => {
    expect(() => buildCommand("remote_start_drive")).toThrow("Comando desconhecido.");
    expect(() => buildCommand("charge_limit")).toThrow();
    expect(() => buildCommand("set_temp", "hot")).toThrow();
  });
});

describe("commandOutcome", () => {
  it("reads Tesla's result and says why it refused, in Portuguese", () => {
    expect(commandOutcome({ response: { result: true, reason: "" } })).toEqual({ ok: true });
    expect(commandOutcome({ response: { result: false, reason: "not_charging" } })).toEqual({ ok: false, message: "Não está a carregar." });
    expect(commandOutcome({ response: { result: false, reason: "is_charging" } })).toEqual({ ok: false, message: "Já está a carregar." });
    expect(commandOutcome({ response: null, error: "Tesla Vehicle Command Protocol required, please refer to the documentation here: ..." }))
      .toMatchObject({ ok: false, message: expect.stringContaining("comandos assinados") });
    expect(reasonText("something_new")).toBe("Tesla recusou: something_new");
  });

  it("names the per-car counters safely", () => {
    expect(counterField("LRW3E7FS4RC975173", "charging")).toBe("charging_LRW3E7FS4RC975173");
  });
});
