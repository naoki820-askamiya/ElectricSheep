import firebase_admin
from firebase_admin import credentials, firestore

DEFAULT_USER_ID = "default_user"  # Firebase Auth導入までの仮のユーザーID

_db = None


def get_db():
    global _db
    if _db is None:
        cred = credentials.Certificate("serviceAccountKey.json")
        firebase_admin.initialize_app(cred)
        _db = firestore.client()
    return _db


def _places_ref(user_id=DEFAULT_USER_ID):
    return get_db().collection("users").document(user_id).collection("places")


def _visits_ref(user_id=DEFAULT_USER_ID):
    return get_db().collection("users").document(user_id).collection("visits")


def add_place(name, lat, lng, is_favorite=False, is_wishlist=False, user_id=DEFAULT_USER_ID):
    doc_ref = _places_ref(user_id).document()
    doc_ref.set({
        "name": name,
        "lat": lat,
        "lng": lng,
        "isFavorite": is_favorite,
        "isWishlist": is_wishlist,
        "visitCount": 0,
        "lastVisitedAt": None,
        "createdAt": firestore.SERVER_TIMESTAMP,
    })
    return doc_ref.id


def add_visit(place_id, companions=None, conversation_summary="", mood="",
              is_detour=False, notable_event="", user_id=DEFAULT_USER_ID):
    db = get_db()
    visit_ref = _visits_ref(user_id).document()
    place_ref = _places_ref(user_id).document(place_id)

    @firestore.transactional
    def create_in_transaction(transaction):
        place_snapshot = place_ref.get(transaction=transaction)
        current_count = place_snapshot.get("visitCount") or 0

        transaction.set(visit_ref, {
            "placeId": place_id,
            "visitedAt": firestore.SERVER_TIMESTAMP,
            "companions": companions or [],
            "conversationSummary": conversation_summary,
            "mood": mood,
            "isDetour": is_detour,
            "notableEvent": notable_event,
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        transaction.update(place_ref, {
            "visitCount": current_count + 1,
            "lastVisitedAt": firestore.SERVER_TIMESTAMP,
        })

    create_in_transaction(db.transaction())
    return visit_ref.id


def get_wishlist(user_id=DEFAULT_USER_ID):
    docs = _places_ref(user_id).where("isWishlist", "==", True).stream()
    return [{"id": d.id, **d.to_dict()} for d in docs]


def get_favorites(user_id=DEFAULT_USER_ID):
    docs = _places_ref(user_id).where("isFavorite", "==", True).stream()
    return [{"id": d.id, **d.to_dict()} for d in docs]


def get_visits_for_place(place_id, user_id=DEFAULT_USER_ID):
    docs = (
        _visits_ref(user_id)
        .where("placeId", "==", place_id)
        .order_by("visitedAt")
        .stream()
    )
    return [{"id": d.id, **d.to_dict()} for d in docs]
