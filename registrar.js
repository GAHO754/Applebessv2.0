// registrar.js — RTDB + Cámara + OCR AUTO (sin productos) + puntos 10..35 por total
(() => {
  console.log("[registrar.js] cargado");  // 🔹 para verificar en consola

  const $ = id => document.getElementById(id);

  // ===== Firebase =====
  const auth = firebase.auth();
  const db   = firebase.database();

  // ===== UI =====
  const fileInput    = $('ticketFile');
  const dropzone     = $('dropzone');
  const btnPickFile  = $('btnSeleccionarArchivo');
  const btnCam       = $('btnAbrirCamara');
  const modal        = $('cameraModal');
  const btnClose     = $('btnCerrarCamara');
  const video        = $('cameraVideo');
  const btnShot      = $('btnCapturar');
  const ocrStatus    = $('ocrStatus');

  const iNum   = $('inputTicketNumero');   // folio
  const iFecha = $('inputTicketFecha');    // <input type="date">
  const iTotal = $('inputTicketTotal');    // total

  const btnRegistrar = $('btnRegistrarTicket');
  const msgTicket    = $('ticketValidacion');
  const greetEl      = $('userGreeting');

  const elDisp = $('ptsDisponibles');
  const elResv = $('ptsReservados');
  const elTot  = $('ptsTotales');
  const tbody  = $('tbodyTickets');
  const toast  = $('awardToast');

  const btnBack = $('btnLogout'); // botón “Regresar”

  // ===== Parámetros de negocio =====
  const VENCE_DIAS   = 180;
  const DAY_LIMIT    = 2;
  const MIN_POINTS   = 10;
  const MAX_POINTS   = 35;
  const MIN_SPEND    = 120;
  const MAX_SPEND    = 1200;

  let liveStream = null;
  let currentPreviewURL = null;
  let unsub = [];

  function setStatus(msg, type='') {
    if (!ocrStatus) return;
    ocrStatus.className = 'validacion-msg';
    if (type) ocrStatus.classList.add(type);
    ocrStatus.textContent = msg || '';
  }

  function disableAllEdits() {
    [iNum,iFecha,iTotal].forEach(x=>{
      if(x){
        x.readOnly = true;
        x.disabled = true;
        x.value = '';
      }
    });
    if (btnRegistrar) btnRegistrar.disabled = true;
  }

  function enableEdits() {
    [iNum,iFecha,iTotal].forEach(x=>{
      if(x){
        x.readOnly = false;
        x.disabled = false;
      }
    });
    if (btnRegistrar) btnRegistrar.disabled = false;
  }

  function setPreview(file) {
    if (currentPreviewURL) URL.revokeObjectURL(currentPreviewURL);
    const url = URL.createObjectURL(file);
    currentPreviewURL = url;
    dropzone?.querySelectorAll('img.preview').forEach(n => n.remove());
    if (dropzone) {
      const img = document.createElement('img');
      img.className = 'preview';
      img.alt = 'Vista previa ticket';
      img.src = url;
      dropzone.appendChild(img);
    }
  }

  function dataURLtoBlob(dataURL) {
    const [meta, b64] = dataURL.split(',');
    const mime = meta.split(':')[1].split(';')[0];
    const bin = atob(b64);
    const ab = new ArrayBuffer(bin.length);
    const ia = new Uint8Array(ab);
    for (let i=0;i<bin.length;i++) ia[i] = bin.charCodeAt(i);
    return new Blob([ab], { type: mime });
  }

  function setFileInputFromBlob(blob, name='ticket.jpg') {
    const file = new File([blob], name, { type: blob.type||'image/jpeg', lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    if (fileInput) fileInput.files = dt.files;
    setPreview(file);
    return file;
  }

  function computePointsFromTotal(total) {
    if (!Number.isFinite(total) || total <= 0) return MIN_POINTS;
    const clamped = Math.max(MIN_SPEND, Math.min(MAX_SPEND, total));
    const t = (clamped - MIN_SPEND) / (MAX_SPEND - MIN_SPEND);
    const pts = Math.round(MIN_POINTS + t * (MAX_POINTS - MIN_POINTS));
    return Math.max(MIN_POINTS, Math.min(MAX_POINTS, pts));
  }

  async function waitForOCR(tries = 30, delayMs = 100) {
    for (let i = 0; i < tries; i++) {
      if (typeof window.processTicketWithIA === "function") return true;
      await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
  }

  async function autoProcessCurrentFile() {
    const file = fileInput?.files?.[0];
    if (!file) {
      setStatus("Sube o toma la foto del ticket primero.", "err");
      return;
    }
    const ready = await waitForOCR();
    if (!ready) {
      console.warn("[autoProcess] OCR no listo (processTicketWithIA no encontrada)");
      setStatus("No se pudo iniciar el OCR. Revisa la consola.", "err");
      return;
    }
    try {
      setStatus("🕐 Escaneando ticket…");
      const ret = await window.processTicketWithIA(file);

      enableEdits();

      if (ret?.folio && /^\d{5,7}$/.test(ret.folio) && iNum)   iNum.value   = ret.folio;
      if (ret?.fecha && /^\d{4}-\d{2}-\d{2}$/.test(ret.fecha) && iFecha) iFecha.value = ret.fecha;
      if (Number.isFinite(ret?.total) && iTotal) iTotal.value = Number(ret.total).toFixed(2);

      const folioTxt = iNum?.value || "(sin folio)";
      const fechaTxt = iFecha?.value || "(sin fecha)";
      const totalTxt = iTotal?.value ? `$${Number(iTotal.value).toFixed(2)}` : "(sin total)";
      setStatus(`✓ Ticket leído. Folio: ${folioTxt} · Fecha: ${fechaTxt} · Total: ${totalTxt}`, "ok");

      if (iNum) iNum.scrollIntoView({ behavior:'smooth', block:'center' });

      if (iNum?.value && iFecha?.value && iTotal?.value) {
        btnRegistrar && (btnRegistrar.disabled = false);
      }
    } catch (e) {
      console.error("[autoProcess] Error al procesar:", e);
      setStatus("Falló el OCR. Intenta de nuevo.", "err");
    }
  }

  // ===== Cámara =====
  async function openCamera() {
    console.log("[registrar.js] openCamera click");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("Tu navegador no soporta cámara. Usa Adjuntar foto.", "err"); return;
      }
      video.muted = true;
      video.setAttribute('playsinline','true');
      video.setAttribute('muted','true');

      const tries = [
        { video:{ facingMode:{exact:"environment"}, width:{ideal:1920}, height:{ideal:1080} }, audio:false },
        { video:{ facingMode:{ideal:"environment"},  width:{ideal:1920}, height:{ideal:1080} }, audio:false },
        { video:true, audio:false }
      ];
      let stream=null,lastErr=null;
      for (const c of tries){ try{ stream=await navigator.mediaDevices.getUserMedia(c); break; } catch(e){ lastErr=e; } }
      if (!stream) throw lastErr||new Error("No se pudo abrir la cámara");

      liveStream=stream; video.srcObject=stream;
      modal.style.display='flex'; modal.setAttribute('aria-hidden','false');
      await video.play().catch(()=>{});
      setStatus('');
    } catch(e){
      console.error("getUserMedia:",e);
      let msg="No se pudo acceder a la cámara. Revisa permisos del navegador.";
      if ((!window.isSecureContext && location.hostname!=='localhost') || (location.protocol!=='https:' && location.hostname!=='localhost')){
        msg+=" (En móviles abre el sitio con HTTPS).";
      }
      setStatus(msg,"err");
      fileInput?.click();
    }
  }

  function stopCamera(){
    if (liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream=null; }
    modal.style.display='none'; modal.setAttribute('aria-hidden','true');
  }

  async function captureFrame(){
    const w=video.videoWidth, h=video.videoHeight;
    if (!w||!h){ setStatus("Cámara aún no lista. Intenta de nuevo.","err"); return; }
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const ctx = c.getContext('2d');
    ctx.filter = "contrast(1.15) brightness(1.05) saturate(1.05)";
    ctx.drawImage(video,0,0,w,h);
    stopCamera();
    const dataURL=c.toDataURL("image/jpeg",.95);
    const blob=dataURLtoBlob(dataURL);
    setFileInputFromBlob(blob,`ticket_${Date.now()}.jpg`);
    setStatus("📎 Foto capturada. Procesando OCR…","ok");
    await autoProcessCurrentFile();
  }

  btnCam?.addEventListener('click', openCamera);
  btnClose?.addEventListener('click', stopCamera);
  btnShot?.addEventListener('click', captureFrame);

  // ===== Subir archivo =====
  btnPickFile?.addEventListener('click', ()=> fileInput?.click());
  fileInput?.addEventListener('change', async e=>{
    const f=e.target.files&&e.target.files[0];
    if (f){
      setPreview(f);
      setStatus("📎 Imagen cargada. Procesando OCR…","ok");
      await autoProcessCurrentFile();
    }
  });

  if (dropzone) {
    dropzone.addEventListener('click', ()=> fileInput?.click());
    dropzone.addEventListener('dragover', e => {
      e.preventDefault(); dropzone.classList.add('drag');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', async e => {
      e.preventDefault(); dropzone.classList.remove('drag');
      if (e.dataTransfer.files?.length) {
        const dt = new DataTransfer();
        dt.items.add(e.dataTransfer.files[0]);
        fileInput.files = dt.files;
        setPreview(e.dataTransfer.files[0]);
        setStatus("📎 Imagen cargada. Procesando OCR…","ok");
        await autoProcessCurrentFile();
      }
    });
  }

  function fmtDate(ms){
    if(!ms) return '';
    try{
      return new Date(ms).toLocaleDateString('es-MX',{year:'numeric',month:'2-digit',day:'2-digit'});
    }catch{ return '' }
  }

  function renderTickets(list){
    if (!tbody) return;
    if (!list.length){
      tbody.innerHTML = `<tr><td colspan="5" class="muted">No hay tickets aún.</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(t=>`
      <tr>
        <td>${t.fecha || ''}</td>
        <td>${t.folio || ''}</td>
        <td>$${(t.total||0).toFixed(2)}</td>
        <td><b>${t.puntos||0}</b></td>
        <td>${fmtDate(t.vence)||''}</td>
      </tr>
    `).join('');
  }

  // ===== Cálculo de puntos disponibles / reservados (igual que panel.html) =====
async function computeAvailable(uid){
  try{
    const [pSnap, rSnap] = await Promise.all([
      db.ref(`users/${uid}/points`).once('value'),
      db.ref(`users/${uid}/redemptions`).once('value')
    ]);
    const base = Number(pSnap.val()||0);  // puntos base (los 109)
    const now = Date.now();
    const reds = rSnap.val()||{};
    let reserved = 0;
    Object.values(reds).forEach(r=>{
      const st = String(r.status||'').toLowerCase();
      const expOk = !r.expiresAt || Number(r.expiresAt)>now;
      if (st==='pendiente' && expOk) reserved += Number(r.cost||0);
    });
    const visibles = Math.max(0, base - reserved);

    if (elDisp) elDisp.textContent = String(visibles);  // 🔹 Disponibles
    if (elResv) elResv.textContent = String(reserved);  // 🔹 Reservados
  }catch(e){
    console.warn('computeAvailable error', e);
  }
}

function attachUserStreams(uid){
  if (!uid) return;
  // Limpia listeners anteriores
  unsub.forEach(fn=>{ try{fn();}catch{} });
  unsub = [];

  // Puntos base
  const pRef = db.ref(`users/${uid}/points`);
  pRef.on('value', snap=>{
    const val = Number(snap.val()||0);
    // primero muestra el raw mientras se recalcula
    if (elDisp) elDisp.textContent = String(val);
    computeAvailable(uid);   // 🔹 esto ajusta Disponibles/Reservados
  });
  unsub.push(()=> pRef.off());

  // Cupones para reservados
  const rRef = db.ref(`users/${uid}/redemptions`);
  rRef.on('value', ()=> computeAvailable(uid));
  unsub.push(()=> rRef.off());

  // Tickets (lista y acumulados)
  const tRef = db.ref(`users/${uid}/tickets`);
  tRef.on('value', snap=>{
    const val = snap.val()||{};
    const arr = Object.values(val).map(v=>({
      folio: v.folio,
      fecha: v.fecha,
      total: Number(v.total||0),
      puntos: Number(v.points||v.puntosTotal||v.puntos?.total||0),
      vence: Number(v.vencePuntos||0),
      createdAt: Number(v.createdAt||0)
    }));
    arr.sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));
    renderTickets(arr.slice(0,12));
    const sum = arr.reduce((a,x)=> a + (x.puntos||0), 0);

    if (elTot) elTot.textContent = String(sum);  // 🔹 Acumulados
  });
  unsub.push(()=> tRef.off());
}

  
  function addMonths(date, months){
    const d=new Date(date.getTime());
    d.setMonth(d.getMonth()+months);
    return d;
  }

  function startEndOfToday(){
    const s=new Date(); s.setHours(0,0,0,0);
    const e=new Date(); e.setHours(23,59,59,999);
    return {start:s.getTime(), end:e.getTime()};
  }

  function ymdFromISO(iso){
    return String(iso||'').replace(/-/g,'');
  }

  async function registrarTicketRTDB(){
    const user=auth.currentUser;
    if (!user){
      msgTicket.className='validacion-msg err';
      msgTicket.textContent="Debes iniciar sesión para registrar.";
      return;
    }

    const folio=(iNum.value||'').trim().toUpperCase();
    const fechaStr=iFecha.value;
    const totalNum=parseFloat(iTotal.value||"0")||0;

    if (!/^\d{5,7}$/.test(folio) || !fechaStr || !totalNum){
      msgTicket.className='validacion-msg err';
      msgTicket.textContent="Faltan datos válidos: folio, fecha y total.";
      return;
    }

    if (DAY_LIMIT>0){
      try{
        const {start,end}=startEndOfToday();
        const qs=db.ref(`users/${user.uid}/tickets`)
          .orderByChild('createdAt').startAt(start).endAt(end);
        const snap=await qs.once('value');
        const countToday=snap.exists()?Object.keys(snap.val()).length:0;
        if (countToday>=DAY_LIMIT){
          msgTicket.className='validacion-msg err';
          msgTicket.textContent=`⚠️ Ya registraste ${DAY_LIMIT} tickets hoy.`;
          return;
        }
      }catch(err){ console.warn('No pude verificar límite diario:',err); }
    }

    const puntosEnteros = computePointsFromTotal(totalNum);

    const fecha=new Date(`${fechaStr}T00:00:00`);
    const vencePuntos=addMonths(fecha, Math.round(VENCE_DIAS/30));
    const userRef   = db.ref(`users/${user.uid}`);
    const ticketRef = userRef.child(`tickets/${folio}`);
    const pointsRef = userRef.child('points');

    const ymd = ymdFromISO(fechaStr);
    const indexRef = db.ref(`ticketsIndex/${ymd}/${folio}`);

    try{
      const idxTx = await indexRef.transaction(curr=>{
        if (curr) return;
        return { uid:user.uid, createdAt:Date.now() };
      });
      if (!idxTx.committed){
        msgTicket.className='validacion-msg err';
        msgTicket.textContent="❌ Este folio ya fue registrado para esa fecha.";
        return;
      }

      const res = await ticketRef.transaction(current=>{
        if (current) return;
        return {
          folio,
          fecha: fechaStr,
          total: totalNum,
          puntosTotal: puntosEnteros,
          points: puntosEnteros,
          vencePuntos: vencePuntos.getTime(),
          createdAt: Date.now()
        };
      });
      if (!res.committed){
        msgTicket.className='validacion-msg err';
        msgTicket.textContent="❌ Este ticket ya está en tu cuenta.";
        return;
      }

      await pointsRef.transaction(curr => (Number(curr)||0) + puntosEnteros);

      try {
        localStorage.setItem('panelAward', JSON.stringify({
          ts: Date.now(),
          folio,
          puntos: puntosEnteros,
          total: totalNum
        }));
      } catch {}

      msgTicket.className='validacion-msg ok';
      msgTicket.textContent=`✅ Ticket registrado con éxito. Acumulaste ${puntosEnteros} puntos.`;
      setTimeout(()=>{ window.location.href='panel.html'; }, 1200);
    }catch(e){
      console.error(e);
      msgTicket.className='validacion-msg err';
      if (String(e).includes('Permission denied')){
        msgTicket.textContent="Permiso denegado por Realtime Database. Revisa las reglas.";
      }else{
        msgTicket.textContent="No se pudo registrar el ticket. Revisa tu conexión e inténtalo de nuevo.";
      }
    }
  }

  auth.onAuthStateChanged(user=>{
  unsub.forEach(fn=>{ try{fn();}catch{} });
  unsub = [];

  if (!user){
    window.location.href = 'index.html';
    return;
  }
  if (greetEl) greetEl.textContent = `Registro de ticket — ${user.email}`;

  // 🔹 IMPORTANTE: esto es lo que sincroniza los puntos en tiempo real
  attachUserStreams(user.uid);
});


  btnRegistrar?.addEventListener('click', registrarTicketRTDB);

  // 🔹 Botón “Regresar” → panel.html
  btnBack?.addEventListener('click', () => {
    console.log("[registrar.js] click Regresar → panel.html");
    window.location.href = 'panel.html';
  });

  disableAllEdits();

  window.addEventListener("error", (e) => {
    console.error("[window error]", e.error || e.message || e);
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[promise rejection]", e.reason || e);
  });
})();
