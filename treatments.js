export const READABLE_GLUROO_TREATMENT_TYPES = new Set([
  "Correction Bolus",
  "Carb Correction",
  "Temp Basal",
  "Basal Insulin Dose"
]);

export const ACCEPTED_NIGHTSCOUT_TREATMENT_TYPES = new Set([
  ...READABLE_GLUROO_TREATMENT_TYPES,
  "Meal",
  "Meal Bolus",
  "Bolus",
  "SMB",
  "Combo Bolus"
]);

export function normalizeTreatmentType(sourceType) {
  if (sourceType === "Meal") return "Carb Correction";
  if (sourceType === "Meal Bolus") return "Correction Bolus";
  if (["Bolus", "SMB", "Combo Bolus"].includes(sourceType)) return "Correction Bolus";
  return READABLE_GLUROO_TREATMENT_TYPES.has(sourceType) ? sourceType : null;
}

export function treatmentTime(value) {
  const v = value?.date ?? value?.mills ?? value?.created_at ?? value?.timestamp ?? value?.eventTime;
  const n = typeof v === "string" && !/^\\d+$/.test(v) ? Date.parse(v) : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function treatmentIdentity(value) {
  const at = treatmentTime(value);
  return [
    value?.eventType || "",
    Number.isFinite(at) ? Math.round(at) : "",
    value?.insulin ?? "",
    value?.carbs ?? "",
    value?.duration ?? "",
    value?.temp ?? "",
    value?.absolute ?? "",
    value?.percent ?? "",
    value?.rate ?? ""
  ].join("|");
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function valuesEqual(left, right) {
  if (!hasValue(left) || !hasValue(right)) return false;
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) <= 0.01;
  return String(left) === String(right);
}

/**
 * Normalize Nightscout/AAPS temporary basal records without losing the
 * distinction between absolute U/h and percentage-of-profile values.
 * Explicit zeroes are intentionally retained (0 is not a missing value).
 */
export function normalizeTempBasal(source) {
  const out = {};
  const sourceMode = String(source?.temp || "").toLowerCase();
  const hasAbsolute = hasValue(source?.absolute);
  const hasRate = hasValue(source?.rate);
  const hasPercent = hasValue(source?.percent);
  const mode = sourceMode === "percent" || (!hasAbsolute && !hasRate && hasPercent)
    ? "percent"
    : "absolute";

  out.temp = mode;
  if (hasValue(source?.duration)) out.duration = Number(source.duration);

  if (mode === "percent") {
    // GGC uses absolute as the raw rate when temp is percent.
    // AAPS/Nightscout rate is the effective basal in U/h; preserve both so
    // the graph can show delivered basal and its deviation from the profile.
    const percentValue = hasPercent ? source.percent : hasAbsolute ? source.absolute : undefined;
    if (hasValue(percentValue)) {
      out.percent = Number(percentValue);
      out.absolute = Number(percentValue);
    }
    if (hasRate) out.rate = Number(source.rate);
  } else {
    // In absolute mode, zero is a real basal suspension, not missing data.
    const absoluteValue = hasAbsolute ? source.absolute : source.rate;
    if (hasValue(absoluteValue)) {
      out.absolute = Number(absoluteValue);
      out.rate = Number(absoluteValue);
    }
    if (hasPercent) out.percent = Number(source.percent);
  }

  return out;
}

// GGC can normalize Temp Basal duration/rate when converting a journal entry
// back to Nightscout format. Match only when the timestamp/type and at least
// one available basal quantity agree, while respecting mode when both sides
// expose it. This supports absolute, percentage, and zero-temp records.
export function treatmentsEquivalent(source, readBack, toleranceMs = 1000) {
  if (!source || !readBack) return false;
  const canonicalType = value => value === "Meal Bolus" ? "Correction Bolus" : value;
  if (canonicalType(source.eventType) !== canonicalType(readBack.eventType)) return false;
  const sourceAt = treatmentTime(source);
  const readBackAt = treatmentTime(readBack);
  if (!Number.isFinite(sourceAt) || !Number.isFinite(readBackAt) || Math.abs(sourceAt - readBackAt) > toleranceMs) return false;

  const comparisonType = canonicalType(source.eventType);
  if (comparisonType === "Temp Basal") {
    const comparisons = [];
    if (hasValue(source.absolute) && hasValue(readBack.absolute)) comparisons.push([source.absolute, readBack.absolute]);
    if (hasValue(source.percent)) {
      if (hasValue(readBack.percent)) comparisons.push([source.percent, readBack.percent]);
      else if (source.temp === "percent" && hasValue(readBack.absolute)) comparisons.push([source.percent, readBack.absolute]);
    }
    if (hasValue(source.rate) && hasValue(readBack.rate)) comparisons.push([source.rate, readBack.rate]);
    if (hasValue(source.duration) && hasValue(readBack.duration)) comparisons.push([source.duration, readBack.duration]);
    if (!comparisons.length || !comparisons.some(([left, right]) => valuesEqual(left, right))) return false;
    if (hasValue(source.temp) && hasValue(readBack.temp) && source.temp !== readBack.temp) return false;
    return true;
  }

  const fieldsByType = {
    "Correction Bolus": ["insulin", "carbs", "protein", "fat", "absorptionTime", "duration"],
    "Carb Correction": ["carbs", "protein", "fat", "absorptionTime", "foodType"],
    "Basal Insulin Dose": ["insulin"]
  };
  const fields = fieldsByType[comparisonType];
  if (!fields) return false;
  const required = {
    "Correction Bolus": ["insulin", "carbs"].filter(field => hasValue(source[field])),
    "Carb Correction": ["carbs"].filter(field => hasValue(source[field])),
    "Basal Insulin Dose": ["insulin"].filter(field => hasValue(source[field]))
  }[comparisonType];
  if (!required.length) return false;
  for (const field of fields) {
    if (hasValue(source[field]) && !valuesEqual(source[field], readBack[field])) return false;
  }
  return true;
}

export function sourceMarker(sourceId) {
  return sourceId ? `[NS bridge source:${sourceId}]` : "";
}

export function hasSourceMarker(notes, sourceId) {
  return Boolean(sourceId && String(notes || "").includes(sourceMarker(sourceId)));
}
