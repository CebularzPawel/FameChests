//! Logika gry wspólna dla wielu zakładek (port funkcji pomocniczych z app.py): stan gracza, karty, skrzynki,
//! Hall of Fame, klaser, przekazywanie kart między graczami.

pub mod market;
pub mod roll;
pub mod views;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use indexmap::IndexMap;
use serde::Serialize;

use crate::auth::{User, UserView};
use crate::catalog::{Catalog, Person};
use crate::data::g;
use crate::db::{now, Conn};
use crate::error::{bad, AppError, Res};
use crate::state::AppState;
use crate::text::Truncate;

/// "Właściciel" kart wystawionych na rynek / postawionych w blackjacku (czekają na koniec transakcji)
pub const ESCROW: i64 = 0;
pub const FAV_ERROR: &str = "Ulubionych kart (⭐) nie da się zużyć ani sprzedać — najpierw odznacz gwiazdkę";
pub const SPECIAL_ERROR: &str =
    "Kart specjalnych nie da się sprzedać grze, postawić ani zużyć — można je tylko wymienić albo sprzedać na rynku";

/// Zapytanie gracza: stan serwera, migawka katalogu, zalogowany gracz
pub struct Ctx {
    pub st: AppState,
    pub cat: Arc<Catalog>,
    pub me: User,
}

impl Ctx {
    pub fn new(st: AppState, me: User) -> Self {
        let cat = st.cat();
        Ctx { st, cat, me }
    }

    pub fn uid(&self) -> i64 {
        self.me.id
    }

    pub fn person(&self, pid: &str) -> Option<&Arc<Person>> {
        self.cat.person(pid)
    }
}

// ---------------------------------------------------------------- stan gracza (user_state)

/// patch_seen: ostatnia obejrzana lista zmian; market_seen: kiedy gracz ostatnio oglądał rynek;
/// jackpot_seen: koniec (ms) ostatniej gry w jackpot, której wynik gracz już widział
pub fn state_keys() -> [(&'static str, i64); 14] {
    [
        ("balance", g().starting_balance),
        ("opened", 0),
        ("spent", 0),
        ("earned", 0),
        ("deposited", 0),
        ("contracts", 0),
        ("upgrades_won", 0),
        ("upgrades_lost", 0),
        ("feed_seen", 0),
        ("daily_total", 0),
        ("patch_seen", 0),
        ("market_seen", 0),
        ("jackpot_seen", 0),
        // 1 = przy następnym wejściu do ekwipunku czeka karta, którą zabierze UFO
        ("ufo_visit", 0),
    ]
}

fn state_default(key: &str) -> i64 {
    state_keys().iter().find(|(k, _)| *k == key).map(|(_, v)| *v).unwrap_or(0)
}

pub async fn ensure_state(c: &mut Conn, uid: i64) -> sqlx::Result<()> {
    let (keys, vals): (Vec<String>, Vec<i64>) = state_keys().into_iter().map(|(k, v)| (k.to_owned(), v)).unzip();
    sqlx::query!(
        "INSERT INTO user_state (user_id, key, value) SELECT $1, k, v FROM UNNEST($2::text[], $3::bigint[]) AS t(k, v) \
         ON CONFLICT DO NOTHING",
        uid,
        &keys,
        &vals
    )
    .execute(c)
    .await?;
    Ok(())
}

pub type GameState = IndexMap<String, i64>;

pub async fn get_state(c: &mut Conn, uid: i64) -> sqlx::Result<GameState> {
    let mut st: GameState = state_keys().iter().map(|(k, v)| (k.to_string(), *v)).collect();
    let rows = sqlx::query!("SELECT key, value FROM user_state WHERE user_id = $1", uid).fetch_all(c).await?;
    st.extend(rows.into_iter().map(|r| (r.key, r.value)));
    Ok(st)
}

/// Saldo gracza (grosze)
pub async fn balance(c: &mut Conn, uid: i64) -> sqlx::Result<i64> {
    let v =
        sqlx::query_scalar!("SELECT value FROM user_state WHERE user_id = $1 AND key = 'balance'", uid).fetch_optional(c).await?;
    Ok(v.unwrap_or(g().starting_balance))
}

pub async fn add_state(c: &mut Conn, uid: i64, key: &str, delta: i64) -> sqlx::Result<()> {
    sqlx::query!(
        "INSERT INTO user_state (user_id, key, value) VALUES ($1, $2, $3) \
         ON CONFLICT (user_id, key) DO UPDATE SET value = user_state.value + $4",
        uid,
        key,
        state_default(key) + delta,
        delta
    )
    .execute(c)
    .await?;
    Ok(())
}

pub async fn set_state(c: &mut Conn, uid: i64, key: &str, value: i64) -> sqlx::Result<()> {
    sqlx::query!(
        "INSERT INTO user_state (user_id, key, value) VALUES ($1, $2, $3) \
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
        uid,
        key,
        value
    )
    .execute(c)
    .await?;
    Ok(())
}

/// Tajne karty, które gracz już odkrył
pub async fn discovered(c: &mut Conn, uid: i64) -> sqlx::Result<HashSet<String>> {
    let rows = sqlx::query_scalar!("SELECT person_id FROM user_discovered WHERE user_id = $1", uid).fetch_all(c).await?;
    Ok(rows.into_iter().collect())
}

pub async fn discover(c: &mut Conn, uid: i64, pid: &str) -> sqlx::Result<bool> {
    let r = sqlx::query!("INSERT INTO user_discovered (user_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", uid, pid)
        .execute(c)
        .await?;
    Ok(r.rows_affected() > 0)
}

// ---------------------------------------------------------------- skrzynki w ekwipunku

pub fn valid_chest_kind(cat: &Catalog, kind: &str) -> bool {
    cat.crates.get(kind).is_some_and(|c| !c.special) || g().money_kind(kind).is_some()
}

/// Skrzynki w ekwipunku: {rodzaj: ile}
pub type Chests = IndexMap<String, i32>;

pub async fn get_chests(c: &mut Conn, cat: &Catalog, uid: i64) -> sqlx::Result<Chests> {
    let rows = sqlx::query!("SELECT kind, count FROM user_chests WHERE user_id = $1 AND count > 0", uid).fetch_all(c).await?;
    Ok(rows.into_iter().filter(|r| valid_chest_kind(cat, &r.kind)).map(|r| (r.kind, r.count)).collect())
}

pub async fn add_chests(c: &mut Conn, uid: i64, kind: &str, delta: i64) -> sqlx::Result<()> {
    sqlx::query!(
        "INSERT INTO user_chests (user_id, kind, count) VALUES ($1, $2, 0) ON CONFLICT(user_id, kind) DO NOTHING",
        uid,
        kind
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        "UPDATE user_chests SET count = CASE WHEN count + $1 > 0 THEN count + $1 ELSE 0 END WHERE user_id = $2 AND kind = $3",
        delta as i32,
        uid,
        kind
    )
    .execute(c)
    .await?;
    Ok(())
}

pub async fn has_access(c: &mut Conn, uid: i64, crate_id: &str) -> sqlx::Result<bool> {
    Ok(sqlx::query!("SELECT 1 AS one FROM crate_access WHERE user_id = $1 AND crate_id = $2", uid, crate_id)
        .fetch_optional(c)
        .await?
        .is_some())
}

/// Czy gracz może KUPIĆ tę skrzynkę (otwieranie posiadanych skrzynek jest zawsze możliwe)
pub async fn can_buy(c: &mut Conn, me: &User, cr: &crate::catalog::Crate) -> sqlx::Result<bool> {
    if cr.special {
        return Ok(false); // skrzynka kart specjalnych - nie da się jej kupić (nawet adminowi)
    }
    if me.admin() {
        return Ok(true);
    }
    Ok(cr.shop && (!cr.restricted || has_access(c, me.id, &cr.id).await?))
}

// ---------------------------------------------------------------- karty graczy

/// Karta gracza (wiersz items)
#[derive(Debug, Clone)]
pub struct ItemRow {
    pub id: i64,
    pub person_id: String,
    pub variant: String,
    pub favorite: i32,
    pub created_at: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ItemJson {
    pub id: i64,
    pub person: String,
    pub variant: String,
    pub value: i64,
    pub created: f64,
    pub fav: bool,
}

pub fn item_json(cat: &Catalog, r: &ItemRow) -> Option<ItemJson> {
    let p = cat.person(&r.person_id)?; // karta usunięta z katalogu
    let variant = if g().is_variant(&r.variant) { r.variant.clone() } else { "normal".into() };
    Some(ItemJson {
        id: r.id,
        person: p.id.clone(),
        value: p.value(&variant),
        variant,
        created: r.created_at,
        fav: r.favorite != 0,
    })
}

pub fn row_value(cat: &Catalog, r: &ItemRow) -> i64 {
    cat.person(&r.person_id).map(|p| p.value(&r.variant)).unwrap_or(0)
}

/// Nowa karta gracza (jak insert_item w app.py) - z "first": gracz pierwszy w Hall of Fame
#[derive(Debug, Clone, Serialize)]
pub struct NewItem {
    pub id: i64,
    pub person: String,
    pub variant: String,
    pub value: i64,
    pub created: f64,
    pub fav: bool,
    pub first: bool,
}

pub async fn my_items(c: &mut Conn, cat: &Catalog, uid: i64) -> sqlx::Result<Vec<ItemJson>> {
    let rows = sqlx::query_as!(
        ItemRow,
        "SELECT id, person_id, variant, favorite, created_at FROM items WHERE user_id = $1 ORDER BY id DESC",
        uid
    )
    .fetch_all(c)
    .await?;
    Ok(rows.iter().filter_map(|r| item_json(cat, r)).collect())
}

pub async fn item_by_id(c: &mut Conn, id: i64) -> sqlx::Result<Option<ItemRow>> {
    sqlx::query_as!(ItemRow, "SELECT id, person_id, variant, favorite, created_at FROM items WHERE id = $1", id)
        .fetch_optional(c)
        .await
}

/// Karta trafia na stałe do klasera gracza (zostaje tam także po sprzedaży). Zapamiętujemy, kiedy i skąd gracz
/// zdobył ją pierwszy raz (drop / contract / upgrade / casino; transfer = rynek, jackpot; trade = wymiana).
/// true, gdy gracz ma ją pierwszy raz.
pub async fn note_collected(c: &mut Conn, uid: i64, pid: &str, variant: &str, source: &str) -> sqlx::Result<bool> {
    let added = sqlx::query!(
        "INSERT INTO user_collected (user_id, person_id, variant, at, source) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        uid,
        pid,
        variant,
        now(),
        source
    )
    .execute(c)
    .await?
    .rows_affected();
    Ok(added == 1)
}

pub async fn collected_list(c: &mut Conn, cat: &Catalog, uid: i64) -> sqlx::Result<Vec<(String, String)>> {
    let rows = sqlx::query!("SELECT person_id, variant FROM user_collected WHERE user_id = $1", uid).fetch_all(c).await?;
    Ok(rows.into_iter().filter(|r| cat.has(&r.person_id)).map(|r| (r.person_id, r.variant)).collect())
}

/// Nowa karta gracza (source: drop = ze skrzynki, contract, upgrade, joker = karta specjalna z kasyna, link = z linku
/// od admina - do Hall of Fame; casino - zwykła wygrana w kasynie, bez Hall of Fame)
pub async fn insert_item(c: &mut Conn, cx: &Ctx, pid: &str, variant: &str, source: &str) -> sqlx::Result<NewItem> {
    let now = now();
    let new_for_me = note_collected(c, cx.uid(), pid, variant, source).await?;
    crate::achievements::count_card(c, cx.uid(), &cx.cat.people[pid], variant).await?;
    let id = sqlx::query_scalar!(
        "INSERT INTO items (person_id, holo, variant, created_at, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        pid,
        (variant != "normal") as i32,
        variant,
        now,
        cx.uid()
    )
    .fetch_one(&mut *c)
    .await?;
    let first =
        if source != "casino" { note_hall_of_fame(c, cx, pid, variant, source, now, new_for_me).await? } else { false };
    Ok(NewItem {
        id,
        person: pid.into(),
        variant: variant.into(),
        value: cx.cat.people[pid].value(variant),
        created: now,
        fav: false,
        first,
    })
}

/// Hall of Fame: kto pierwszy zdobył tę kartę w tym wariancie (i kiedy) + ile ich w ogóle wypadło.
/// true, gdy gracz trafia do Hall of Fame jako pierwszy (ukryci gracze się nie liczą - liczy się pierwszy widoczny).
/// new_for_me: gracz nie miał wcześniej tej karty w tym wariancie (note_collected).
async fn note_hall_of_fame(
    c: &mut Conn,
    cx: &Ctx,
    pid: &str,
    variant: &str,
    source: &str,
    now: f64,
    new_for_me: bool,
) -> sqlx::Result<bool> {
    let inserted = sqlx::query!(
        "INSERT INTO hall_of_fame (person_id, variant, first_user_id, first_at, source, drops) \
         VALUES ($1, $2, $3, $4, $5, 0) ON CONFLICT (person_id, variant) DO NOTHING",
        pid,
        variant,
        cx.uid(),
        now,
        source
    )
    .execute(&mut *c)
    .await?
    .rows_affected();
    sqlx::query!("UPDATE hall_of_fame SET drops = drops + 1 WHERE person_id = $1 AND variant = $2", pid, variant)
        .execute(&mut *c)
        .await?;
    if cx.me.hidden_from_ranking() {
        return Ok(false);
    }
    if inserted == 1 {
        return Ok(true);
    }
    // karta jest już w Hall of Fame - tak samo jak strona Hall of Fame: pierwszy jest gracz z tabeli, a tylko gdy to
    // gracz ukryty w rankingu, pierwszy widoczny z user_collected (hof_first). Gracz, który miał już tę kartę (choćby
    // z kasyna albo z rynku), nie jest "pierwszy" przy kolejnej sztuce.
    let holder: Option<i64> =
        sqlx::query_scalar::<_, Option<i64>>("SELECT first_user_id FROM hall_of_fame WHERE person_id = $1 AND variant = $2")
            .bind(pid)
            .bind(variant)
            .fetch_one(&mut *c)
            .await?;
    let hidden = hidden_users(&mut *c).await?;
    if !new_for_me || !holder.is_some_and(|u| hidden.contains(&u)) {
        return Ok(false);
    }
    // brak widocznego wpisu (stare wpisy bez daty, karta tylko z kasyna / rynku) NIE znaczy, że jestem pierwszy
    let first = hof_first(c, pid, variant, None).await?;
    Ok(first.is_some_and(|f| f.0 == cx.uid()))
}

pub async fn hidden_users(c: &mut Conn) -> sqlx::Result<HashSet<i64>> {
    let users = sqlx::query_as!(User, "SELECT * FROM users").fetch_all(c).await?;
    Ok(users.iter().filter(|u| u.hidden_from_ranking()).map(|u| u.id).collect())
}

/// Pierwszy widoczny gracz (nie ukryty w rankingu), który zdobył tę kartę z dropu, kontraktu albo ulepszacza:
/// (id, kiedy, skąd). Starsze wpisy bez źródła też się liczą (nieznane źródło = skrzynka).
pub async fn hof_first(
    c: &mut Conn,
    pid: &str,
    variant: &str,
    hidden: Option<&HashSet<i64>>,
) -> sqlx::Result<Option<(i64, f64, String)>> {
    let owned;
    let hidden = match hidden {
        Some(h) => h,
        None => {
            owned = hidden_users(c).await?;
            &owned
        }
    };
    let rows = sqlx::query!(
        r#"SELECT user_id, at AS "at!", source FROM user_collected WHERE person_id = $1 AND variant = $2 AND at IS NOT NULL
           AND (source IS NULL OR source IN ('drop', 'contract', 'upgrade', 'joker', 'link')) ORDER BY at"#,
        pid,
        variant
    )
    .fetch_all(c)
    .await?;
    Ok(rows
        .into_iter()
        .find(|r| !hidden.contains(&r.user_id))
        .map(|r| (r.user_id, r.at, r.source.unwrap_or_else(|| "drop".into()))))
}

/// Odkrywa tajne karty i wrzuca legendarne+ do aktywności znajomych. Zwraca nowo odkryte id.
pub async fn note_drops(c: &mut Conn, cx: &Ctx, items: &[(String, String)], kind: &str) -> sqlx::Result<Vec<String>> {
    let g = g();
    let feed_rarity = g.rarity_idx("gold");
    let mut new = vec![];
    for (pid, variant) in items {
        let rarity = &cx.cat.people[pid].rarity;
        if rarity == "secret" && discover(c, cx.uid(), pid).await? {
            new.push(pid.clone());
        }
        if g.rarity_idx(rarity) >= feed_rarity {
            sqlx::query!(
                "INSERT INTO feed (author_id, to_user_id, kind, person_id, variant, created_at) VALUES ($1, NULL, $2, $3, $4, $5)",
                cx.uid(),
                kind,
                pid,
                variant,
                now()
            )
            .execute(&mut *c)
            .await?;
        }
    }
    Ok(new)
}

pub fn drops_of(items: &[NewItem]) -> Vec<(String, String)> {
    items.iter().map(|i| (i.person.clone(), i.variant.clone())).collect()
}

/// Wiersze moich kart o podanych id albo None, jeśli czegoś brakuje
pub async fn owned_rows(c: &mut Conn, cat: &Catalog, uid: i64, ids: &[i64]) -> sqlx::Result<Option<Vec<ItemRow>>> {
    let unique: HashSet<&i64> = ids.iter().collect();
    if ids.is_empty() || unique.len() != ids.len() {
        return Ok(None);
    }
    let rows = sqlx::query_as!(
        ItemRow,
        "SELECT id, person_id, variant, favorite, created_at FROM items WHERE user_id = $1 AND id = ANY($2)",
        uid,
        ids
    )
    .fetch_all(c)
    .await?;
    if rows.len() != ids.len() || rows.iter().any(|r| !cat.has(&r.person_id)) {
        return Ok(None);
    }
    Ok(Some(rows))
}

pub async fn delete_items(c: &mut Conn, uid: i64, ids: &[i64]) -> sqlx::Result<()> {
    sqlx::query!("DELETE FROM items WHERE user_id = $1 AND id = ANY($2)", uid, ids).execute(&mut *c).await?;
    sqlx::query!("DELETE FROM showcase WHERE user_id = $1 AND item_id = ANY($2)", uid, ids).execute(c).await?;
    Ok(())
}

/// Co gracz robi z kartami - karty specjalne nie mogą przepaść
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Use {
    /// wystawienie na rynek - karta zostaje w grze
    Market,
    /// stawka w kasynie - karta może przepaść
    Stake,
}

/// Moje karty bez gwiazdki; stawka w kasynie - bez kart specjalnych. Inaczej błąd z komunikatem dla gracza.
pub async fn take_my_items(c: &mut Conn, cat: &Catalog, uid: i64, ids: &[i64], usage: Use) -> Res<Vec<ItemRow>> {
    let rows = owned_rows(c, cat, uid, ids).await?.ok_or_else(|| AppError::bad("Nie masz tych kart"))?;
    if rows.iter().any(|r| r.favorite != 0) {
        return bad(FAV_ERROR);
    }
    if usage == Use::Stake && rows.iter().any(|r| cat.people[&r.person_id].is_special()) {
        return bad(SPECIAL_ERROR);
    }
    Ok(rows)
}

/// Karty na czas transakcji należą do ESCROW
pub async fn escrow_items(c: &mut Conn, uid: i64, ids: &[i64]) -> sqlx::Result<()> {
    sqlx::query!("UPDATE items SET user_id = $1, favorite = 0 WHERE user_id = $2 AND id = ANY($3)", ESCROW, uid, ids)
        .execute(&mut *c)
        .await?;
    sqlx::query!("DELETE FROM showcase WHERE item_id = ANY($1)", ids).execute(c).await?;
    Ok(())
}

/// Karty przechodzą do gracza: bez gwiazdki, poza gablotą, trafiają do klasera, tajne są od razu odkryte
pub async fn give_items(c: &mut Conn, cat: &Catalog, ids: &[i64], uid: i64, source: &str) -> sqlx::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query!("UPDATE items SET user_id = $1, favorite = 0 WHERE id = ANY($2)", uid, ids).execute(&mut *c).await?;
    sqlx::query!("DELETE FROM showcase WHERE item_id = ANY($1)", ids).execute(&mut *c).await?;
    let rows = sqlx::query!("SELECT person_id, variant FROM items WHERE id = ANY($1)", ids).fetch_all(&mut *c).await?;
    for r in rows {
        let (pid, variant) = (r.person_id, r.variant);
        note_collected(c, uid, &pid, &variant, source).await?;
        if cat.person(&pid).is_some_and(|p| p.is_secret()) {
            discover(c, uid, &pid).await?;
        }
    }
    Ok(())
}

pub async fn showcase_ids(c: &mut Conn, uid: i64) -> sqlx::Result<Vec<i64>> {
    sqlx::query_scalar!(
        "SELECT s.item_id FROM showcase s JOIN items i ON i.id = s.item_id AND i.user_id = s.user_id \
         WHERE s.user_id = $1 ORDER BY s.pos",
        uid
    )
    .fetch_all(c)
    .await
}

// ---------------------------------------------------------------- znajomi

pub async fn friend_ids(c: &mut Conn, uid: i64) -> sqlx::Result<HashSet<i64>> {
    let rows = sqlx::query_scalar!(
        r#"SELECT addressee_id AS "id!" FROM friendships WHERE requester_id = $1 AND status = 'accepted'
           UNION SELECT requester_id FROM friendships WHERE addressee_id = $1 AND status = 'accepted'"#,
        uid
    )
    .fetch_all(c)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Relacja między graczami
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Relation {
    Me,
    None,
    Friend,
    /// moje zaproszenie czeka na odpowiedź
    Outgoing,
    /// zaproszenie do mnie
    Incoming,
}

pub async fn relation(c: &mut Conn, me: i64, other: i64) -> sqlx::Result<Relation> {
    if me == other {
        return Ok(Relation::Me);
    }
    let r = sqlx::query!(
        "SELECT requester_id, status FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) \
         OR (requester_id = $2 AND addressee_id = $1)",
        me,
        other
    )
    .fetch_optional(c)
    .await?
    .map(|r| (r.requester_id, r.status));
    Ok(match r {
        None => Relation::None,
        Some((_, s)) if s == "accepted" => Relation::Friend,
        Some((req, _)) if req == me => Relation::Outgoing,
        Some(_) => Relation::Incoming,
    })
}

// ---------------------------------------------------------------- statystyki kolekcji

#[derive(Default)]
pub struct Stats {
    pub value: i64,
    pub unique: HashSet<String>,
    pub total: i64,
}

/// Wartość kolekcji i liczba unikalnych kart dla wszystkich graczy
pub async fn collection_stats(c: &mut Conn, cat: &Catalog) -> sqlx::Result<HashMap<i64, Stats>> {
    let rows = sqlx::query!(r#"SELECT user_id AS "user_id!", person_id, variant FROM items WHERE user_id IS NOT NULL"#)
        .fetch_all(c)
        .await?;
    let mut stats: HashMap<i64, Stats> = std::collections::HashMap::new();
    for r in rows {
        let (uid, pid, variant) = (r.user_id, r.person_id, r.variant);
        let Some(p) = cat.person(&pid) else { continue };
        let s = stats.entry(uid).or_default();
        s.value += p.value(&variant);
        s.unique.insert(pid);
        s.total += 1;
    }
    Ok(stats)
}

/// Gracz + wartość jego kolekcji (listy znajomych, ranking, profil)
#[derive(Debug, Clone, Serialize)]
pub struct UserBrief {
    #[serde(flatten)]
    pub user: UserView,
    pub value: i64,
    pub unique: usize,
    pub total: i64,
}

impl UserBrief {
    pub fn new(cat: &Catalog, u: &User, stats: &HashMap<i64, Stats>) -> UserBrief {
        let s = stats.get(&u.id);
        UserBrief {
            user: u.view(cat),
            value: s.map_or(0, |s| s.value),
            unique: s.map_or(0, |s| s.unique.len()),
            total: s.map_or(0, |s| s.total),
        }
    }
}

pub async fn users_by_id(
    c: &mut Conn,
    cat: &Catalog,
    ids: impl IntoIterator<Item = Option<i64>>,
) -> sqlx::Result<IndexMap<i64, UserView>> {
    let mut ids: Vec<i64> = ids.into_iter().flatten().filter(|i| *i != 0).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(IndexMap::new());
    }
    let users = sqlx::query_as!(User, "SELECT * FROM users WHERE id = ANY($1)", &ids).fetch_all(c).await?;
    Ok(users.iter().map(|u| (u.id, u.view(cat))).collect())
}

pub async fn log_admin(c: &mut Conn, admin: &User, action: &str, target: Option<i64>, details: &str) -> sqlx::Result<()> {
    let target_name = match target {
        Some(t) => sqlx::query_scalar!("SELECT username FROM users WHERE id = $1", t).fetch_optional(&mut *c).await?,
        None => None,
    };
    sqlx::query!(
        "INSERT INTO admin_log (created_at, admin_id, admin_name, action, target_id, target_name, details) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        now(),
        admin.id,
        admin.username,
        action,
        target,
        target_name.unwrap_or_default(),
        details.truncate_chars(300)
    )
    .execute(c)
    .await?;
    Ok(())
}
