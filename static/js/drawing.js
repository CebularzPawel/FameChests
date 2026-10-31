"use strict";
// Czysta kartka (wariant blank): właściciel rysuje na karcie myszą albo palcem na dwóch warstwach - tło (pod zdjęciem
// i napisami) i zdjęcie - i wybiera kolor tła. Rysunek należy do egzemplarza karty (/drawing/<id>/..., routes/drawings.rs),
// więc idzie za kartą do kolejnych właścicieli. Edytor otwiera się z podglądu karty w ekwipunku.

const DRV = {};                    // numer wersji rysunku po zapisie (żeby przeglądarka nie pokazała starego)
const DR_BG = [504, 704];          // rozmiar warstwy tła (proporcje karty 63 x 88)
const DR_PHOTO_W = 440;            // szerokość warstwy zdjęcia, wysokość wg proporcji zdjęcia na karcie
const DR_UNDO = 15;
const DR_INKS = ["#111111", "#ffffff", "#e8202f", "#ff8a00", "#ffd21a", "#3ddc84", "#1f9bff", "#7a3dff", "#ff4fb5", "#8a5a2a"];
const DR_PAPERS = ["#ffffff", "#fff3d6", "#ffd6e6", "#d6ecff", "#d8ffe6", "#e8e0ff", "#2a2a33", "#111111"];

const isBlank = v => variantParts(v || "").includes("blank");
const drawUrl = (uid, layer) => `/drawing/${uid}/${layer}?v=${DRV[uid] || 0}`;
// warstwy gotowego rysunku na karcie
const drawingBG = (variant, uid) => isBlank(variant) && +uid > 0 ? `<img class="dr-flat" src="${drawUrl(uid, "flat")}" alt="" loading="lazy" draggable="false">` : "";
const drawingPhoto = (variant, uid) => isBlank(variant) && +uid > 0 ? `<img class="dr-ph" src="${drawUrl(uid, "photo")}" alt="" loading="lazy" draggable="false">` : "";

function loadImage(src) {
  return new Promise(ok => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = src; });
}

async function openDrawing(uid) {
  const it = S.items.find(i => i.id === uid);
  if (!it || !isBlank(it.variant)) return toast("To nie jest twoja karta", true);
  let info;
  try { info = await api(`/api/items/${uid}/drawing`); } catch (e) { return toast(e.message, true); }
  closeViewer();
  const D = { layer: "photo", erase: false, ink: "#111111", size: 1.4, paper: info.color, undo: [], dirty: false };
  const el = document.createElement("div");
  el.className = "dr-editor";
  el.innerHTML = `
    <div class="dr-stage"><div class="dr-card">${cardHTML(it.person, it.variant, 0)}<div class="dr-input"></div></div></div>
    <div class="dr-tools">
      <h3>🖌️ Czysta kartka</h3>
      <div class="seg dr-seg"><button data-layer="photo" class="active">🖼️ Zdjęcie</button><button data-layer="bg">📄 Tło</button></div>
      <div class="dr-row"><span>Kolor</span><div class="dr-swatches">${DR_INKS.map(c => `<button class="dr-sw" data-ink="${c}" style="background:${c}" title="${c}"></button>`).join("")}
        <input type="color" id="drInk" value="${D.ink}" title="Własny kolor"></div></div>
      <label class="dr-row"><span>Grubość</span><input type="range" id="drSize" min=".4" max="8" step=".2" value="${D.size}"></label>
      <div class="dr-row"><span>Tło karty</span><div class="dr-swatches">${DR_PAPERS.map(c => `<button class="dr-sw" data-paper="${c}" style="background:${c}" title="${c}"></button>`).join("")}
        <input type="color" id="drPaper" value="${esc(D.paper)}" title="Własny kolor tła"></div></div>
      <div class="dr-btns">
        <button class="btn" data-dr="erase">🧽 Gumka</button>
        <button class="btn" data-dr="undo">↩️ Cofnij</button>
        <button class="btn" data-dr="clear">🗑️ Wyczyść warstwę</button>
      </div>
      <div class="dr-btns">
        <button class="btn primary" data-dr="save">💾 Zapisz</button>
        <button class="btn" data-dr="cancel">✕ Anuluj</button>
      </div>
      <p class="muted small">Rysunek zostaje na tej karcie także wtedy, gdy trafi do innego gracza.</p>
    </div>`;
  document.body.appendChild(el);
  updateCovered();

  // karta na cały dostępny obszar: szerokość wg miejsca na ekranie (--cw skaluje wszystkie napisy)
  const stage = $(".dr-stage", el), wrap = $(".dr-card", el), card = $(".card", el);
  const cw = Math.floor(Math.min(stage.clientWidth - 16, (stage.clientHeight - 16) * 63 / 88, 460));
  wrap.style.width = cw + "px";
  card.style.setProperty("--cw", cw + "px");
  card.style.width = cw + "px";
  const inner = $(".card-inner, .sc", card), photo = $(".card-photo, .sc-art", card);
  card.style.setProperty("--dr-color", D.paper);

  const canvas = (w, h, cls, box, first) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h; c.className = cls;
    box[first ? "prepend" : "append"](c);
    return c;
  };
  const cBg = canvas(DR_BG[0], DR_BG[1], "dr-c dr-c-bg", inner, true);
  const pr = photo.getBoundingClientRect();
  const cPh = canvas(DR_PHOTO_W, Math.round(DR_PHOTO_W * pr.height / pr.width), "dr-c dr-c-ph", photo);
  const ctx = c => c.getContext("2d", { willReadFrequently: true });
  for (const [c, layer] of [[cBg, "bg"], [cPh, "photo"]]) {
    const im = info.v ? await loadImage(`/drawing/${uid}/${layer}?v=${info.v}`) : null;
    if (im && im.width > 1) ctx(c).drawImage(im, 0, 0, c.width, c.height);
  }

  const target = () => D.layer === "bg" ? { cv: cBg, box: inner } : { cv: cPh, box: photo };
  const setLayer = l => {
    D.layer = l;
    card.classList.toggle("dr-mode-bg", l === "bg");
    card.classList.toggle("dr-mode-ph", l === "photo");
    $$(".dr-seg button", el).forEach(b => b.classList.toggle("active", b.dataset.layer === l));
  };
  setLayer("photo");
  const setPaper = c => { D.paper = c; D.dirty = true; $("#drPaper").value = c; card.style.setProperty("--dr-color", c); };
  const setErase = on => { D.erase = on; $("[data-dr=erase]", el).classList.toggle("primary", on); };
  const pushUndo = cv => {
    D.undo.push({ cv, data: ctx(cv).getImageData(0, 0, cv.width, cv.height) });
    if (D.undo.length > DR_UNDO) D.undo.shift();
    D.dirty = true;
  };
  const close = () => { el.remove(); updateCovered(); };

  // rysowanie: wskaźnik łapie nakładka nad kartą, punkt przeliczamy na piksele wybranej warstwy
  const input = $(".dr-input", el);
  let stroke = null;
  const point = (e, t) => {
    const r = t.box.getBoundingClientRect();
    return [(e.clientX - r.left) * t.cv.width / r.width, (e.clientY - r.top) * t.cv.height / r.height];
  };
  const segment = (t, a, b) => {
    const g = ctx(t.cv), r = t.box.getBoundingClientRect();
    g.globalCompositeOperation = D.erase ? "destination-out" : "source-over";
    g.strokeStyle = D.ink;
    g.lineWidth = D.size / 100 * cw * t.cv.width / r.width * (D.erase ? 2.5 : 1);
    g.lineCap = g.lineJoin = "round";
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
  };
  input.addEventListener("pointerdown", e => {
    e.preventDefault();
    input.setPointerCapture(e.pointerId);
    const t = target();
    pushUndo(t.cv);
    stroke = { t, last: point(e, t) };
    segment(t, stroke.last, stroke.last);
  });
  input.addEventListener("pointermove", e => {
    if (!stroke) return;
    const evs = e.getCoalescedEvents?.();
    for (const ev of evs?.length ? evs : [e]) {
      const p = point(ev, stroke.t);
      segment(stroke.t, stroke.last, p);
      stroke.last = p;
    }
  });
  const end = () => { stroke = null; };
  input.addEventListener("pointerup", end);
  input.addEventListener("pointercancel", end);

  $("#drInk").addEventListener("input", e => { D.ink = e.target.value; setErase(false); });
  $("#drPaper").addEventListener("input", e => setPaper(e.target.value));
  $("#drSize").addEventListener("input", e => { D.size = +e.target.value; });
  $(".dr-tools", el).addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.layer) return setLayer(b.dataset.layer);
    if (b.dataset.ink) { D.ink = b.dataset.ink; $("#drInk").value = D.ink; return setErase(false); }
    if (b.dataset.paper) return setPaper(b.dataset.paper);
    const act = b.dataset.dr;
    if (act === "erase") return setErase(!D.erase);
    if (act === "undo") {
      const u = D.undo.pop();
      if (u) ctx(u.cv).putImageData(u.data, 0, 0);
      return;
    }
    if (act === "clear") {
      const t = target();
      pushUndo(t.cv);
      ctx(t.cv).clearRect(0, 0, t.cv.width, t.cv.height);
      return;
    }
    if (act === "cancel") {
      if (!D.dirty || confirm("Porzucić zmiany na tej karcie?")) close();
      return;
    }
    if (act === "save") {
      b.disabled = true;
      try {
        const res = await api(`/api/items/${uid}/drawing`, { color: D.paper, bg: cBg.toDataURL("image/png"), photo: cPh.toDataURL("image/png") });
        DRV[uid] = res.v;
        S.drawn[res.drawn ? "add" : "delete"](uid);
        close();
        toast("🖌️ Rysunek zapisany");
        if (currentView() === "inventory") renderInventory();
        openViewer(it.person, it.variant, uid);
      } catch (err) { b.disabled = false; toast(err.message, true); }
    }
  });
}
