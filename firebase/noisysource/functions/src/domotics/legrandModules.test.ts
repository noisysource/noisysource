import { describe, it, expect } from "vitest";
import { agentModulesError } from "./legrandModules";

describe("agentModulesError (what Atlas may send to legrandSetState)", () => {
  it("accepts the app's shapes: light, dimmer, blind", () => {
    expect(agentModulesError([{ id: "aa:01", bridge: "gw:00", on: true }])).toBeNull();
    expect(agentModulesError([{ id: "aa:02", bridge: "gw:00", on: true, brightness: 40 }])).toBeNull();
    expect(agentModulesError([{ id: "aa:03", bridge: "gw:00", target_position: 0 }, { id: "aa:04", target_position: 100 }])).toBeNull();
  });
  it("wants 1 to 30 entries", () => {
    expect(agentModulesError(undefined)).toMatch(/1 to 30/);
    expect(agentModulesError("aa:01")).toMatch(/1 to 30/);
    expect(agentModulesError([])).toMatch(/1 to 30/);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, on: false }));
    expect(agentModulesError(many(30))).toBeNull();
    expect(agentModulesError(many(31))).toMatch(/1 to 30/);
  });
  it("wants each entry to be an object with a string id", () => {
    expect(agentModulesError([null])).toMatch(/modules\[0\] must be an object/);
    expect(agentModulesError([["aa:01"]])).toMatch(/must be an object/);
    expect(agentModulesError([{ on: true }])).toMatch(/id must be a string/);
    expect(agentModulesError([{ id: 7, on: true }])).toMatch(/id must be a string/);
    expect(agentModulesError([{ id: "", on: true }])).toMatch(/id must be a string/);
  });
  it("checks each field's type and range", () => {
    expect(agentModulesError([{ id: "a", bridge: 1 }])).toMatch(/bridge must be a string/);
    expect(agentModulesError([{ id: "a", on: "true" }])).toMatch(/on must be a boolean/);
    expect(agentModulesError([{ id: "a", on: 1 }])).toMatch(/on must be a boolean/);
    for (const bad of [-1, 101, 50.5, "50", null, NaN]) {
      expect(agentModulesError([{ id: "a", target_position: bad }])).toMatch(/target_position must be an integer/);
      expect(agentModulesError([{ id: "a", brightness: bad }])).toMatch(/brightness must be an integer/);
    }
  });
  it("refuses any other key, and says which entry", () => {
    expect(agentModulesError([{ id: "a", on: true }, { id: "b", on: true, type: "NLP" }])).toBe("modules[1].type is not allowed");
    expect(agentModulesError([{ id: "a", therm_setpoint_temperature: 30 }])).toMatch(/therm_setpoint_temperature is not allowed/);
  });
});
