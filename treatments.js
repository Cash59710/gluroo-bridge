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
  const n = typeof v === "string" && !/^\d+$/.test(v) ? Date.parse(v) : Number(v);
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
    value?.absolute ?? ""
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

// Compare only the fields Gluroo actually returns, but require every
// clinically meaningful field present on the Nightscout source to survive.
// This avoids false negatives from optional fields such as Temp Basal's
// inferred "temp" mode while still refusing partial carb/insulin matches.
export function treatmentsEquivalent(source, readBack, toleranceMs = 1000) {
  if (!source || !readBack) return false;
  // Gluroo may expose an uploaded Meal Bolus as Correction Bolus on read-back.
  // Preserve Meal Bolus on POST, but compare the two representations as the same
  // underlying insulin/carbohydrate event for safe deduplication.
  const canonicalType = value => value === "Meal Bolus" ? "Correction Bolus" : value;
  if (canonicalType(source.eventType) !== canonicalType(readBack.eventType)) return false;
  const sourceAt = treatmentTime(source);
  const readBackAt = treatmentTime(readBack);
  if (!Number.isFinite(sourceAt) || !Number.isFinite(readBackAt) || Math.abs(sourceAt - readBackAt) > toleranceMs) return false;

  const fieldsByType = {
    "Correction Bolus": ["insulin", "carbs", "protein", "fat", "absorptionTime", "duration"],
    "Carb Correction": ["carbs", "protein", "fat", "absorptionTime", "foodType"],
    "Temp Basal": ["absolute", "duration", "temp"],
    "Basal Insulin Dose": ["insulin"]
  };
  const comparisonType = canonicalType(source.eventType);
  const fields = fieldsByType[comparisonType];
  if (!fields) return false;

  // GGC can normalize a Temp Basal's duration/rate when it converts the
  // journal entry back to Nightscout format. Requiring every source field
  // to match caused already-stored basal changes to be POSTed repeatedly.
  // The event timestamp + type identify the basal change; at least one
  // available clinical field must also agree before treating it as stored.
  if (comparisonType === "Temp Basal") {
    const comparable = ["absolute", "duration"].filter(field =>
      hasValue(source[field]) && hasValue(readBack[field])
    );
    if (!comparable.length) return false;
    if (!comparable.some(field => valuesEqual(source[field], readBack[field]))) return false;
    if (hasValue(source.temp) && hasValue(readBack.temp) && source.temp !== readBack.temp) return false;
    return true;
  }

  const required = {
    "Correction Bolus": ["insulin", "carbs"].filter(field => hasValue(source[field])),
    "Carb Correction": ["carbs"].filter(field => hasValue(source[field])),
    "Temp Basal": ["absolute"].filter(field => hasValue(source[field])),
    "Basal Insulin Dose": ["insulin"].filter(field => hasValue(source[field]))
  }[comparisonType];
  if (!required.length) return false;

  for (const field of fields) {
    if (hasValue(source[field]) && !valuesEqual(source[field], readBack[field])) return false;
  }
  // AAPS absolute temp-basal uploads may omit Nightscout's mode flag.
  // When absolute is present, the bridge explicitly sends "absolute".
  if (source.eventType === "Temp Basal" && hasValue(source.absolute) && !hasValue(source.temp) && readBack.temp !== "absolute") return false;
  return true;
}

export function sourceMarker(sourceId) {
  return sourceId ? `[NS bridge source:${sourceId}]` : "";
}

export function hasSourceMarker(notes, sourceId) {
  return Boolean(sourceId && String(notes || "").includes(sourceMarker(sourceId)));
}
