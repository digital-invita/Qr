(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const stage = $("cameraStage");
  const toggle = $("toggleScan");
  const toggleLabel = $("toggleLabel");
  const statusText = $("statusText");
  const emptyResult = $("emptyResult");
  const resultContent = $("resultContent");
  const resultCard = $("resultCard");
  const resultTitle = $("resultTitle");
  const resultIcon = $("resultIcon");
  const resultValue = $("resultValue");
  const openResult = $("openResult");
  const copyResult = $("copyResult");
  const clearResult = $("clearResult");
  const scanFlash = $("scanFlash");
  const flashCheck = $("flashCheck");
  const flashTitle = $("flashTitle");
  const flashSubtitle = $("flashSubtitle");
  const toast = $("toast");

  let qrScanner = null;
  let scannerRunning = false;
  let scannerPaused = false;
  let scanLocked = false;
  let fallbackTimer = 0;
  let fallbackBusy = false;
  let zxingPrepared = false;

  function say(message) {
    if (statusText) statusText.textContent = message;
  }

  function notify(message) {
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 2800);
  }

  function showScannerError(message) {
    stopQrScanner({ silent: true });
    say("No se pudo leer");
    notify(message);
  }

  async function startQrScanner() {
    if (scannerRunning) {
      await stopQrScanner();
      return;
    }

    if (qrScanner && scannerPaused) {
      resetResult();
      scanLocked = false;
      try {
        qrScanner.resume();
        scannerPaused = false;
        scannerRunning = true;
        stage.classList.add("is-active");
        toggleLabel.textContent = "Detener escaneo";
        say("Buscando código QR…");
        startCameraFallback();
        return;
      } catch (_) {
        await stopQrScanner({ silent: true });
      }
    }

    if (typeof window.Html5Qrcode !== "function") {
      showScannerError("El motor QR no pudo cargarse. Recarga la página e intenta nuevamente.");
      return;
    }

    resetResult();
    scanLocked = false;
    try {
      qrScanner = new window.Html5Qrcode("cameraReader", { verbose: false });
      await qrScanner.start(
        { facingMode: "environment" },
        {
          fps: 15,
          aspectRatio: 1,
          qrbox: (width, height) => {
            const size = Math.max(180, Math.floor(Math.min(width, height) * 0.72));
            return { width: size, height: size };
          }
        },
        handleDecodedQr,
        () => {}
      );
      scannerRunning = true;
      scannerPaused = false;
      stage.classList.add("is-active");
      toggleLabel.textContent = "Detener escaneo";
      say("Buscando código QR…");
      startCameraFallback();
    } catch (error) {
      await stopQrScanner({ silent: true });
      showScannerError(cameraErrorMessage(error));
    }
  }

  async function stopQrScanner({ silent = false } = {}) {
    if (qrScanner) {
      try {
        if (scannerRunning || scannerPaused) await qrScanner.stop();
      } catch (_) {}
      try { qrScanner.clear(); } catch (_) {}
    }
    qrScanner = null;
    scannerRunning = false;
    scannerPaused = false;
    window.clearInterval(fallbackTimer);
    fallbackTimer = 0;
    fallbackBusy = false;
    stage.classList.remove("is-active");
    toggleLabel.textContent = "Escanear código QR";
    if (!resultContent.hidden) return;
    say("Listo para escanear");
    if (!silent) notify("Escaneo detenido");
  }

  async function decodeQrFileWithRetries(file) {
    try {
      const primaryResult = await qrScanner.scanFile(file, true);
      if (String(primaryResult || "").trim()) return primaryResult;
    } catch (_) {}

    const zxingResult = await decodeFileWithZxing(file);
    if (zxingResult) return zxingResult;

    const jsQrResult = await decodeFileWithJsQr(file);
    if (jsQrResult) return jsQrResult;

    const candidates = await createQrCropCandidates(file);
    for (const candidate of candidates) {
      const zxingCandidate = await decodeFileWithZxing(candidate);
      if (zxingCandidate) return zxingCandidate;
      try {
        const primaryCandidate = await qrScanner.scanFile(candidate, true);
        if (String(primaryCandidate || "").trim()) return primaryCandidate;
      } catch (_) {}
      const jsQrCandidate = await decodeFileWithJsQr(candidate);
      if (jsQrCandidate) return jsQrCandidate;
    }
    throw new Error("QR no encontrado");
  }

  async function decodeFileWithZxing(file) {
    if (!window.ZXingWASM?.readBarcodes) return "";
    try {
      if (!zxingPrepared) {
        window.ZXingWASM.prepareZXingModule?.({
          overrides: {
            locateFile(path) {
              return path.endsWith(".wasm")
                ? new URL("./scanner-zxing_reader.wasm?v=3.1.3-local", document.baseURI).href
                : path;
            }
          }
        });
        zxingPrepared = true;
      }
      const results = await window.ZXingWASM.readBarcodes(file, {
        formats: ["QRCode"],
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        tryDownscale: true,
        maxNumberOfSymbols: 1,
        textMode: "Plain"
      });
      return results.find((result) => result?.isValid && result.text)?.text
        || results.find((result) => result?.text)?.text
        || "";
    } catch (_) {
      return "";
    }
  }

  async function decodeFileWithJsQr(file) {
    if (typeof window.jsQR !== "function") return "";
    let source = null;
    try {
      source = await loadImageSource(file);
      const regions = [
        { x: 0, y: 0, width: source.width, height: source.height },
        centeredSquareRegion(source.width, source.height, 0.96),
        centeredSquareRegion(source.width, source.height, 0.8)
      ];
      for (const region of regions) {
        const scale = Math.min(1, 1400 / Math.max(region.width, region.height));
        const work = document.createElement("canvas");
        work.width = Math.max(1, Math.round(region.width * scale));
        work.height = Math.max(1, Math.round(region.height * scale));
        const context = work.getContext("2d", { willReadFrequently: true });
        context.imageSmoothingEnabled = false;
        context.drawImage(source.image, region.x, region.y, region.width, region.height, 0, 0, work.width, work.height);
        const natural = context.getImageData(0, 0, work.width, work.height);
        const direct = decodeJsQrImageData(natural);
        if (direct) return direct;
        for (const threshold of [125, 160, 195]) {
          const decoded = decodeJsQrImageData(thresholdImageData(natural, threshold));
          if (decoded) return decoded;
        }
      }
    } catch (_) {
      return "";
    } finally {
      source?.release();
    }
    return "";
  }

  async function loadImageSource(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file);
        return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
      } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({ image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) });
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo abrir la imagen")); };
      image.src = url;
    });
  }

  function centeredSquareRegion(width, height, scale) {
    const size = Math.floor(Math.min(width, height) * scale);
    return { x: Math.max(0, Math.floor((width - size) / 2)), y: Math.max(0, Math.floor((height - size) / 2)), width: size, height: size };
  }

  function decodeJsQrImageData(imageData) {
    try {
      return window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" })?.data || "";
    } catch (_) {
      return "";
    }
  }

  function thresholdImageData(source, threshold) {
    const copy = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
    for (let index = 0; index < copy.data.length; index += 4) {
      const luminance = copy.data[index] * 0.299 + copy.data[index + 1] * 0.587 + copy.data[index + 2] * 0.114;
      const value = luminance < threshold ? 0 : 255;
      copy.data[index] = value;
      copy.data[index + 1] = value;
      copy.data[index + 2] = value;
      copy.data[index + 3] = 255;
    }
    return copy;
  }

  function startCameraFallback() {
    window.clearInterval(fallbackTimer);
    if (typeof window.jsQR !== "function" && !window.ZXingWASM?.readBarcodes) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    fallbackTimer = window.setInterval(async () => {
      if (!scannerRunning || scanLocked || fallbackBusy) return;
      const video = document.querySelector("#cameraReader video");
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      fallbackBusy = true;
      try {
        const scale = Math.min(1, 1000 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const decoded = decodeJsQrImageData(context.getImageData(0, 0, canvas.width, canvas.height));
        if (decoded) handleDecodedQr(decoded);
      } finally {
        fallbackBusy = false;
      }
    }, 240);
  }

  async function createQrCropCandidates(file) {
    let source = null;
    try {
      source = await loadImageSource(file);
      const candidates = [];
      for (const scale of [0.96, 0.82]) {
        const region = centeredSquareRegion(source.width, source.height, scale);
        const outputSize = Math.min(1200, region.width);
        const canvas = document.createElement("canvas");
        canvas.width = outputSize;
        canvas.height = outputSize;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.imageSmoothingEnabled = false;
        context.drawImage(source.image, region.x, region.y, region.width, region.height, 0, 0, outputSize, outputSize);
        const natural = context.getImageData(0, 0, outputSize, outputSize);
        candidates.push(new File([await canvasToPngBlob(canvas)], `qr-recorte-${scale}.png`, { type: "image/png" }));
        for (const threshold of [150, 190]) {
          context.putImageData(thresholdImageData(natural, threshold), 0, 0);
          candidates.push(new File([await canvasToPngBlob(canvas)], `qr-contraste-${scale}-${threshold}.png`, { type: "image/png" }));
        }
      }
      return candidates;
    } catch (_) {
      return [];
    } finally {
      source?.release();
    }
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("No se pudo preparar la imagen")), "image/png"));
  }

  async function handleDecodedQr(decodedText) {
    if (scanLocked || !String(decodedText || "").trim()) return;
    scanLocked = true;
    const clean = String(decodedText).trim();
    const valid = isDigitalInvitaQr(clean);
    pauseQrScannerForResult();
    showResult(clean, valid);
  }

  function pauseQrScannerForResult() {
    if (!qrScanner || !scannerRunning) return;
    try {
      // Pausar el video conserva la autorización y permite reanudar sin otro permiso.
      qrScanner.pause(true);
      scannerPaused = true;
      scannerRunning = false;
      window.clearInterval(fallbackTimer);
      fallbackTimer = 0;
      fallbackBusy = false;
      stage.classList.remove("is-active");
    } catch (_) {
      // Si el navegador no admite pausa, cerramos la sesión como respaldo.
      stopQrScanner({ silent: true });
    }
  }

  function isDigitalInvitaQr(value) {
    return /\bDI-[A-Z0-9]{4,}(?:-[A-Z0-9]{3,})*/i.test(value)
      || /digital\s*invita|digital\s*connect|confirmaci[oó]n\s+de\s+asistencia|[?&](?:folio|pases?|passes|para|nombre)=/i.test(value);
  }

  function showResult(value, valid) {
    const clean = String(value).trim();
    resultCard.dataset.status = valid ? "valid" : "invalid";
    resultIcon.textContent = valid ? "✓" : "!";
    resultTitle.textContent = valid ? "Acceso válido" : "Código QR no válido";
    flashCheck.textContent = valid ? "✓" : "!";
    flashTitle.textContent = valid ? "Acceso válido" : "Código QR no válido";
    flashSubtitle.textContent = valid ? "Código confirmado" : "Este código no corresponde a esta invitación";
    scanFlash.dataset.status = valid ? "valid" : "invalid";
    scanFlash.hidden = false;
    window.setTimeout(() => { scanFlash.hidden = true; }, 950);
    emptyResult.hidden = true;
    resultContent.hidden = false;
    resultValue.textContent = clean;
    openResult.hidden = !/^https?:\/\//i.test(clean);
    if (!openResult.hidden) openResult.href = clean;
    toggleLabel.textContent = "Escanear un nuevo QR";
    say("Código detectado");
    notify("Código QR leído correctamente");
    window.setTimeout(() => resultCard.scrollIntoView({ behavior: "smooth", block: "start" }), 420);
  }

  function resetResult() {
    scanLocked = false;
    scanFlash.hidden = true;
    delete resultCard.dataset.status;
    resultIcon.textContent = "⌁";
    resultContent.hidden = true;
    emptyResult.hidden = false;
    resultTitle.textContent = "Esperando un código";
    openResult.hidden = true;
    resultValue.textContent = "";
    toggleLabel.textContent = scannerRunning ? "Detener escaneo" : "Escanear código QR";
    if (scannerRunning) {
      stage.classList.add("is-active");
      say("Buscando código QR…");
    }
  }

  function cameraErrorMessage(error) {
    const message = String(error?.message || error || "").toLowerCase();
    if (message.includes("permission") || message.includes("notallowed")) return "Permite el acceso a la cámara para poder escanear.";
    if (message.includes("notfound") || message.includes("device")) return "No encontramos una cámara disponible.";
    return "No se pudo iniciar la cámara. Intenta nuevamente.";
  }

  toggle.addEventListener("click", startQrScanner);
  copyResult.addEventListener("click", async () => { try { await navigator.clipboard.writeText(resultValue.textContent); notify("Contenido copiado"); } catch (_) { notify("No se pudo copiar automáticamente."); } });
  clearResult.addEventListener("click", async () => {
    resetResult();
    window.setTimeout(() => stage.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    await startQrScanner();
  });
  window.addEventListener("pagehide", () => stopQrScanner({ silent: true }));
})();
