import test from "node:test";
import assert from "node:assert/strict";
import { treatmentsEquivalent } from "./treatments.js";

const at = "2026-11-02T20:00:00.000Z";

test("Temp Basal read-back matches when rate survives but duration is normalized", () => {
  assert.equal(treatmentsEquivalent(
    { eventType: "Temp Basal", created_at: at, absolute: 0.85, duration: 30, temp: "absolute" },
    { eventType: "Temp Basal", created_at: at, absolute: 0.85, duration: 29, temp: "absolute" }
  ), true);
});

test("Temp Basal read-back matches when duration survives but rate is normalized", () => {
  assert.equal(treatmentsEquivalent(
    { eventType: "Temp Basal", created_at: at, absolute: 0.85, duration: 30, temp: "absolute" },
    { eventType: "Temp Basal", created_at: at, absolute: 0.80, duration: 30, temp: "absolute" }
  ), true);
});

test("Temp Basal does not match when neither rate nor duration agrees", () => {
  assert.equal(treatmentsEquivalent(
    { eventType: "Temp Basal", created_at: at, absolute: 0.85, duration: 30, temp: "absolute" },
    { eventType: "Temp Basal", created_at: at, absolute: 0.80, duration: 25, temp: "absolute" }
  ), false);
});

test("Temp Basal does not match a different timestamp or mode", () => {
  assert.equal(treatmentsEquivalent(
    { eventType: "Temp Basal", created_at: at, absolute: 0.85, duration: 30, temp: "absolute" },
    { eventType: "Temp Basal", created_at: "2026-11-02T20:01:00.000Z", absolute: 0.85, duration: 30, temp: "absolute" }
  ), false);
  assert.equal(treatmentsEquivalent(
    { eventType: "Temp Basal", created_at: at, absolute: 0.85, duration: 30, temp: "absolute" },
    { eventType: "Temp Basal", created_at: at, absolute: 0.85, duration: 30, temp: "percent" }
  ), false);
});

test("Bolus deduplication still requires matching insulin and carbs", () => {
  assert.equal(treatmentsEquivalent(
    { eventType: "Correction Bolus", created_at: at, insulin: 1.2, carbs: 20 },
    { eventType: "Correction Bolus", created_at: at, insulin: 1.2, carbs: 20 }
  ), true);
  assert.equal(treatmentsEquivalent(
    { eventType: "Correction Bolus", created_at: at, insulin: 1.2, carbs: 20 },
    { eventType: "Correction Bolus", created_at: at, insulin: 1.2, carbs: 15 }
  ), false);
});
