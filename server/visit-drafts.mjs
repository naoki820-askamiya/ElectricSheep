import { randomUUID } from "node:crypto";

function cleanRequiredText(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} は空にできません`);
  }
  return value.trim();
}

function cleanOptionalText(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${fieldName} は文字列で指定してください`);
  }
  return value.trim();
}

function cleanCompanions(value) {
  if (!Array.isArray(value)) {
    throw new Error("companions は文字列の配列で指定してください");
  }
  return [
    ...new Set(
      value.map((item) => cleanRequiredText(item, "同行者")).filter(Boolean),
    ),
  ];
}

export function validateCoordinates(lat, lng) {
  if (
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    typeof lng !== "number" ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    throw new Error("GPSから有効な緯度・経度が返りませんでした");
  }
  return { lat, lng };
}

export class VisitDraftStore {
  constructor({ idFactory = randomUUID, now = () => new Date() } = {}) {
    this.idFactory = idFactory;
    this.now = now;
    this.bySession = new Map();
  }

  create(sessionId, userId) {
    const existing = this.bySession.get(sessionId);
    if (existing) return existing;

    const timestamp = this.now();
    const draft = {
      id: this.idFactory(),
      sessionId,
      userId: cleanRequiredText(userId, "userId"),
      status: "collecting",
      location: null,
      nearbyPlaces: [],
      placeChoice: null,
      companions: null,
      mood: null,
      notableEvent: null,
      isDetour: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.bySession.set(sessionId, draft);
    return draft;
  }

  get(sessionId) {
    return this.bySession.get(sessionId) ?? null;
  }

  require(sessionId) {
    const draft = this.get(sessionId);
    if (!draft) throw new Error("保存前の訪問記録がありません");
    return draft;
  }

  setLocation(sessionId, location) {
    const draft = this.require(sessionId);
    const coordinates = validateCoordinates(location.lat, location.lng);
    draft.location = {
      ...coordinates,
      accuracy:
        typeof location.accuracy === "number" && Number.isFinite(location.accuracy)
          ? location.accuracy
          : null,
      measuredAt:
        typeof location.measuredAt === "string" ? location.measuredAt : null,
    };
    this.touch(draft);
    return draft;
  }

  setNearbyPlaces(sessionId, places) {
    const draft = this.require(sessionId);
    draft.nearbyPlaces = places.map((place) => ({
      id: cleanRequiredText(place.id, "placeId"),
      name: cleanRequiredText(place.name, "場所名"),
      distanceMeters: Math.round(Number(place.distanceMeters)),
    }));
    this.touch(draft);
    return draft;
  }

  update(sessionId, updates) {
    const draft = this.require(sessionId);
    if (draft.status !== "collecting") {
      throw new Error("この訪問記録は更新できません");
    }

    if (updates.existingPlaceId !== undefined) {
      const placeId = cleanRequiredText(updates.existingPlaceId, "placeId");
      const candidate = draft.nearbyPlaces.find((place) => place.id === placeId);
      if (!candidate) {
        throw new Error("GPS検索結果に含まれない場所は選択できません");
      }
      draft.placeChoice = {
        kind: "existing",
        placeId: candidate.id,
        name: candidate.name,
      };
    }

    if (updates.newPlaceName !== undefined) {
      draft.placeChoice = {
        kind: "new",
        name: cleanRequiredText(updates.newPlaceName, "場所名"),
      };
    }

    if (updates.alone === true) {
      draft.companions = [];
    } else if (updates.companions !== undefined) {
      draft.companions = cleanCompanions(updates.companions);
    }

    if (updates.mood !== undefined) {
      draft.mood = cleanRequiredText(updates.mood, "気分");
    }

    const notableEvent = cleanOptionalText(updates.notableEvent, "印象的な出来事");
    if (notableEvent !== undefined) draft.notableEvent = notableEvent;

    if (updates.isDetour !== undefined) {
      if (typeof updates.isDetour !== "boolean") {
        throw new Error("isDetour は真偽値で指定してください");
      }
      draft.isDetour = updates.isDetour;
    }

    this.touch(draft);
    return draft;
  }

  missingFields(draft) {
    const missing = [];
    if (!draft.location) missing.push("currentLocation");
    if (!draft.placeChoice) missing.push("place");
    if (draft.companions === null) missing.push("companions");
    if (draft.mood === null) missing.push("mood");
    return missing;
  }

  publicView(draft) {
    const missingFields = this.missingFields(draft);
    return {
      draftId: draft.id,
      status: draft.status,
      location: draft.location,
      nearbyPlaces: draft.nearbyPlaces,
      selectedPlace: draft.placeChoice,
      companions: draft.companions,
      mood: draft.mood,
      notableEvent: draft.notableEvent,
      isDetour: draft.isDetour,
      missingFields,
      readyToConfirm: missingFields.length === 0,
    };
  }

  markSaving(sessionId) {
    const draft = this.require(sessionId);
    if (this.missingFields(draft).length > 0) {
      throw new Error(
        `必須情報が不足しています: ${this.missingFields(draft).join(", ")}`,
      );
    }
    draft.status = "saving";
    this.touch(draft);
    return draft;
  }

  restoreCollecting(sessionId) {
    const draft = this.require(sessionId);
    draft.status = "collecting";
    this.touch(draft);
    return draft;
  }

  delete(sessionId) {
    const draft = this.get(sessionId);
    this.bySession.delete(sessionId);
    return draft;
  }

  touch(draft) {
    draft.updatedAt = this.now();
  }
}

function joinJapanese(items) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return items.join("と");
  return `${items.slice(0, -1).join("、")}、${items.at(-1)}`;
}

export function buildConversationSummary(draft) {
  const companionText =
    draft.companions.length === 0
      ? "一人で"
      : `${joinJapanese(draft.companions)}と`;
  const base = `${companionText}${draft.placeChoice.name}を訪れ、気分は「${draft.mood}」と話した。`;
  if (!draft.notableEvent) return base;
  return `${base.slice(0, -1)}。印象に残った出来事は「${draft.notableEvent}」。`;
}
