// ocr.js — Solo folio/fecha/total (con preprocesado, Tesseract e IA opcional)

const DBG = { lines: [], notes: [] };
function dbgNote(s) { try { DBG.notes.push(String(s)); } catch {} }
function dbgDump() {
  const el = document.getElementById("ocrDebug");
  if (!el) return;
  el.textContent =
    "[NOTAS]\n" + DBG.notes.join("\n") +
    "\n\n[LINEAS]\n" + DBG.lines.map((s, i) => `${String(i).padStart(2, "0")}: ${s}`).join("\n");
}

/* ====== IA ====== */
// Opción A (directo): coloca tu API key aquí si NO usarás proxy
const OPENAI_API_KEY = ""; // ej. "sk-proj-xxxx"
// Opción B (proxy en Cloud Run/Functions) — recomendado en cliente web
const OPENAI_PROXY_ENDPOINT = window.OPENAI_PROXY_ENDPOINT || "";

/* ====== UI helpers ====== */
function setIABadge(state, msg) {
  const el = document.getElementById('iaBadge');
  if (!el) return;
  if (state === 'ok')      { el.style.background = '#2e7d32'; el.textContent = `IA: OK ${msg||''}`; }
  else if (state === 'err'){ el.style.background = '#c62828'; el.textContent = `IA: ERROR ${msg||''}`; }
  else                     { el.style.background = '#444';    el.textContent = `IA: ${msg||'esperando…'}`; }
}

/* ====== Utils num/fecha/folio/total ====== */
function fixOcrDigits(s) {
  return s
    .replace(/(?<=\d)[Oo](?=\d)/g, "0")
    .replace(/(?<=\d)S(?=\d)/g, "5")
    .replace(/(?<=\d)[lI](?=\d)/g, "1");
}
function splitLines(text) {
  const arr = String(text || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((s) => fixOcrDigits(s.replace(/\s{2,}/g, " ").trim()))
    .filter(Boolean);
  DBG.lines = arr.slice();
  return arr;
}
function normalizeNum(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d.,-]/g, "").trim();
  if (!s) return null;

  if (s.includes(",") && s.includes(".")) {
    // Determina el separador decimal por la última aparición
    if (s.lastIndexOf(".") > s.lastIndexOf(",")) s = s.replace(/,/g, "");
    else s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    // Si termina con ,dd asumimos decimal
    const m = s.match(/,\d{2}$/);
    s = m ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? +n.toFixed(2) : null;
}
function extractDateISO(text) {
  const m = String(text || "").match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if (!m) return "";
  let d = +m[1], mo = +m[2], y = +m[3];
  // Corrige confusión d/m si viene volteado
  if (d <= 12 && mo > 12) [d, mo] = [mo, d];
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  dbgNote(`Fecha detectada: ${iso}`);
  return iso;
}
function extractFolio(lines) {
  const isDate = (s) => /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/.test(s);
  const isTime = (s) => /(\d{1,2}):(\d{2})\s*(am|pm)?/i.test(s);
  const iD = lines.findIndex(isDate);
  const iT = lines.findIndex(isTime);
  const iM = lines.findIndex((s) => /\bmesero\b|\bmesa\b|\bclientes?\b/i.test(s));
  const anchor = (iD >= 0 || iT >= 0) ? Math.max(iD, iT) : -1;
  const from = Math.max(iM >= 0 ? iM : 0, anchor >= 0 ? anchor : 0);
  const to = Math.min(lines.length - 1, from + 6);

  const pick5 = (s) => {
    if (/cp\s*\d{5}/i.test(s)) return null; // no confundir CP como folio
    const m = s.match(/\b(\d{5})\b/g);
    return m ? m[m.length - 1] : null;
  };

  for (let i = from; i <= to; i++) {
    const c = pick5(lines[i]);
    if (c) { dbgNote(`Folio 5d detectado @${i}: ${c}`); return c; }
  }
  // Fallback: primeros bloques con 3-7 dígitos
  for (let i = 0; i < Math.min(15, lines.length); i++) {
    const m = lines[i].match(/\b(\d{3,7})\b/);
    if (m) { dbgNote(`Folio alterno @${i}: ${m[1]}`); return m[1]; }
  }
  dbgNote("Folio no encontrado");
  return "";
}
function detectGrandTotal(lines) {
  const isCard = (s) => /\b(visa|master|amex|tarjeta|card)\b/i.test(s);
  const TOTAL_RX = /(total( a pagar)?|importe total|total mxn|total con propina)\b/i;

  // 1) buscar una línea “TOTAL … <importe>”
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (isCard(l)) continue;
    if (TOTAL_RX.test(l) && !/sub|iva|imp\.?t|impt|impuesto/i.test(l)) {
      const mm = l.match(/(\$?\s*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\$?\s*\d+(?:[.,]\d{2}))/g);
      if (mm && mm.length) {
        const v = normalizeNum(mm[mm.length - 1]);
        if (v != null) { dbgNote(`Total (TOTAL_RX): ${v}`); return v; }
      }
    }
  }
  // 2) fallback: el número mayor con decimales al final del ticket
  const nums = [];
  lines.forEach((l) => {
    if (isCard(l)) return;
    const mm = l.match(/(\$?\s*[0-9]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\$?\s*\d+(?:[.,]\d{2}))/g);
    if (mm) mm.forEach((v) => { const p = normalizeNum(v); if (p != null) nums.push(p); });
  });
  if (nums.length) {
    const t = Math.max(...nums);
    dbgNote(`Total (máximo): ${t}`);
    return t;
  }
  dbgNote("Total no encontrado");
  return null;
}

/* ====== PREPROCESADO IMAGEN ====== */
async function preprocessImage(file) {
  const bmp = await createImageBitmap(file);
  let w = bmp.width, h = bmp.height, rotate = false;
  if (w > h * 1.6) rotate = true; // horizontales largas → rotamos

  const targetH = 2800;
  const scale = Math.max(1.4, Math.min(3.2, targetH / (rotate ? w : h)));

  const c = document.createElement("canvas");
  if (rotate) { c.width = Math.round(h * scale); c.height = Math.round(w * scale); }
  else { c.width = Math.round(w * scale); c.height = Math.round(h * scale); }

  const ctx = c.getContext("2d");
  ctx.filter = "grayscale(1) contrast(1.35) brightness(1.05)";
  if (rotate) {
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(bmp, -w * scale / 2, -h * scale / 2, w * scale, h * scale);
  } else {
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
  }

  // Binzarización adaptativa si está OpenCV
  if (typeof cv !== "undefined" && cv?.Mat) {
    try {
      let src = cv.imread(c);
      let gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      let bw = new cv.Mat();
      cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 35, 5);
      cv.imshow(c, bw);
      src.delete(); gray.delete(); bw.delete();
    } catch (e) {
      console.warn("OpenCV preprocess falló:", e);
    }
  }
  return c;
}

/* ====== Tesseract ====== */
async function runTesseract(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.97));
  const { data } = await Tesseract.recognize(blob, "spa+eng", {
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1",
    user_defined_dpi: "360",
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-:#/$., ",
  });
  return data.text || "";
}

/* ====== IA (solo folio, fecha, total) ====== */
async function callOpenAI(rawText) {
  if (!OPENAI_API_KEY && !OPENAI_PROXY_ENDPOINT) {
    setIABadge('err', '(sin clave/proxy)');
    throw new Error("No hay API KEY ni proxy configurado");
  }

  const sys =
`Eres un parser de tickets de Applebee's (México).
Debes responder **solo** JSON válido con este shape exacto:
{
  "folio": "string (5-7 dígitos o vacío si no se ve)",
  "fecha": "YYYY-MM-DD (o vacío)",
  "total": number
}
Reglas:
- No inventes datos; si no se ve, deja "" o 0.
- "total" debe ser el GRAN TOTAL del ticket (no subtotal ni propina).
- Responde SOLO el JSON, sin texto adicional.`;

  const user = `Texto OCR sin modificar:\n${rawText}\n\nResponde SOLO el JSON indicado.`;

  const started = performance.now();
  setIABadge(null, 'llamando…');

  try {
    // Proxy (recomendado)
    if (OPENAI_PROXY_ENDPOINT) {
      const resp = await fetch(OPENAI_PROXY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawText, sys })
      });
      const took = Math.round(performance.now() - started);
      if (!resp.ok) {
        const txt = await resp.text().catch(()=> '');
        setIABadge('err', `HTTP ${resp.status}`);
        dbgNote(`IA(proxy) ERROR ${resp.status} en ${took}ms: ${txt}`);
        throw new Error("Proxy IA respondió error: " + resp.status);
      }
      const j = await resp.json();
      setIABadge('ok', `${took}ms`);
      dbgNote(`IA(proxy) OK en ${took}ms`);
      return j;
    }

    // Llamada directa a OpenAI (si configuraste API key)
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      })
    });

    const took = Math.round(performance.now() - started);
    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      setIABadge('err', `HTTP ${resp.status}`);
      dbgNote(`IA(Direct) ERROR ${resp.status} en ${took}ms: ${txt}`);
      throw new Error("OpenAI error: " + txt);
    }

    const data = await resp.json();
    setIABadge('ok', `${took}ms`);
    dbgNote(`IA(Direct) OK en ${took}ms`);
    const content = data.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  } catch (e) {
    setIABadge('err', 'excepción');
    throw e;
  }
}

/* ====== Proceso principal (expuesto) ====== */
async function processTicketWithIA(file) {
  const statusEl = document.getElementById("ocrStatus");
  if (statusEl) {
    statusEl.textContent = "🕐 Escaneando ticket…";
    statusEl.className = "validacion-msg";
  }

  try {
    DBG.notes = []; DBG.lines = [];

    const canvas = await preprocessImage(file);
    const text = await runTesseract(canvas);
    dbgNote("OCR listo, longitud: " + text.length);

    let folio = "", fecha = "", total = null;

    // 1) Intento con IA (si está configurada)
    try {
      const ia = await callOpenAI(text);
      dbgNote("IA respondió OK");
      if (ia && typeof ia === "object") {
        folio = String(ia.folio || "");
        fecha = String(ia.fecha || "");
        total = typeof ia.total === "number" ? ia.total : normalizeNum(ia.total);
        if (statusEl) statusEl.textContent = "IA OK. Afinando con parser local…";
      }
    } catch (iaErr) {
      console.warn("IA falló, usando parser local:", iaErr);
    }

    // 2) Fallback / afinado local
    const lines = splitLines(text);
    if (!folio) folio = extractFolio(lines) || "";
    if (!fecha) fecha = extractDateISO(text) || "";
    if (!Number.isFinite(total) || total <= 0) {
      total = detectGrandTotal(lines);
    }

    // 3) Mensaje y depuración
    if (statusEl) {
      if (folio || fecha || Number.isFinite(total)) {
        statusEl.className = "validacion-msg ok";
        statusEl.textContent = "✓ Ticket procesado. Verifica y presiona “Registrar”.";
      } else {
        statusEl.className = "validacion-msg err";
        statusEl.textContent = "❌ No se pudo leer el ticket. Intenta otra foto.";
      }
    }
    dbgDump();

    return { text, folio, fecha, total };

  } catch (e) {
    console.error(e);
    const statusEl2 = document.getElementById("ocrStatus");
    if (statusEl2) {
      statusEl2.className = "validacion-msg err";
      statusEl2.textContent =
        "❌ No pude leer el ticket. Intenta con mejor luz o que salga completo.";
    }
    alert("No se pudo leer el ticket. Vuelve a tomar la foto más cerca, recto y con buena luz.");
    return { text: "", folio: "", fecha: "", total: null };
  }
}

// Exponer la función globalmente para registrar.js
window.processTicketWithIA = processTicketWithIA;
