"""Копия еды и занятий партнёра: только при разрешении в его профиле, личное не отдаётся."""
from app import db, foods_api


def test_partner_meals_need_permission(users):
    iv, ma = users["ivan"], users["masha"]
    items = [{"name": "Гречка варёная", "grams": 150, "kcal": 165, "p": 6.3, "f": 1.7, "c": 32.0, "source": "db"}]
    db.server_put(ma["id"], "food", "m_food", {"meal": "lunch", "time": "13:10", "text": "гречка", "items": items,
                                               "status": "calculated"}, "2026-10-02")
    db.server_put(ma["id"], "profile", f"profile:{ma['id']}", {"name": "Мария"}, None)
    assert foods_api.partner_meals("2026-10-02", iv) == {"partners": [], "closed": ["Мария"]}
    db.server_put(ma["id"], "profile", f"profile:{ma['id']}", {"name": "Мария", "share_meals": True}, None)
    got = foods_api.partner_meals("2026-10-02", iv)["partners"][0]["meals"]
    assert got[0]["totals"]["kcal"] == 165 and got[0]["meal"] == "lunch"


def test_partner_activities_hide_private(users):
    iv, ma = users["ivan"], users["masha"]
    db.server_put(ma["id"], "profile", f"profile:{ma['id']}", {"name": "Мария", "share_training": True}, None)
    db.server_put(ma["id"], "activity", "m_walk", {"type": "walking", "minutes": 45, "intensity": "mid", "note": "личное"}, "2026-10-02")
    db.server_put(ma["id"], "activity", "m_massage", {"type": "massage", "minutes": 30}, "2026-10-02")
    p = foods_api.partner_activities("2026-10-02", iv)["partners"][0]
    assert [a["type"] for a in p["activities"]] == ["walking"]
    assert "note" not in p["activities"][0]
