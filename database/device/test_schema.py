import firestore_client as db

place_id = db.add_place("鈴鹿サーキット", lat=34.8431, lng=136.5417, is_wishlist=True)
print("場所を追加:", place_id)

visit_id = db.add_visit(
    place_id,
    companions=["父", "母"],
    conversation_summary="子供の頃に見たレースの話で盛り上がった",
    mood="懐かしい",
)
print("訪問を記録:", visit_id)

print("行きたい場所一覧:", db.get_wishlist())
print("この場所の訪問履歴:", db.get_visits_for_place(place_id))
