import http from "node:http";
import { ACCEPTED_NIGHTSCOUT_TREATMENT_TYPES, normalizeTreatmentType, treatmentIdentity, treatmentsEquivalent, sourceMarker, hasSourceMarker } from "./treatments.js";

const PORT = Number(process.env.PORT || 10000);
const NS_BASE = (process.env.NIGHTSCOUT_URL || "https://cgm-remote-monitor-glok.onrender.com").replace(/\/$/, "");
const NS_TOKEN = process.env.NIGHTSCOUT_TOKEN || "";
const NS_SHA1 = process.env.NIGHTSCOUT_API_SECRET_SHA1 || "";
const G_BASE = (process.env.GLUROO_URL || "").replace(/\/$/, "");
const G_SHA1 = process.env.GLUROO_API_SECRET_SHA1 || "";
const SYNC_SECRET = process.env.SYNC_TRIGGER_SECRET || "";
let state = { status: "starting", lastSync: null, counts: {} };
let syncing = false;
let lastProfileFingerprint = "";
const recentlyAcknowledgedSources = new Map();

const auth = secret => secret ? { "api-secret": secret } : {};
function sourceUrl(path, params = {}) {
  const u = new URL(path, NS_BASE);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  if (NS_TOKEN) u.searchParams.set("token", NS_TOKEN);
  return u;
}
async function json(url, secret, options = {}) {
  const r = await fetch(url, { ...options, headers: { ...auth(secret), ...(options.headers || {}) }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${new URL(url).pathname}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const src = (p, q) => json(sourceUrl(p, q), NS_SHA1);
async function dst(p, q = {}) {
  const u = new URL(p, G_BASE);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
  return json(u, G_SHA1);
}
const post = (p, body) => json(new URL(p, G_BASE), G_SHA1, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const arr = x => Array.isArray(x) ? x : x && typeof x === "object" ? [x] : [];
function timeOf(x) {
  const v = x?.date ?? x?.mills ?? x?.created_at ?? x?.timestamp ?? x?.eventTime;
  const n = typeof v === "string" && !/^\d+$/.test(v) ? Date.parse(v) : Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function stable(x) {
  if (Array.isArray(x)) return "[" + x.map(stable).join(",") + "]";
  if (x && typeof x === "object") return "{" + Object.keys(x).sort().map(k => JSON.stringify(k) + ":" + stable(x[k])).join(",") + "}";
  return JSON.stringify(x);
}
function treatmentKey(x) {
  return [x.eventType || "", x.created_at || x.timestamp || x.date || x.eventTime || "", x.insulin ?? "", x.carbs ?? "", x.duration ?? "", x.temp ?? "", x.absolute ?? "", x.notes || ""].join("|");
}

async function syncEntries(c) {
  // GGC only guarantees useful CGM reads for the recent ~24h (up to 730).
  // Reconcile that whole supported window on every run so short scheduler
  // outages do not create gaps; never attempt a misleading 30-day CGM import.
  const since = Date.now() - 24 * 3600000;
  const readings = arr(await src("/api/v1/entries.json", { count: 730, "find[date][$gte]": since }))
    .filter(x => timeOf(x) >= since && timeOf(x) <= Date.now() + 300000 && Number.isInteger(Number(x.sgv)) && Number(x.sgv) >= 20 && Number(x.sgv) <= 600);
  if (!readings.length) return;
  const before = arr(await dst("/api/v1/entries.json", { count: 730 }));
  // Capture freshness metadata only (never log glucose values or credentials).
  // This distinguishes delayed Nightscout source data from GGC delivery/display lag.
  const latestSourceAt = readings.reduce((latest, x) => Math.max(latest, timeOf(x)), -Infinity);
  const latestTargetAt = before.reduce((latest, x) => Math.max(latest, timeOf(x)), -Infinity);
  c.glucoseFreshness = {
    nightscoutLatestAt: Number.isFinite(latestSourceAt) ? new Date(latestSourceAt).toISOString() : null,
    nightscoutLatestAgeSeconds: Number.isFinite(latestSourceAt) ? Math.round((Date.now() - latestSourceAt) / 1000) : null,
    glurooLatestAtBeforeSync: Number.isFinite(latestTargetAt) ? new Date(latestTargetAt).toISOString() : null,
    glurooLatestAgeSecondsBeforeSync: Number.isFinite(latestTargetAt) ? Math.round((Date.now() - latestTargetAt) / 1000) : null,
    newestSourceAlreadyInGluroo: Number.isFinite(latestSourceAt) && before.some(x => timeOf(x) === latestSourceAt)
  };
  const known = new Set(before.map(x => `${timeOf(x)}|${Number(x.sgv)}`));
  const validDirections = new Set(["DoubleUp","SingleUp","FortyFiveUp","Flat","FortyFiveDown","SingleDown","DoubleDown"]);
  const pending = readings.filter(x => !known.has(`${timeOf(x)}|${Number(x.sgv)}`)).map(x => {
    const e = { type: "sgv", sgv: Number(x.sgv), date: timeOf(x), dateString: x.dateString || new Date(timeOf(x)).toISOString(), device: "nightscout-personal-bridge" };
    if (validDirections.has(x.direction)) e.direction = x.direction;
    return e;
  });
  if (!pending.length) return;
  await post("/api/v1/entries.json", pending);
  const after = new Set(arr(await dst("/api/v1/entries.json", { count: 730 })).map(x => `${timeOf(x)}|${Number(x.sgv)}`));
  c.glucoseSent += pending.length;
  c.glucoseVerified += pending.filter(x => after.has(`${x.date}|${x.sgv}`)).length;
}

// GGC POST accepts Meal and Meal Bolus, but GET /treatments does not
// expose those event types. Normalize them to readable types so read-back
// verification and source-marker deduplication work on every scheduled run.
// Keep the first sync window short: older Meal/Meal Bolus posts may already
// exist but be invisible to GET, so replaying 30 days would risk duplicates.
const TREATMENT_LOOKBACK_MS = 10 * 60 * 1000;
const configuredTreatmentCutover = Date.parse(process.env.TREATMENT_SYNC_FROM || "");
const TREATMENT_SYNC_CUTOVER_MS = Number.isFinite(configuredTreatmentCutover) ? configuredTreatmentCutover : Date.now();
const acceptedSourceTypes = ACCEPTED_NIGHTSCOUT_TREATMENT_TYPES;

let historicalCarbBackfillDone = false;
const CARB_BACKFILL_DAYS = 30;
const CARB_BACKFILL_CHUNK_DAYS = 3;
function carbIdentity(item) {
  const at = timeOf(item);
  return Number.isFinite(at) ? `${Math.round(at)}|${Number(item.carbs)}` : "";
}
async function syncHistoricalCarbs(c) {
  if (historicalCarbBackfillDone) return;
  const now = Date.now();
  const start = now - CARB_BACKFILL_DAYS * 86400000;
  let scanned = 0, sent = 0, verified = 0, skippedExisting = 0, skippedInvalid = 0;
  for (let from = start; from < now; from += CARB_BACKFILL_CHUNK_DAYS * 86400000) {
    const to = Math.min(now, from + CARB_BACKFILL_CHUNK_DAYS * 86400000);
    const query = {
      count: 5000,
      "find[created_at][$gte]": new Date(from).toISOString(),
      "find[created_at][$lt]": new Date(to).toISOString()
    };
    const source = arr(await src("/api/v1/treatments.json", query))
      .filter(x => Number.isFinite(timeOf(x)) && timeOf(x) >= from && timeOf(x) < to &&
        (x.eventType === "Meal" || x.eventType === "Meal Bolus") && Number(x.carbs) > 0);
    const existing = arr(await dst("/api/v1/treatments.json", query));
    const known = new Set(existing.filter(x => x.eventType === "Carb Correction" && Number(x.carbs) > 0).map(carbIdentity));
    const sourceSeen = new Set();
    const pending = [];
    for (const meal of source) {
      scanned++;
      const key = carbIdentity(meal);
      if (!key) { skippedInvalid++; continue; }
      if (sourceSeen.has(key) || known.has(key)) { skippedExisting++; continue; }
      sourceSeen.add(key);
      const payload = {
        eventType: "Carb Correction",
        created_at: meal.created_at || new Date(timeOf(meal)).toISOString(),
        carbs: Number(meal.carbs)
      };
      for (const field of ["protein", "fat", "absorptionTime", "foodType"]) {
        if (meal[field] !== undefined && meal[field] !== null) payload[field] = meal[field];
      }
      const marker = sourceMarker(meal._id ? String(meal._id) : "");
      const note = [marker, meal.notes].filter(Boolean).join(" ").trim();
      if (note) payload.notes = note.slice(0, 1000);
      pending.push({ payload, key });
    }
    for (let offset = 0; offset < pending.length; offset += 40) {
      const batch = pending.slice(offset, offset + 40);
      const acknowledgements = arr(await post("/api/v1/treatments.json", batch.map(x => x.payload)));
      sent += batch.length;
      const after = arr(await dst("/api/v1/treatments.json", query));
      const afterKeys = new Set(after.filter(x => x.eventType === "Carb Correction" && Number(x.carbs) > 0).map(carbIdentity));
      for (const item of batch) {
        if (afterKeys.has(item.key)) { verified++; known.add(item.key); }
      }
      if (acknowledgements.length !== batch.length) {
        // Read-back, not the POST acknowledgement, is the source of truth.
      }
    }
  }
  c.carbBackfill = { windowDays: CARB_BACKFILL_DAYS, sourceMealsWithCarbs: scanned, carbEventsSent: sent, carbEventsVerified: verified, alreadyPresentOrRepeated: skippedExisting, invalid: skippedInvalid };
  c.carbBackfillUnverified = sent - verified;
  historicalCarbBackfillDone = true;
  console.log(JSON.stringify({ event: "carb_backfill_finished", counts: c.carbBackfill, unverified: c.carbBackfillUnverified }));
}
async function inspectTreatments(c) {
  // Read-only 24h comparison. This diagnoses GGC's read-back behavior without
  // posting anything or logging clinical values, timestamps, notes, or IDs.
  const since = Date.now() - 24 * 3600000;
  const source = arr(await src("/api/v1/treatments.json", {
    count: 5000,
    "find[created_at][$gte]": new Date(since).toISOString()
  })).filter(x => Number.isFinite(timeOf(x)) && timeOf(x) >= since && acceptedSourceTypes.has(x.eventType));
  const readBack = arr(await dst("/api/v1/treatments.json", {
    count: 5000,
    "find[created_at][$gte]": new Date(since).toISOString()
  }));
  const sourceTypes = {};
  const mappedTypes = {};
  const sourceIdentities = new Set();
  const sourceIdentitiesWithoutTime = new Set();
  const normalizedSourceTreatments = [];
  const sourceTimes = [];
  const sourceFieldsByType = {};
  for (const item of source) {
    sourceTypes[item.eventType] = (sourceTypes[item.eventType] || 0) + 1;
    const mappedType = normalizeTreatmentType(item.eventType);
    if (!mappedType) continue;
    mappedTypes[mappedType] = (mappedTypes[mappedType] || 0) + 1;
    const normalized = { ...item, eventType: mappedType };
    normalizedSourceTreatments.push(normalized);
    sourceIdentities.add(treatmentIdentity(normalized));
    sourceIdentitiesWithoutTime.add([mappedType, normalized.insulin ?? "", normalized.carbs ?? "", normalized.duration ?? "", normalized.temp ?? "", normalized.absolute ?? ""].join("|"));
    const at = timeOf(item);
    if (Number.isFinite(at)) sourceTimes.push(at);
    sourceFieldsByType[mappedType] ||= {};
    for (const field of ["insulin","carbs","duration","temp","absolute"]) {
      if (item?.[field] !== undefined && item?.[field] !== null) sourceFieldsByType[mappedType][field] = true;
    }
  }
  const readBackIdentities = new Set(readBack.map(treatmentIdentity));
  const readBackIdentitiesWithoutTime = new Set(readBack.map(item =>
    [item?.eventType || "", item?.insulin ?? "", item?.carbs ?? "", item?.duration ?? "", item?.temp ?? "", item?.absolute ?? ""].join("|")
  ));
  const readBackTimes = readBack.map(timeOf).filter(Number.isFinite);
  const readBackTypes = {};
  const readBackFieldsByType = {};
  const fieldComparisonsByType = {};
  let sameTimeAndTypePairs = 0;
  let sameTimeDifferentTypePairs = 0;
  const diagnosticFields = ["insulin","carbs","duration","absolute","temp","protein","fat","absorptionTime","foodType"];
  const diagnosticEqual = (a, b) => {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    const left = Number(a), right = Number(b);
    return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) <= 0.01 : String(a) === String(b);
  };
  for (const sourceItem of normalizedSourceTreatments) {
    const sourceAt = timeOf(sourceItem);
    if (!Number.isFinite(sourceAt)) continue;
    const sameTime = readBack.filter(item => Math.abs(timeOf(item) - sourceAt) <= 1000);
    if (sameTime.length && !sameTime.some(item => item.eventType === sourceItem.eventType)) sameTimeDifferentTypePairs++;
    const candidate = sameTime.find(item => item.eventType === sourceItem.eventType);
    if (!candidate) continue;
    sameTimeAndTypePairs++;
    const type = sourceItem.eventType;
    fieldComparisonsByType[type] ||= {};
    for (const field of diagnosticFields) {
      if (sourceItem[field] === undefined || sourceItem[field] === null) continue;
      const stat = fieldComparisonsByType[type][field] ||= { sourceHas: 0, readBackHas: 0, equal: 0, different: 0 };
      stat.sourceHas++;
      if (candidate[field] !== undefined && candidate[field] !== null) {
        stat.readBackHas++;
        if (diagnosticEqual(sourceItem[field], candidate[field])) stat.equal++;
        else stat.different++;
      }
    }
  }
  for (const item of readBack) {
    const type = item?.eventType || "(missing)";
    readBackTypes[type] = (readBackTypes[type] || 0) + 1;
    readBackFieldsByType[type] ||= {};
    for (const field of ["_id","notes","created_at","mills","insulin","carbs","duration","temp","absolute"]) {
      if (item?.[field] !== undefined && item?.[field] !== null) readBackFieldsByType[type][field] = true;
    }
  }
  c.treatmentReadOnlyDiagnostic = {
    windowHours: 24,
    sourceCandidates: source.length,
    sourceTypes,
    mappedTypes,
    sourceUniqueIdentities: sourceIdentities.size,
    sourceFieldsByType,
    sourceTimesAvailable: sourceTimes.length,
    readBackObjects: readBack.length,
    readBackTypes,
    readBackUniqueIdentities: readBackIdentities.size,
    identityMatches: [...sourceIdentities].filter(key => readBackIdentities.has(key)).length,
    semanticMatches: normalizedSourceTreatments.filter(sourceItem => readBack.some(readBackItem => treatmentsEquivalent(sourceItem, readBackItem))).length,
    sameTimeAndTypePairs,
    sameTimeDifferentTypePairs,
    fieldComparisonsByType,
    identityMatchesWithoutTime: [...sourceIdentitiesWithoutTime].filter(key => readBackIdentitiesWithoutTime.has(key)).length,
    exactTimestampMatches: sourceTimes.filter(at => readBackTimes.includes(at)).length,
    readBackObjectsWithId: readBack.filter(x => Boolean(x?._id)).length,
    readBackObjectsWithNotes: readBack.filter(x => Boolean(x?.notes)).length,
    readBackObjectsWithSourceMarker: readBack.filter(item => source.some(sourceItem => hasSourceMarker(item?.notes, String(sourceItem?._id || "")))).length,
    readBackFieldsByType
  };
}

async function syncTreatments(c) {
  const since = Math.max(Date.now() - TREATMENT_LOOKBACK_MS, TREATMENT_SYNC_CUTOVER_MS);
  const items = arr(await src("/api/v1/treatments.json", { count: 5000, "find[created_at][$gte]": new Date(since).toISOString() }))
    .filter(x => Number.isFinite(timeOf(x)) && timeOf(x) >= since && acceptedSourceTypes.has(x.eventType));
  if (!items.length) return;
  // GGC's GET endpoint returns only a subset of treatment types. Its date
  // filter is supported, so compare the full 30-day window before each batch.
  const existing = arr(await dst("/api/v1/treatments.json", { count: 5000, "find[created_at][$gte]": new Date(since).toISOString() }));
  const notes = existing.map(x => String(x.notes || ""));
  const keys = new Set(existing.map(treatmentKey));
  const pending = [];
  for (const x of items) {
    const eventType = normalizeTreatmentType(x.eventType);
    if (!eventType) {
      c.treatmentsSkippedUnsupported++;
      continue;
    }
    if (x.eventType === "Meal" && !(Number(x.carbs) > 0)) {
      c.treatmentsSkippedUnsupported++;
      continue;
    }
    const sourceId = x._id ? String(x._id) : "";
    const marker = sourceMarker(sourceId);
    if (sourceId && recentlyAcknowledgedSources.has(sourceId)) continue;
    if (marker && notes.some(n => hasSourceMarker(n, sourceId))) continue;
    const normalized = { ...x, eventType };
    // Always dedupe against Gluroo's readable records, even when GGC strips
    // notes or the source marker. Compare time and required clinical fields.
    if (existing.some(candidate => treatmentsEquivalent(normalized, candidate))) continue;
    if (!marker && keys.has(treatmentKey(normalized))) continue;
    const created_at = x.created_at || new Date(timeOf(x)).toISOString();
    const out = { eventType, created_at };
    // AAPS emits absolute temp basals with an `absolute` rate but may omit
    // the Nightscout `temp` discriminator. GGC needs it to interpret the rate.
    if (eventType === "Temp Basal" && !x.temp && x.absolute !== undefined && x.absolute !== null) out.temp = "absolute";
    for (const k of ["insulin","carbs","protein","fat","absorptionTime","foodType","duration","temp","absolute"]) if (x[k] !== undefined && x[k] !== null) out[k] = x[k];
    const note = [marker, x.notes].filter(Boolean).join(" ").trim();
    if (note) out.notes = note.slice(0, 1000);
    if (x.enteredBy) out.enteredBy = "Nightscout bridge";
    pending.push(out);
    if (pending.length === 40) break;
  }
  if (!pending.length) return;
  // GGC returns opaque IDs for accepted POST items. Keep those IDs and
  // independently read the records back; an HTTP 200 alone is not proof
  // that Gluroo persisted a treatment.
  const acknowledgements = arr(await post("/api/v1/treatments.json", pending));
  c.treatmentsSent += pending.length;
  c.treatmentsAcknowledged += acknowledgements.filter(x => x && x._id).length;
  // Suppress retries of acknowledged source records while Gluroo's GET view
  // catches up. Cache opaque Nightscout IDs only; no clinical values are logged.
  const ackedAt = Date.now();
  const sourceIdByMarker = new Map(items.filter(x => x?._id).map(x => [sourceMarker(String(x._id)), String(x._id)]));
  for (let i = 0; i < pending.length; i++) {
    const marker = String(pending[i].notes || "").match(/\[NS bridge source:[^\]]+\]/)?.[0];
    const sourceId = marker ? sourceIdByMarker.get(marker) : null;
    if (sourceId && acknowledgements[i]?._id) recentlyAcknowledgedSources.set(sourceId, ackedAt + 4 * 60 * 1000);
  }
  for (const [id, expiresAt] of recentlyAcknowledgedSources) if (expiresAt <= ackedAt) recentlyAcknowledgedSources.delete(id);

  const after = arr(await dst("/api/v1/treatments.json", { count: 5000, "find[created_at][$gte]": new Date(since).toISOString() }));
  c.treatmentsReadBack = after.length;
  const afterNotes = after.map(x => String(x.notes || ""));
  const afterIds = new Set(after.map(x => x?._id).filter(Boolean));

  const readBackTypes = {};
  for (const item of after) readBackTypes[item?.eventType || "(missing)"] = (readBackTypes[item?.eventType || "(missing)"] || 0) + 1;
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const ackId = acknowledgements[i]?._id;
    const marker = String(item.notes || "").match(/\[NS bridge source:[^\]]+\]/)?.[0];
    const foundById = Boolean(ackId && afterIds.has(ackId));
    const foundByMarker = Boolean(marker && afterNotes.some(n => n.includes(marker)));
    const foundByIdentity = after.some(candidate => treatmentsEquivalent(item, candidate));
    if (foundById) c.treatmentsVerifiedById++;
    else if (foundByMarker) c.treatmentsVerifiedByMarker++;
    else if (foundByIdentity) c.treatmentsVerifiedByIdentity++;
  }
  c.treatmentsVerified = c.treatmentsVerifiedById + c.treatmentsVerifiedByMarker + c.treatmentsVerifiedByIdentity;
  c.treatmentsUnverified = Math.max(0, c.treatmentsSent - c.treatmentsVerified);
  const pendingTypes = pending.reduce((out, item) => { out[item.eventType] = (out[item.eventType] || 0) + 1; return out; }, {});
  c.treatmentReadBackDiagnostics = {
    acknowledgedObjects: acknowledgements.length,
    acknowledgementsWithId: acknowledgements.filter(x => Boolean(x?._id)).length,
    readBackObjects: after.length,
    readBackTypes,
    readBackObjectsWithId: after.filter(x => Boolean(x?._id)).length,
    readBackObjectsWithNotes: after.filter(x => Boolean(x?.notes)).length,
    readBackObjectsWithSourceMarker: after.filter(x => items.some(source => hasSourceMarker(x?.notes, String(source?._id || "")))).length,
    readBackObjectsWithTime: after.filter(x => Number.isFinite(timeOf(x))).length,
    acknowledgementUniqueIds: new Set(acknowledgements.map(x => x?._id).filter(Boolean)).size,
    acknowledgementIdsMatchingReadBack: acknowledgements.filter(x => x?._id && afterIds.has(x._id)).length,
    pendingUniqueIdentities: new Set(pending.map(treatmentIdentity)).size,
    pendingTypes
  };
}
async function syncDeviceStatus(c) {
  const x = arr(await src("/api/v1/devicestatus.json", { count: 1 }))[0];
  if (!x) return;
  const loop = x.loop || x.openaps;
  if (!loop || typeof loop !== "object") { c.deviceStatusSkippedNoLoopBlock++; return; }
  const current = arr(await dst("/api/v1/devicestatus.json", { count: 1 }))[0];
  if (Number.isFinite(timeOf(x)) && Number.isFinite(timeOf(current)) && timeOf(x) <= timeOf(current)) return;
  const payload = { device: x.device || "AndroidAPS", loop,
    ...(x.created_at ? { created_at: x.created_at } : {}),
    ...(x.mills ? { mills: x.mills } : {}),
    ...(x.pump ? { pump: x.pump } : {}),
    ...(x.uploader ? { uploader: x.uploader } : {}) };
  await post("/api/v1/devicestatus.json", [payload]);
  c.deviceStatusSent++;
}
async function syncProfile(c) {
  const p = arr(await src("/api/v1/profile.json", { count: 1 }))[0];
  if (!p) return;
  const fp = stable(p);
  if (fp === lastProfileFingerprint) return;
  const current = arr(await dst("/api/v1/profile/current.json"));
  if (current.length && stable(current[0]) === fp) { lastProfileFingerprint = fp; return; }
  await post("/api/v1/profile.json", [p]);
  lastProfileFingerprint = fp;
  c.profilesSent++;
}
async function runSync({ includeTreatments = true, glucoseOnly = false } = {}) {
  if (syncing) return { status: "already_running" };
  if (!G_BASE || !G_SHA1 || !SYNC_SECRET) throw new Error("Missing Gluroo or scheduler configuration.");
  const host = new URL(G_BASE);
  if (host.protocol !== "https:" || !host.hostname.endsWith(".ns.gluroo.com")) throw new Error("Invalid Gluroo URL.");
  if (!/^[a-f0-9]{40}$/i.test(G_SHA1)) throw new Error("Invalid Gluroo SHA-1 credential.");
  syncing = true;
  const c = { glucoseSent: 0, glucoseVerified: 0, treatmentsSent: 0, treatmentsAcknowledged: 0, treatmentsReadBack: 0, treatmentsVerified: 0, treatmentsVerifiedById: 0, treatmentsVerifiedByMarker: 0, treatmentsVerifiedByIdentity: 0, treatmentsSkippedUnsupported: 0, treatmentsUnverified: 0, treatmentsLookbackMinutes: TREATMENT_LOOKBACK_MS / 60000, treatmentCutoverActive: true, deviceStatusSent: 0, deviceStatusSkippedNoLoopBlock: 0, profilesSent: 0 };
  try {
    const tasks = [syncEntries(c)];
    if (!glucoseOnly) {
      if (includeTreatments) tasks.push((async () => { await syncTreatments(c); await syncHistoricalCarbs(c); })());
      else {
        c.treatmentSyncSkipped = "startup_safety";
        tasks.push(inspectTreatments(c));
      }
      tasks.push(syncDeviceStatus(c), syncProfile(c));
    }
    const results = await Promise.allSettled(tasks);
    const errors = results.filter(x => x.status === "rejected").map(x => x.reason?.message || "Unknown error");
    const verificationWarning = c.treatmentsUnverified > 0;
    state = { status: errors.length ? "partial_error" : verificationWarning ? "verification_warning" : "ok", lastSync: new Date().toISOString(), counts: c, errors };
    console.log(JSON.stringify({ event: glucoseOnly ? "glucose_sync_finished" : "sync_finished", status: state.status, counts: c, errorCount: errors.length }));
    if (errors.length) throw new Error(errors.join("; "));
    return state;
  } finally { syncing = false; }
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && u.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ service: "gluroo-bridge", state })); return;
  }
  if (req.method === "GET" && u.pathname === "/sync") {
    if (!SYNC_SECRET || req.headers["x-sync-secret"] !== SYNC_SECRET) {
      res.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" }); res.end("Unauthorized"); return;
    }
    try {
      const result = await runSync();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, status: result.status, lastSync: result.lastSync, counts: result.counts }));
    } catch (e) {
      state = { ...state, status: "error", lastError: e.message };
      console.error(`Sync failed: ${e.message}`);
      res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ ok: false, error: e.message }));
    } return;
  }
  if (req.method === "GET" && u.pathname === "/sync-glucose") {
    if (!SYNC_SECRET || req.headers["x-sync-secret"] !== SYNC_SECRET) {
      res.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" }); res.end("Unauthorized"); return;
    }
    try {
      const result = await runSync({ glucoseOnly: true });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, status: result.status, lastSync: result.lastSync, counts: result.counts }));
    } catch (e) {
      state = { ...state, status: "error", lastError: e.message };
      console.error(`Glucose sync failed: ${e.message}`);
      res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ ok: false, error: e.message }));
    } return;
  }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found");
});
server.listen(PORT, "0.0.0.0", () => {
  console.log("Gluroo bridge ready. Authenticated scheduler triggers five-minute syncs; no glucose values or credentials are logged.");
  if (G_BASE && G_SHA1 && SYNC_SECRET) runSync({ includeTreatments: false }).then(async () => { const summary = {}; await syncHistoricalCarbs(summary); }).catch(e => console.error(`Initial sync or carb backfill failed: ${e.message}`));
});
