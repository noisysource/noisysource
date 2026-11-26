import { describe, it, expect } from "vitest";
import { buildAuthUrl, lisbonDay, shouldReadCar, summarize, DATA_MIN_INTERVAL_MS, REDIRECT_URIS } from "./teslaLogic";

describe("buildAuthUrl", () => {
  it("asks for offline access and the car scopes, with our redirect and state", () => {
    const u = new URL(buildAuthUrl(REDIRECT_URIS[0], "abc"));
    expect(u.origin + u.pathname).toBe("https://auth.tesla.com/oauth2/v3/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe("https://noisysource-prod-domotics.web.app/tesla/callback");
    expect(u.searchParams.get("state")).toBe("abc");
    expect(u.searchParams.get("scope")).toContain("offline_access");
    expect(u.searchParams.get("scope")).toContain("vehicle_location");
  });
});

describe("lisbonDay", () => {
  it("uses Lisbon's date, also on summer time", () => {
    expect(lisbonDay(Date.parse("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
    expect(lisbonDay(Date.parse("2026-12-31T23:30:00Z"))).toBe("2026-12-31");
  });
});

describe("shouldReadCar", () => {
  const now = 1_800_000_000_000;
  it("never asks an asleep or offline car (that would wake it)", () => {
    expect(shouldReadCar("asleep", undefined, now)).toBe(false);
    expect(shouldReadCar("offline", undefined, now)).toBe(false);
    expect(shouldReadCar(undefined, undefined, now)).toBe(false);
  });
  it("asks an online car at most every few minutes", () => {
    expect(shouldReadCar("online", undefined, now)).toBe(true);
    expect(shouldReadCar("online", now - 60_000, now)).toBe(false);
    expect(shouldReadCar("online", now - DATA_MIN_INTERVAL_MS, now)).toBe(true);
  });
});

describe("summarize", () => {
  it("lists a car without data", () => {
    const s = summarize({ id_s: "123", vin: "5YJX", display_name: "", state: "asleep" });
    expect(s).toMatchObject({ id: "123", vin: "5YJX", name: "Tesla", state: "asleep" });
    expect(s.soc).toBeUndefined();
  });
  it("converts miles to km and reads charging, lock and position", () => {
    const s = summarize(
      { id_s: "9", vin: "LRW3", display_name: "Branco", state: "online" },
      {
        charge_state: { battery_level: 68, battery_range: 192.6, charge_limit_soc: 80, charging_state: "Charging", charge_amps: 9, charge_current_request_max: 13, charger_power: 2, charge_energy_added: 6.83, time_to_full_charge: 1.5 },
        climate_state: { inside_temp: 17.04, outside_temp: 12, is_climate_on: false },
        drive_state: { latitude: 40.24, longitude: -8.42, shift_state: null, speed: null },
        vehicle_state: { locked: true, sentry_mode: false, odometer: 30000, car_version: "2026.44.1 abc" },
        vehicle_config: { car_type: "model3" },
      },
      1000,
    );
    expect(s).toMatchObject({
      name: "Branco", model: "Model 3", soc: 68, rangeKm: 310, chargingState: "Charging", chargeAmps: 9, chargeAmpsMax: 13,
      energyAddedKwh: 6.8, minutesToFull: 90, locked: true, insideC: 17, odometerKm: 48280, lat: 40.24, lon: -8.42,
      software: "2026.44.1", readAt: 1000,
    });
    expect(s.speedKmh).toBeUndefined();
  });
});
