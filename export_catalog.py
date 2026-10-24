"""Eksport zmian z panelu admina (karty, skrzynki i naklejki wariantów) do pliku w repozytorium.

    .venv\\Scripts\\python export_catalog.py

Zapisuje:
  - catalog_export.json  - skrzynki i karty dodane/zmienione/ukryte w panelu admina oraz naklejki wariantów (BEZ danych graczy),
  - custom_images/       - zdjęcia wgrane w panelu admina (karty bez artykułu w Wikipedii albo z własnym plikiem)
                           i wgrane naklejki wariantów.
Nowa instalacja gry (pusta baza) wczyta je automatycznie przy pierwszym uruchomieniu.
"""
import json
import os
import shutil

import catalog
import data as game_data  # 'data' to też nazwa zmiennej w export()
import database
import images

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EXPORT_FILE = os.path.join(BASE_DIR, "catalog_export.json")
IMAGES_DIR = os.path.join(BASE_DIR, "custom_images")
TABLES = (("catalog_crates", "crates"), ("catalog_cards", "cards"), ("catalog_variants", "variants"))


def export(db_path=os.path.join(BASE_DIR, "game.db")):
    conn = database.connect(db_path)  # z DATABASE_URL: baza PostgreSQL
    catalog.init_tables(conn)  # starszy zapis może jeszcze nie mieć tabeli catalog_variants
    out = {key: [] for _, key in TABLES}
    for table, key in TABLES:
        for cid, data, deleted in conn.execute(f"SELECT id, data, deleted FROM {table} ORDER BY id"):
            out[key].append({"id": cid, "data": json.loads(data or "{}"), "deleted": bool(deleted)})
    conn.close()
    with open(EXPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    # własne zdjęcia: karty bez artykułu w Wikipedii albo z wgranym plikiem (nie-JPG z Wikipedii)
    if os.path.isdir(IMAGES_DIR):
        shutil.rmtree(IMAGES_DIR)
    os.makedirs(IMAGES_DIR)
    copied = 0
    for card in out["cards"]:
        if card["deleted"]:
            continue
        path = images.find(card["id"])
        if path and (not card["data"].get("wiki") or not path.lower().endswith(".jpg")):
            shutil.copy2(path, os.path.join(IMAGES_DIR, os.path.basename(path)))
            copied += 1
    # zdjęcia wariantów przypisanych do kart (np. Rzulty Jana Pawła II)
    # i własne zdjęcia wariantów z polem "photo" (np. Halloweenowa) - dowolnej karty
    all_ids = {p["id"] for c in game_data.CRATES.values() for p in c["people"]} | {c["id"] for c in out["cards"]}
    for v, info in game_data.VARIANTS.items():
        for pid in info.get("cards") or (sorted(all_ids) if info.get("photo") else []):
            path = images.find(pid, v)
            if path:
                shutil.copy2(path, os.path.join(IMAGES_DIR, os.path.basename(path)))
                copied += 1
    # naklejki wariantów wgrane przez admina - standardowe i na pojedynczych kartach (wbudowane grafiki są w static/img)
    for row in out["variants"]:
        own = [catalog.clean_card_stickers(c) for c in (row["data"].get("cards") or {}).values()]
        for s in catalog.clean_stickers(row["data"].get("stickers")) + [s for o in own if o for s in o["extra"]]:
            path = images.find(catalog.sticker_file_id(row["id"]), s["id"]) if s["src"] == "upload" else None
            if path:
                shutil.copy2(path, os.path.join(IMAGES_DIR, os.path.basename(path)))
                copied += 1
    # easter egg w bębnie skrzynki (panel admina, sekcja 🥚) - plik __egg.*
    path = images.find("__egg")
    if path:
        shutil.copy2(path, os.path.join(IMAGES_DIR, os.path.basename(path)))
        copied += 1
    return len(out["crates"]), len(out["cards"]), copied


def import_if_empty(conn):
    """Wczytuje eksport do pustej bazy (nowa instalacja). Istniejących zmian nigdy nie nadpisuje.
    Naklejki wariantów wczytujemy osobno - także do starszego zapisu, który ma już karty, ale nie ma jeszcze naklejek."""
    if not os.path.exists(EXPORT_FILE):
        return False
    with open(EXPORT_FILE, encoding="utf-8") as f:
        data = json.load(f)
    count = lambda table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    fresh = not count("catalog_crates") + count("catalog_cards")
    for table, key in TABLES:
        if (fresh if key != "variants" else not count(table)):
            for row in data.get(key, []):
                conn.execute(f"INSERT INTO {table} (id, data, deleted) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                             (row["id"], json.dumps(row["data"], ensure_ascii=False), int(row["deleted"])))
    conn.commit()
    return fresh


def copy_custom_images():
    """Własne zdjęcia z repozytorium -> image_cache (tylko brakujące). Przy każdym starcie, bo na nowym
    serwerze baza bywa przeniesiona ze starego zapisu (nie jest pusta), a folder ze zdjęciami jest pusty."""
    if not os.path.isdir(IMAGES_DIR):
        return
    os.makedirs(images.CACHE_DIR, exist_ok=True)
    for name in os.listdir(IMAGES_DIR):
        target = os.path.join(images.CACHE_DIR, name)
        if not os.path.exists(target):
            shutil.copy2(os.path.join(IMAGES_DIR, name), target)


if __name__ == "__main__":
    crates, cards, imgs = export()
    print(f"Wyeksportowano: {crates} skrzynek, {cards} kart, {imgs} własnych zdjęć i naklejek -> catalog_export.json, custom_images/")
