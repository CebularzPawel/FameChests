//! Zdjęcia kart (port images.py): Wikipedia (główne), Wikimedia Commons / inne Wikipedie (alternatywne),
//! upload i URL z panelu admina, lżejsze wersje WebP do wysyłania, flagi krajów z flagcdn.com.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use image::{DynamicImage, ImageDecoder, ImageReader};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::Value;

use crate::db::now;

const USER_AGENT: &str = "CelebCrates/1.0 (private hobby project; rust-reqwest)";
const THUMB_SIZE: u32 = 500;
pub const MAX_UPLOAD: usize = 8 * 1024 * 1024;
const EXTS: [(&str, &str); 4] = [("jpg", "image/jpeg"), ("png", "image/png"), ("webp", "image/webp"), ("gif", "image/gif")];
const BAD_WORDS: &[&str] = &[
    "signature",
    "podpis",
    "logo",
    "coat",
    "herb",
    "flag",
    "flaga",
    "map",
    "mapa",
    "autograph",
    "grave",
    "grób",
    "tomb",
    "stamp",
    "coin",
    "banknote",
    "plaque",
    "tablica",
    "poster",
    "plakat",
    "document",
    "dokument",
    "letter",
    "scan",
    "page",
    "strona",
    "certificate",
    "akt ",
    "book",
    "ksiega",
    "księga",
    "newspaper",
    "gazeta",
    "family",
    "rodzin",
    "house",
    "dom ",
    "church",
    "kości",
    "monument",
    "pomnik",
    "statue",
    "mural",
    "painting",
    "obraz",
    "car ",
    "plane",
    "samolot",
];
// Małe kafelki (bęben skrzynki, kuźnia, kasyno, rynek) dostają miniaturę WebP zamiast pełnego zdjęcia; duże pliki
// (np. PNG wgrane w panelu admina) idą jako lżejszy WebP. Pliki robią się przy pierwszym użyciu w image_cache/_web.
const THUMB_WIDTH: u32 = 240;
const FULL_WIDTH: u32 = 600;
const BIG_FILE: u64 = 120 * 1024;
const ALT_LANGS: &[&str] = &["en", "pl", "de", "fr", "es", "it", "ru", "uk", "cs", "nl", "pt", "sv", "fi", "hu"];
static FLAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z]{2}(-[a-z0-9]{1,3})?$").unwrap());

/// Które zdjęcie karty: główne, alternatywne albo własne zdjęcie wariantu (np. "rzulty")
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Kind {
    Main,
    Alt,
    Variant(String),
}

impl Kind {
    fn suffix(&self) -> String {
        match self {
            Kind::Main => String::new(),
            Kind::Alt => "__alt".into(),
            Kind::Variant(v) => format!("__{v}"),
        }
    }
}

pub struct Images {
    pub cache_dir: PathBuf,
    http: reqwest::Client,
    failed: Mutex<HashMap<(String, Kind), f64>>,
    flag_failed: Mutex<HashMap<String, f64>>,
    fetch_lock: tokio::sync::Mutex<()>,
    web_lock: Mutex<()>,
}

pub fn mimetype(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    EXTS.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m).unwrap_or("image/jpeg")
}

pub fn sniff(blob: &[u8]) -> Option<&'static str> {
    if blob.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if blob.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if blob.len() >= 12 && &blob[..4] == b"RIFF" && &blob[8..12] == b"WEBP" {
        Some("webp")
    } else if blob.starts_with(b"GIF87a") || blob.starts_with(b"GIF89a") {
        Some("gif")
    } else {
        None
    }
}

fn norm(name: &str) -> String {
    name.replace('_', " ").replace("File:", "").replace("Plik:", "").trim().to_lowercase()
}

fn usable(fname: &str) -> bool {
    let n = norm(fname);
    [".jpg", ".jpeg", ".png", ".webp"].iter().any(|e| n.ends_with(e)) && !BAD_WORDS.iter().any(|b| n.contains(b))
}

fn mtime(path: &Path) -> Option<f64> {
    std::fs::metadata(path).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs_f64())
}

/// Wersja zdjęcia (czas pliku) - do adresów ?v=
pub fn file_mtime(path: &Path) -> f64 {
    mtime(path).unwrap_or(0.0)
}

impl Images {
    pub fn new(data_dir: &Path) -> Self {
        let http = reqwest::Client::builder().user_agent(USER_AGENT).timeout(Duration::from_secs(20)).build().expect("http");
        Images {
            cache_dir: data_dir.join("image_cache"),
            http,
            failed: Mutex::default(),
            flag_failed: Mutex::default(),
            fetch_lock: tokio::sync::Mutex::new(()),
            web_lock: Mutex::new(()),
        }
    }

    fn stem(&self, pid: &str, kind: &Kind) -> PathBuf {
        self.cache_dir.join(format!("{pid}{}", kind.suffix()))
    }

    /// Ścieżka do zapisanego zdjęcia albo None
    pub fn find(&self, pid: &str, kind: &Kind) -> Option<PathBuf> {
        if pid.contains('/') || pid.contains('\\') || pid.contains("..") {
            return None;
        }
        let stem = self.stem(pid, kind);
        EXTS.iter().map(|(e, _)| PathBuf::from(format!("{}.{e}", stem.display()))).find(|p| p.exists())
    }

    // ------------------------------------------------------------ zapis / usuwanie

    pub fn save(&self, pid: &str, blob: &[u8], kind: &Kind) -> Result<(), String> {
        let ext = sniff(blob).ok_or("To nie jest obsługiwany obrazek (JPG, PNG, WEBP, GIF)")?;
        if blob.len() > MAX_UPLOAD {
            return Err("Plik jest za duży (max 8 MB)".into());
        }
        std::fs::create_dir_all(&self.cache_dir).map_err(|e| e.to_string())?;
        self.delete(pid, kind);
        std::fs::write(format!("{}.{ext}", self.stem(pid, kind).display()), blob).map_err(|e| e.to_string())?;
        self.failed.lock().remove(&(pid.to_owned(), kind.clone()));
        Ok(())
    }

    pub async fn save_url(&self, pid: &str, url: &str, kind: &Kind) -> Result<(), String> {
        let lower = url.to_lowercase();
        if !lower.starts_with("http://") && !lower.starts_with("https://") {
            return Err("Adres musi zaczynać się od http:// lub https://".into());
        }
        let blob = self.get(url, 4).await.map_err(|e| e.to_string())?;
        self.save(pid, &blob, kind)
    }

    pub fn delete(&self, pid: &str, kind: &Kind) {
        for (e, _) in EXTS {
            let _ = std::fs::remove_file(format!("{}.{e}", self.stem(pid, kind).display()));
        }
    }

    /// Usuwa pliki <pid>__<nazwa>.* poza nazwami z keep (np. wgrane naklejki wariantu, których admin nie zapisał)
    pub fn delete_other(&self, pid: &str, keep: &std::collections::HashSet<String>) {
        let prefix = format!("{pid}__");
        let Ok(dir) = std::fs::read_dir(&self.cache_dir) else { return };
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix(&prefix) else { continue };
            let stem = rest.rsplit_once('.').map_or(rest, |(s, _)| s);
            if !keep.contains(stem) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    // ------------------------------------------------------------ pobieranie

    /// GET z ponawianiem przy 429 (Wikimedia ogranicza tempo pobierania)
    async fn get(&self, url: &str, retries: u32) -> anyhow::Result<Vec<u8>> {
        for attempt in 0..retries {
            let resp = self.http.get(url).send().await?;
            if resp.status().as_u16() == 429 && attempt + 1 < retries {
                tokio::time::sleep(Duration::from_secs(3 * 2u64.pow(attempt))).await;
                continue;
            }
            return Ok(resp.error_for_status()?.bytes().await?.to_vec());
        }
        anyhow::bail!("za dużo prób")
    }

    async fn api(&self, base: &str, params: &[(&str, String)]) -> anyhow::Result<Value> {
        let query = {
            let mut q = form_urlencoded::Serializer::new(String::new());
            for (k, v) in params {
                q.append_pair(k, v);
            }
            q.append_pair("format", "json");
            q.finish()
        };
        let blob = self.get(&format!("{base}?{query}"), 4).await?;
        Ok(serde_json::from_slice(&blob)?)
    }

    /// Strony Wikipedii dla tytułów (z przekierowaniami): {tytuł z karty: strona}
    async fn query_pages(&self, lang: &str, titles: &[String], props: &[(&str, &str)]) -> anyhow::Result<HashMap<String, Value>> {
        let mut params: Vec<(&str, String)> = vec![
            ("action", "query".into()),
            ("formatversion", "2".into()),
            ("redirects", "1".into()),
            ("titles", titles.join("|")),
        ];
        params.extend(props.iter().map(|(k, v)| (*k, v.to_string())));
        let res = self.api(&format!("https://{lang}.wikipedia.org/w/api.php"), &params).await?;
        let q = &res["query"];
        let mut alias: Vec<(String, String)> = titles.iter().map(|t| (t.clone(), t.clone())).collect();
        for key in ["normalized", "redirects"] {
            for m in q[key].as_array().into_iter().flatten() {
                let (from, to) = (m["from"].as_str().unwrap_or(""), m["to"].as_str().unwrap_or(""));
                for (_, cur) in alias.iter_mut() {
                    if cur == from {
                        *cur = to.to_owned();
                    }
                }
            }
        }
        let by_title: HashMap<&str, &Value> =
            q["pages"].as_array().into_iter().flatten().filter_map(|p| Some((p["title"].as_str()?, p))).collect();
        Ok(alias
            .into_iter()
            .map(|(orig, fin)| (orig, by_title.get(fin.as_str()).map(|v| (*v).clone()).unwrap_or(Value::Null)))
            .collect())
    }

    /// Pobiera brakujące główne zdjęcia z Wikipedii. people: (id, (język, tytuł artykułu)). Zwraca {id: udało się}.
    pub async fn fetch(&self, people: &[(String, Option<(String, String)>)], force: bool) -> HashMap<String, bool> {
        let _ = std::fs::create_dir_all(&self.cache_dir);
        let mut results = HashMap::new();
        let mut by_lang: Vec<(String, Vec<(String, String)>)> = vec![];
        for (pid, wiki) in people {
            if !force && self.find(pid, &Kind::Main).is_some() {
                results.insert(pid.clone(), true);
                continue;
            }
            let Some((lang, title)) = wiki.clone().filter(|(_, t)| !t.is_empty()) else {
                results.insert(pid.clone(), false);
                continue;
            };
            match by_lang.iter_mut().find(|(l, _)| *l == lang) {
                Some((_, items)) => items.push((pid.clone(), title)),
                None => by_lang.push((lang, vec![(pid.clone(), title)])),
            }
        }
        for (lang, items) in by_lang {
            for chunk in items.chunks(50) {
                let titles: Vec<String> = chunk.iter().map(|(_, t)| t.clone()).collect();
                let pages = self
                    .query_pages(&lang, &titles, &[("prop", "pageimages"), ("piprop", "thumbnail"), ("pithumbsize", "500")])
                    .await
                    .unwrap_or_else(|e| {
                        tracing::warn!("[zdjęcia] błąd API ({lang}): {e}");
                        HashMap::new()
                    });
                for (pid, title) in chunk {
                    let src = pages.get(title).and_then(|p| p["thumbnail"]["source"].as_str()).map(str::to_owned);
                    let mut ok = false;
                    if let Some(src) = src {
                        match self.get(&src, 4).await.map_err(|e| e.to_string()).and_then(|b| self.save(pid, &b, &Kind::Main)) {
                            Ok(()) => {
                                ok = true;
                                tokio::time::sleep(Duration::from_millis(300)).await;
                            }
                            Err(e) => tracing::warn!("[zdjęcia] nie udało się pobrać {pid}: {e}"),
                        }
                    } else {
                        tracing::info!("[zdjęcia] brak zdjęcia w artykule: {lang}:{title}");
                    }
                    results.insert(pid.clone(), ok);
                    if !ok {
                        self.failed.lock().insert((pid.clone(), Kind::Main), now());
                    }
                }
            }
        }
        results
    }

    /// Ścieżka do zdjęcia (alternatywne wraca do głównego) albo None - brakujące główne pobiera z Wikipedii
    pub async fn ensure(&self, pid: &str, wiki: Option<(String, String)>, alt: bool) -> Option<PathBuf> {
        if alt {
            if let Some(p) = self.find(pid, &Kind::Alt) {
                return Some(p);
            }
        }
        if let Some(p) = self.find(pid, &Kind::Main) {
            return Some(p);
        }
        let last = self.failed.lock().get(&(pid.to_owned(), Kind::Main)).copied().unwrap_or(0.0);
        if now() - last < 300.0 {
            return None;
        }
        {
            let _guard = self.fetch_lock.lock().await;
            if self.find(pid, &Kind::Main).is_none() {
                self.fetch(&[(pid.to_owned(), wiki)], false).await;
            }
        }
        self.find(pid, &Kind::Main)
    }

    /// Wszystkie brakujące zdjęcia + miniatury do bębna i kafelków (w tle, przy starcie)
    pub async fn prefetch_all(self: &Arc<Self>, people: Vec<(String, Option<(String, String)>)>) {
        let res = {
            let _guard = self.fetch_lock.lock().await;
            self.fetch(&people, false).await
        };
        tracing::info!("[zdjęcia] główne: {}/{}", res.values().filter(|x| **x).count(), res.len());
        for (pid, _) in &people {
            if let Some(p) = self.find(pid, &Kind::Main) {
                let _ = self.web_version_async(p, true).await;
            }
        }
    }

    // ------------------------------------------------------------ lżejsze wersje do wysyłania

    /// Plik do wysłania przeglądarce: miniatura (thumb) albo lżejszy WebP zamiast dużego pliku - lub sam oryginał
    pub fn web_version(&self, path: &Path, thumb: bool) -> PathBuf {
        let original = path.to_owned();
        if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("gif")) {
            return original;
        }
        let Ok(meta) = std::fs::metadata(path) else { return original };
        if !thumb && meta.len() <= BIG_FILE {
            return original;
        }
        let src_mtime = mtime(path).unwrap_or(0.0);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("x").replace('.', "_");
        let out = self.cache_dir.join("_web").join(format!("{name}{}.webp", if thumb { "__thumb" } else { "" }));
        let fresh = || mtime(&out).is_some_and(|m| m >= src_mtime);
        if fresh() {
            return out;
        }
        let _guard = self.web_lock.lock();
        if fresh() {
            return out; // w międzyczasie zrobił go inny wątek
        }
        match make_webp(path, &out, thumb) {
            Ok(()) => out,
            Err(e) => {
                tracing::warn!("[zdjęcia] nie udało się zmniejszyć {}: {e}", path.display());
                original
            }
        }
    }

    /// web_version poza wątkami serwera (zmniejszanie zdjęcia trwa)
    pub async fn web_version_async(self: &Arc<Self>, path: PathBuf, thumb: bool) -> PathBuf {
        let me = Arc::clone(self);
        let fallback = path.clone();
        tokio::task::spawn_blocking(move || me.web_version(&path, thumb)).await.unwrap_or(fallback)
    }

    // ------------------------------------------------------------ flagi krajów (wariant flagowy)

    /// Flaga kraju (kod ISO, np. "pl", "gb-eng") jako plik SVG - pobrana raz z flagcdn.com, potem z image_cache/flags.
    /// None: zły kod albo brak internetu (kolejna próba najwcześniej za 10 minut).
    pub async fn flag(&self, code: &str) -> Option<PathBuf> {
        let code = code.to_lowercase();
        if !FLAG_RE.is_match(&code) {
            return None;
        }
        let path = self.cache_dir.join("flags").join(format!("{code}.svg"));
        if path.exists() {
            return Some(path);
        }
        if now() - self.flag_failed.lock().get(&code).copied().unwrap_or(0.0) < 600.0 {
            return None;
        }
        let blob =
            match tokio::time::timeout(Duration::from_secs(10), self.get(&format!("https://flagcdn.com/{code}.svg"), 2)).await {
                Ok(Ok(b)) => b,
                _ => {
                    self.flag_failed.lock().insert(code, now());
                    return None;
                }
            };
        let head = &blob[..blob.len().min(3000)];
        if !head.windows(4).any(|w| w == b"<svg") {
            self.flag_failed.lock().insert(code, now());
            return None;
        }
        std::fs::create_dir_all(path.parent()?).ok()?;
        std::fs::write(&path, &blob).ok()?;
        Some(path)
    }

    // ------------------------------------------------------------ zdjęcie alternatywne (komenda fetch-images)
    // Źródła (po kolei): dodatkowe zdjęcia z Wikidata (P18), potem zdjęcia główne artykułów o tej osobie w innych
    // wersjach językowych Wikipedii - wszystkie to portrety tej osoby.

    fn alt_missing_file(&self) -> PathBuf {
        self.cache_dir.join("alt_missing.json")
    }

    /// Szuka drugiego (innego niż główne) zdjęcia osoby. Zwraca liczbę nowych zdjęć.
    pub async fn fetch_alt(&self, people: &[(String, Option<(String, String)>)], force: bool) -> usize {
        let mut missing: HashSet<String> = if force {
            HashSet::new()
        } else {
            std::fs::read_to_string(self.alt_missing_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
        };
        let wiki: HashMap<&String, &(String, String)> =
            people.iter().filter_map(|(p, w)| w.as_ref().filter(|w| !w.1.is_empty()).map(|w| (p, w))).collect();
        let todo: Vec<&String> = people
            .iter()
            .map(|(p, _)| p)
            .filter(|p| wiki.contains_key(p) && (force || (self.find(p, &Kind::Alt).is_none() && !missing.contains(*p))))
            .collect();
        if todo.is_empty() {
            return 0;
        }
        let (mut lead, mut qid, mut failed) = (HashMap::new(), Vec::<(String, String)>::new(), HashSet::new());

        // 1. główne zdjęcie i identyfikator Wikidata
        let mut by_lang: Vec<(String, Vec<(String, String)>)> = vec![];
        for pid in &todo {
            let (lang, title) = wiki[*pid].clone();
            match by_lang.iter_mut().find(|(l, _)| *l == lang) {
                Some((_, v)) => v.push(((*pid).clone(), title)),
                None => by_lang.push((lang, vec![((*pid).clone(), title)])),
            }
        }
        for (lang, items) in &by_lang {
            for chunk in items.chunks(50) {
                let titles: Vec<String> = chunk.iter().map(|(_, t)| t.clone()).collect();
                match self.query_pages(lang, &titles, &[("prop", "pageprops|pageimages"), ("piprop", "name")]).await {
                    Ok(pages) => {
                        for (pid, title) in chunk {
                            let pg = pages.get(title).cloned().unwrap_or(Value::Null);
                            lead.insert(pid.clone(), norm(pg["pageimage"].as_str().unwrap_or("")));
                            if let Some(q) = pg["pageprops"]["wikibase_item"].as_str() {
                                qid.push((pid.clone(), q.to_owned()));
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("[zdjęcia alt] błąd API ({lang}): {e}");
                        failed.extend(chunk.iter().map(|(p, _)| p.clone()));
                    }
                }
            }
        }

        // 2. Wikidata: zdjęcia (P18) i linki do innych wersji językowych
        let mut cands: HashMap<String, Vec<String>> = todo.iter().map(|p| ((*p).clone(), vec![])).collect();
        let mut sitelinks: HashMap<String, HashMap<String, String>> = HashMap::new();
        let ids: Vec<String> = qid.iter().map(|(_, q)| q.clone()).collect();
        for chunk in ids.chunks(50) {
            let sitefilter = ALT_LANGS.iter().map(|l| format!("{l}wiki")).collect::<Vec<_>>().join("|");
            let params = [
                ("action", "wbgetentities".to_owned()),
                ("props", "claims|sitelinks".to_owned()),
                ("ids", chunk.join("|")),
                ("sitefilter", sitefilter),
            ];
            let ents = match self.api("https://www.wikidata.org/w/api.php", &params).await {
                Ok(v) => v["entities"].clone(),
                Err(e) => {
                    tracing::warn!("[zdjęcia alt] błąd Wikidata: {e}");
                    failed.extend(qid.iter().filter(|(_, q)| chunk.contains(q)).map(|(p, _)| p.clone()));
                    continue;
                }
            };
            for (pid, q) in &qid {
                let ent = &ents[q];
                if ent.is_null() {
                    continue;
                }
                for c in ent["claims"]["P18"].as_array().into_iter().flatten() {
                    if let Some(f) = c["mainsnak"]["datavalue"]["value"].as_str() {
                        cands.entry(pid.clone()).or_default().push(f.to_owned());
                    }
                }
                if let Some(links) = ent["sitelinks"].as_object() {
                    sitelinks.insert(
                        pid.clone(),
                        links
                            .iter()
                            .filter_map(|(k, v)| Some((k.strip_suffix("wiki")?.to_owned(), v["title"].as_str()?.to_owned())))
                            .collect(),
                    );
                }
            }
        }

        // 3. zdjęcia główne z innych Wikipedii
        for lang in ALT_LANGS {
            let need: Vec<(String, String)> = todo
                .iter()
                .filter_map(|p| sitelinks.get(*p).and_then(|s| s.get(*lang)).map(|t| ((*p).clone(), t.clone())))
                .collect();
            for chunk in need.chunks(50) {
                let titles: Vec<String> = chunk.iter().map(|(_, t)| t.clone()).collect();
                match self.query_pages(lang, &titles, &[("prop", "pageimages"), ("piprop", "name")]).await {
                    Ok(pages) => {
                        for (pid, title) in chunk {
                            if let Some(f) = pages.get(title).and_then(|p| p["pageimage"].as_str()) {
                                cands.entry(pid.clone()).or_default().push(f.to_owned());
                            }
                        }
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    Err(e) => {
                        tracing::warn!("[zdjęcia alt] błąd API ({lang}): {e}");
                        failed.extend(chunk.iter().map(|(p, _)| p.clone()));
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        }

        // 4. pierwszy kandydat inny niż zdjęcie główne
        let mut found = 0;
        for pid in todo {
            let mut seen: HashSet<String> = [lead.get(pid).cloned().unwrap_or_default()].into();
            let mut pick = None;
            for f in cands.get(pid).into_iter().flatten() {
                let n = norm(f);
                if seen.contains(&n) || !usable(f) {
                    seen.insert(n);
                    continue;
                }
                pick = Some(f.clone());
                break;
            }
            if let Some(f) = pick {
                let url = format!(
                    "https://commons.wikimedia.org/wiki/Special:FilePath/{}?width={THUMB_SIZE}",
                    quote(&f.replace(' ', "_"))
                );
                match self.get(&url, 4).await.map_err(|e| e.to_string()).and_then(|b| self.save(pid, &b, &Kind::Alt)) {
                    Ok(()) => {
                        found += 1;
                        missing.remove(pid);
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                    Err(e) => tracing::warn!("[zdjęcia alt] {pid}: {e}"),
                }
            } else if !failed.contains(pid) {
                if force {
                    self.delete(pid, &Kind::Alt); // stare, nietrafione zdjęcie alt
                }
                missing.insert(pid.clone());
            }
        }
        let mut sorted: Vec<_> = missing.into_iter().collect();
        sorted.sort();
        let _ = std::fs::create_dir_all(&self.cache_dir);
        let _ = std::fs::write(self.alt_missing_file(), serde_json::to_string(&sorted).unwrap_or_default());
        found
    }
}

/// urllib.parse.quote (bez "/")
fn quote(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"_.-~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn make_webp(path: &Path, out: &Path, thumb: bool) -> anyhow::Result<()> {
    let mut decoder = ImageReader::open(path)?.with_guessed_format()?.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut im = DynamicImage::from_decoder(decoder)?;
    im.apply_orientation(orientation);
    let width = if thumb { THUMB_WIDTH } else { FULL_WIDTH };
    if im.width() > width {
        let h = ((im.height() as f64 * width as f64 / im.width() as f64).round_ties_even() as u32).max(1);
        im = im.resize_exact(width, h, image::imageops::FilterType::Lanczos3);
    }
    let im = if im.color().has_alpha() { DynamicImage::ImageRgba8(im.to_rgba8()) } else { DynamicImage::ImageRgb8(im.to_rgb8()) };
    let encoded = webp::Encoder::from_image(&im).map_err(|e| anyhow::anyhow!("{e}"))?.encode(if thumb { 80.0 } else { 85.0 });
    std::fs::create_dir_all(out.parent().unwrap_or(Path::new(".")))?;
    let tmp = out.with_extension("webp.tmp");
    std::fs::write(&tmp, &*encoded)?;
    std::fs::rename(&tmp, out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffing_and_names() {
        assert_eq!(sniff(b"\xff\xd8\xff\xe0..."), Some("jpg"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(sniff(b"<html>"), None);
        assert!(usable("File:Lech_Walesa_2009.jpg"));
        assert!(!usable("Signature of X.png"));
        assert_eq!(quote("Ąb c/d.jpg"), "%C4%84b%20c/d.jpg");
    }
}
