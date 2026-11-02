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


import { normalizeTempBasal } from "./treatments.js";

test("absolute zero temp basal is preserved as an explicit 0 U/h rate", () => {
  assert.deepEqual(normalizeTempBasal({ temp: "absolute", absolute: 0, duration: 30 }), {
    temp: "absolute", absolute: 0, rate: 0, duration: 30
  });
});

test("zero-percent temp basal is preserved as a percentage, not mistaken for missing data", () => {
  assert.deepEqual(normalizeTempBasal({ temp: "percent", percent: 0, duration: 25 }), {
    temp: "percent", percent: 0, absolute: 0, duration: 25
  });
});

test("reduced and increased percentage temp basals keep their sign relative to 100 percent", () => {
  assert.deepEqual(normalizeTempBasal({ percent: 70, duration: 20 }), {
    temp: "percent", percent: 70, absolute: 70, duration: 20
  });
  assert.deepEqual(normalizeTempBasal({ percent: 150, duration: 20 }), {
    temp: "percent", percent: 150, absolute: 150, duration: 20
  });
});

test("AAPS percent temp basal is inferred correctly when temp mode is omitted", () => {
  assert.deepEqual(normalizeTempBasal({ percent: 70, rate: 0.56, duration: 30 }), {
    temp: "percent", percent: 70, absolute: 70, rate: 0.56, duration: 30
  });
});

test("percent temp basal preserves AAPS effective rate alongside percent", () => {
  assert.deepEqual(normalizeTempBasal({ temp: "percent", percent: 0, rate: 0.0, duration: 30 }), {
    temp: "percent", percent: 0, absolute: 0, rate: 0, duration: 30
  });
  assert.deepEqual(normalizeTempBasal({ temp: "percent", percent: 150, rate: 1.2, duration: 30 }), {
    temp: "percent", percent: 150, absolute: 150, rate: 1.2, duration: 30
  });
});

test("absolute temp basal supports both positive and zero rates", () => {
  assert.deepEqual(normalizeTempBasal({ absolute: 1.25, duration: 15 }), {
    temp: "absolute", absolute: 1.25, rate: 1.25, duration: 15
  });
});

test("rate-only absolute temp basal is normalized without dropping zero", () => {
  assert.deepEqual(normalizeTempBasal({ rate: 0, duration: 10 }), {
    temp: "absolute", absolute: 0, rate: 0, duration: 10
  });
});

test("percentage-only Temp Basal can be verified by GGC raw percent read-back", () => {
  assert.equal(treatmentsEquivalent(
    { eventType: "Temp Basal", created_at: at, temp: "percent", percent: 0, duration: 30 },
    { eventType: "Temp Basal", created_at: at, temp: "percent", percent: 0, duration: 29 }
  ), true);
});
