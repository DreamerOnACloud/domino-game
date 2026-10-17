import json, urllib.request, urllib.error

AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key"
FS = "http://127.0.0.1:8080/v1/projects/dominoes-demo/databases/(default)/documents"
CODE = "TEST01"


def req(method, url, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def anon():
    _, d = req("POST", AUTH, {"returnSecureToken": True})
    return d["localId"], d["idToken"]


def s(v):
    return {"stringValue": v}


def i(v):
    return {"integerValue": str(v)}


def b(v):
    return {"booleanValue": v}


def m(mapping):
    return {"mapValue": {"fields": {k: (i(v) if isinstance(v, int) else (b(v) if isinstance(v, bool) else s(v))) for k, v in mapping.items()}}}


def tiles(lst):
    return {"arrayValue": {"values": [
        {"mapValue": {"fields": {"id": s(t[0]), "a": i(t[1]), "b": i(t[2])}}} for t in lst
    ]}}


def board_tiles(lst):
    return {"arrayValue": {"values": [
        {"mapValue": {"fields": {"id": s(t[0]), "a": i(t[1]), "b": i(t[2]),
                                 "double": b(t[1] == t[2]), "seq": i(k + 1)}}}
        for k, t in enumerate(lst)
    ]}}


a_uid, a_tok = anon()
b_uid, b_tok = anon()
print("player A:", a_uid[:8], "player B:", b_uid[:8])

# --- seed a table: one tile 2|1 on the board, so the open ends are 2 and 1.
# A holds 1:1 (the double that used to be rejected) and 0:0.
room = {"fields": {
    "status": s("playing"),
    "members": {"mapValue": {"fields": {"0": s(a_uid), "1": s(b_uid)}}},
    "turn": i(0),
    "board": board_tiles([("21", 2, 1)]),
    "boardSize": i(1),
    "left": i(2), "right": i(1),
    "seq": i(1), "passes": i(0),
    "handCounts": {"mapValue": {"fields": {"0": i(2), "1": i(2)}}},
    "boneyardCount": i(0),
    "round": i(1),
    "scores": {"mapValue": {"fields": {"0": i(0), "1": i(0)}}},
    "over": b(False), "result": {"nullValue": None}, "matchOver": b(False),
    "rematch": {"mapValue": {"fields": {"0": b(False), "1": b(False)}}},
    "createdAt": i(0),
}}
st, body = req("PATCH", FS + "/rooms/" + CODE, room, "owner")
print("seed room:", st)

st, _ = req("PATCH", FS + "/rooms/" + CODE + "/hands/" + a_uid,
            {"fields": {"tiles": tiles([("11", 1, 1), ("00", 0, 0)]), "pips": i(2), "round": i(1)}}, "owner")
print("seed hand A:", st)
st, _ = req("PATCH", FS + "/rooms/" + CODE + "/hands/" + b_uid,
            {"fields": {"tiles": tiles([("23", 2, 3), ("44", 4, 4)]), "pips": i(13), "round": i(1)}}, "owner")
print("seed hand B:", st)

# --- play the double 1:1 on the right end, exactly as the client writes it.
played = {"fields": {
    "status": s("playing"),
    "members": {"mapValue": {"fields": {"0": s(a_uid), "1": s(b_uid)}}},
    "turn": i(1),
    "board": board_tiles([("21", 2, 1), ("11", 1, 1)]),
    "boardSize": i(2),
    "left": i(2), "right": i(1),          # unchanged: a double keeps the end value
    "seq": i(2), "passes": i(0),
    "handCounts": {"mapValue": {"fields": {"0": i(1), "1": i(2)}}},
    "boneyardCount": i(0),
    "round": i(1),
    "scores": {"mapValue": {"fields": {"0": i(0), "1": i(0)}}},
    "over": b(False), "result": {"nullValue": None}, "matchOver": b(False),
    "rematch": {"mapValue": {"fields": {"0": b(False), "1": b(False)}}},
    "createdAt": i(0),
}}
st, body = req("PATCH", FS + "/rooms/" + CODE, played, a_tok)
print("\nplay 1:1 on the 1 end as player A ->", st, "(expect 200)")

st, body = req("PATCH", FS + "/rooms/" + CODE + "/hands/" + a_uid,
               {"fields": {"tiles": tiles([("00", 0, 0)]), "pips": i(0), "round": i(1)}}, a_tok)
print("hand A loses the double      ->", st, "(expect 200)")

# --- negative: same shape, but the board's ends no longer match the chain
bad = json.loads(json.dumps(played))
bad["fields"]["board"] = board_tiles([("21", 2, 1), ("05", 0, 5)])   # 0|5 appended, ends lie
bad["fields"]["boardSize"] = i(2)
st, body = req("PATCH", FS + "/rooms/" + CODE, bad, a_tok)
print("tile that does not fit the end ->", st, "(expect 403)")
print("   ", str(body)[:160])

# --- negative: opponent cannot play on A's turn
st, body = req("PATCH", FS + "/rooms/" + CODE, played, b_tok)
print("play out of turn              ->", st, "(expect 403)")
