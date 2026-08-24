import firebase_admin
from firebase_admin import credentials, firestore

cred = credentials.Certificate("serviceAccountKey.json")
firebase_admin.initialize_app(cred)

db = firestore.client()

doc_ref = db.collection("test").document("connection_check")
doc_ref.set({"message": "Hello from device!", "ok": True})
print("書き込み成功")

doc = doc_ref.get()
print("読み込み結果:", doc.to_dict())
