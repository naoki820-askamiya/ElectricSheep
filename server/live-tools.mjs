const draftUpdateProperties = {
  existingPlaceId: {
    type: "string",
    description:
      "begin_visit_recordingが返した既存場所候補を選ぶ場合のplaceId。候補外のIDは禁止。",
  },
  newPlaceName: {
    type: "string",
    description: "新しい場所として登録する、ユーザーが話した場所名。",
  },
  companions: {
    type: "array",
    items: { type: "string" },
    description: "ユーザーが明言した同行者。推測しない。",
  },
  alone: {
    type: "boolean",
    description: "ユーザーが一人だと明言した場合だけtrue。",
  },
  mood: {
    type: "string",
    description: "ユーザーが話した現在の気分。",
  },
  notableEvent: {
    type: "string",
    description: "ユーザーが自発的に話した印象的な出来事。なければ送らない。",
  },
  isDetour: {
    type: "boolean",
    description: "予定外の寄り道だと明言された場合はtrue。未確認なら送らない。",
  },
};

export const LIVE_TOOL_DECLARATIONS = [
  {
    name: "begin_visit_recording",
    description:
      "現在地の訪問記録を開始する。PiへGPSを要求し、DBから近くの既存場所候補を探して、サーバー内に保存前の下書きを作る。ユーザーが現在地を記録したいと依頼した直後に呼ぶ。",
    parametersJsonSchema: {
      type: "object",
      properties: {
        newPlaceName: draftUpdateProperties.newPlaceName,
        companions: draftUpdateProperties.companions,
        alone: draftUpdateProperties.alone,
        mood: draftUpdateProperties.mood,
        notableEvent: draftUpdateProperties.notableEvent,
        isDetour: draftUpdateProperties.isDetour,
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_visit_draft",
    description:
      "ユーザーとの会話で確定した場所、同行者、気分を保存前の下書きへ追加する。DBへの確定保存は行わない。",
    parametersJsonSchema: {
      type: "object",
      properties: draftUpdateProperties,
      additionalProperties: false,
    },
  },
  {
    name: "commit_visit_record",
    description:
      "必要情報がすべて揃い、保存内容を読み上げ、ユーザーが明確に同意した後だけ訪問記録をDBへ確定保存する。",
    parametersJsonSchema: {
      type: "object",
      properties: {
        confirmed: {
          type: "boolean",
          description: "ユーザーから明確な保存同意を得た場合だけtrue。",
        },
      },
      required: ["confirmed"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_visit_recording",
    description:
      "ユーザーが場所記録の中止を求めた場合に、未保存の下書きを破棄する。",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "end_conversation",
    description:
      "ユーザーが会話終了または接続終了を明示した場合に呼ぶ。未保存の下書きを破棄し、短い別れの返答後にGemini Liveセッションを閉じる。",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export class LiveToolController {
  constructor({
    sessionId,
    userId,
    drafts,
    locationBroker,
    placeRepository,
    nearbyRadiusMeters,
  }) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.drafts = drafts;
    this.locationBroker = locationBroker;
    this.placeRepository = placeRepository;
    this.nearbyRadiusMeters = nearbyRadiusMeters;
  }

  async execute(name, args = {}) {
    switch (name) {
      case "begin_visit_recording":
        return this.begin(args);
      case "update_visit_draft":
        return this.update(args);
      case "commit_visit_record":
        return this.commit(args);
      case "cancel_visit_recording":
        return this.cancel();
      case "end_conversation":
        return { ...this.cancel(), closeConversation: true };
      default:
        throw new Error(`未対応のツールです: ${name}`);
    }
  }

  async begin(args) {
    let draft = this.drafts.get(this.sessionId);
    if (!draft) {
      draft = this.drafts.create(this.sessionId, this.userId);
      const location = await this.locationBroker.request();
      this.drafts.setLocation(this.sessionId, location);
      const nearbyPlaces = await this.placeRepository.findNearbyPlaces(
        this.userId,
        location.lat,
        location.lng,
        this.nearbyRadiusMeters,
      );
      this.drafts.setNearbyPlaces(this.sessionId, nearbyPlaces);
    }

    const initialUpdates = {};
    for (const key of [
      "newPlaceName",
      "companions",
      "alone",
      "mood",
      "notableEvent",
      "isDetour",
    ]) {
      if (args[key] !== undefined) initialUpdates[key] = args[key];
    }
    if (Object.keys(initialUpdates).length > 0) {
      draft = this.drafts.update(this.sessionId, initialUpdates);
    }

    return {
      ok: true,
      instruction:
        draft.nearbyPlaces.length > 0
          ? "近くの既存場所候補をユーザーに確認してください。確認前に選択しないでください。"
          : draft.placeChoice
            ? "既存候補はありません。残りの不足項目を確認してください。"
            : "既存候補はありません。ユーザーに場所名を質問してください。",
      draft: this.drafts.publicView(draft),
    };
  }

  update(args) {
    const draft = this.drafts.update(this.sessionId, args);
    return {
      ok: true,
      instruction:
        this.drafts.missingFields(draft).length === 0
          ? "必要情報が揃いました。内容を短く読み上げ、保存してよいか確認してください。まだDBへ保存しないでください。"
          : "missingFieldsにある項目だけを、一度に一つ質問してください。",
      draft: this.drafts.publicView(draft),
    };
  }

  async commit(args) {
    if (args.confirmed !== true) {
      throw new Error("ユーザーの明確な同意がないため保存しませんでした");
    }
    const draft = this.drafts.markSaving(this.sessionId);
    try {
      const saved = await this.placeRepository.commitVisit(draft);
      this.drafts.delete(this.sessionId);
      return {
        ok: true,
        instruction: "保存に成功しました。ここで初めて記録完了を伝えてください。",
        saved,
      };
    } catch (error) {
      this.drafts.restoreCollecting(this.sessionId);
      throw error;
    }
  }

  cancel() {
    const deleted = this.drafts.delete(this.sessionId);
    return {
      ok: true,
      cancelled: Boolean(deleted),
      instruction: deleted
        ? "未保存の下書きを破棄しました。"
        : "破棄する下書きはありませんでした。",
    };
  }
}
