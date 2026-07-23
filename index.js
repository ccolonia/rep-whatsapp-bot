/**
 * ============================================================
 * REP WhatsApp Bot — Microservicio de Guardia Nocturna
 * ============================================================
 *
 * Conecta con WhatsApp Web vía QR, filtra mensajes por horario
 * de guardia nocturna (20:00 - 08:00 hs Argentina), y deriva los
 * mensajes al endpoint de IA en Vercel para generar respuestas.
 *
 * Arquitectura:
 *   WhatsApp Web (Puppeteer) → este microservicio → Vercel API (IA + Prisma)
 *
 * Deploy: Render / Railway / cualquier contenedor con Chromium
 * ============================================================
 */

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const axios = require("axios");
const { formatInTimeZone } = require("date-fns-tz");

// === Configuración desde variables de entorno ===
const PORT = process.env.PORT || 3000;
const VERCEL_API_URL =
  process.env.VERCEL_API_URL ||
  "https://www.redescuchapsicologica.com/api/whatsapp/process";
const WHATSAPP_BOT_SECRET = process.env.WHATSAPP_BOT_SECRET;

// === Horario de Guardia Nocturna (configurable) ===
// Por defecto: 20:00 a 08:00 hs Argentina (8 PM a 8 AM)
const GUARD_START_HOUR = parseInt(process.env.GUARD_START_HOUR || "20", 10);
const GUARD_END_HOUR = parseInt(process.env.GUARD_END_HOUR || "8", 10);
const ARG_TZ = "America/Argentina/Buenos_Aires";

// === Rate limiting simple (anti-spam) ===
// Máximo 1 mensaje por usuario cada N segundos, para evitar que un
// usuario inunde el bot y consuma cuota de la IA en vano.
const RATE_LIMIT_SECONDS = parseInt(process.env.RATE_LIMIT_SECONDS || "30", 10);
const lastMessageByUser = new Map(); // Map<phoneNumber, timestamp>

// === Estado global del bot ===
let lastQR = null; // Último QR generado (para endpoint /qr)
let clientReady = false; // true cuando el cliente está autenticado
let client = null; // Instancia del cliente de WhatsApp
let isResetting = false; // Lock anti-concurrencia para /reset e initWhatsAppClient
let isInitializing = false; // Lock anti-concurrencia para initWhatsAppClient

// === Express server (para health check y status) ===
const app = express();
app.use(express.json());

// GET /health — Render/Railway ping para no apagar el contenedor
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// GET /status — información de diagnóstico del bot
app.get("/status", (req, res) => {
  const argTime = formatInTimeZone(new Date(), ARG_TZ, "HH:mm:ss");
  const guardActive = isGuardActive();
  res.json({
    status: "ok",
    whatsappReady: clientReady,
    argTime,
    guardActive,
    guardSchedule: `${GUARD_START_HOUR}:00 - ${GUARD_END_HOUR}:00 (Argentina)`,
    vercelApiUrl: VERCEL_API_URL,
    hasSecret: !!WHATSAPP_BOT_SECRET,
    uptime: process.uptime(),
  });
});

// GET /debug — diagnóstico avanzado del cliente de WhatsApp
// Muestra info interna del cliente para detectar si está realmente
// conectado o si se desconectó silenciosamente.
app.get("/debug", async (req, res) => {
  const argTime = formatInTimeZone(new Date(), ARG_TZ, "HH:mm:ss");
  const debugInfo = {
    timestamp: argTime,
    clientReady,
    isResetting,
    isInitializing,
    hasClient: !!client,
    lastQR: lastQR ? `${lastQR.substring(0, 30)}...` : null,
    clientInfo: null,
    connectionState: null,
    memoryUsage: process.memoryUsage(),
  };

  // Intentar obtener info interna del cliente de WhatsApp
  if (client) {
    try {
      // client.info contiene datos de la cuenta vinculada
      debugInfo.clientInfo = {
        pushname: client.info?.pushname || null,
        wid: client.info?.wid?.user || null,
        platform: client.info?.platform || null,
        phone: client.info?.phone || null,
      };

      // getBatteryLevel y getState nos dicen si el cliente realmente responde
      try {
        const state = await client.getState();
        debugInfo.connectionState = state;
      } catch (stateErr) {
        debugInfo.connectionState = `ERROR: ${stateErr.message}`;
      }
    } catch (err) {
      debugInfo.clientInfo = `ERROR obteniendo info: ${err.message}`;
    }
  }

  res.json(debugInfo);
});

// GET /qr — devuelve el QR como imagen HTML con auto-refresh.
// La página se actualiza sola cada 12 segundos para mostrar el QR más
// reciente (WhatsApp invalida el QR a los ~60s). Cuando el cliente ya
// está vinculado, muestra una pantalla verde de éxito.
app.get("/qr", async (req, res) => {
  // Si ya está conectado, mostrar estado de éxito
  if (clientReady) {
    return res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>REP WhatsApp - Estado</title>
    <meta http-equiv="refresh" content="10">
  </head>
  <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5;margin:0;">
    <div style="text-align:center;background:white;padding:30px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
      <h2 style="color:#059669;margin-top:0;">✅ ¡WhatsApp ya está vinculado y listo!</h2>
      <p style="color:#64748b;">El bot de la Red de Escucha Psicológica está activo.</p>
    </div>
  </body>
</html>`);
  }

  // Si todavía no hay QR generado, mostrar "cargando" con auto-refresh
  if (!lastQR) {
    return res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>Generando QR...</title>
    <meta http-equiv="refresh" content="5">
  </head>
  <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5;margin:0;">
    <h2 style="color:#1e293b;">Aguardá un momento, generando código QR...</h2>
  </body>
</html>`);
  }

  // Generar imagen QR como Data URL (Base64) y servir como HTML
  try {
    const qrImageUrl = await QRCode.toDataURL(lastQR);
    res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>Escanear QR - REP WhatsApp Bot</title>
    <meta http-equiv="refresh" content="12">
  </head>
  <body style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5;margin:0;">
    <div style="text-align:center;background:white;padding:30px;border-radius:16px;box-shadow:0 10px 25px rgba(0,0,0,0.1);max-width:360px;">
      <h2 style="margin-top:0;color:#1e293b;">Vincular WhatsApp REP</h2>
      <p style="color:#64748b;font-size:14px;">Abrí WhatsApp Business ➔ Dispositivos vinculados ➔ Vincular dispositivo</p>
      <img src="${qrImageUrl}" alt="Código QR WhatsApp" style="width:260px;height:260px;border:1px solid #e2e8f0;border-radius:8px;padding:8px;" />
      <p style="color:#94a3b8;font-size:12px;margin-bottom:0;">La página se actualiza automáticamente cada 12s.</p>
    </div>
  </body>
</html>`);
  } catch (err) {
    console.error(`[${timestamp()}] ❌ Error generando imagen QR:`, err?.message || err);
    res.status(500).send("Error generando imagen QR");
  }
});

// GET /reset —_endpoint de rescate para forzar un QR nuevo.
//
// Caso de uso: al reiniciar el servicio en Render, whatsapp-web.js
// intenta restaurar la sesión de LocalAuth. Si la sesión está trunca
// o corrupta, el cliente se queda trabado sin generar QR nuevo y
// clientReady queda en false para siempre.
//
// Solución: este endpoint borra la carpeta de sesión y reinicia el
// cliente desde cero, forzando la emisión de un QR fresco.
//
// Después de llamarlo, redirige a /qr para que el admin escanee.
app.get("/reset", async (req, res) => {
  // === Lock anti-concurrencia ===
  // Si /reset se llama 2 veces seguidas (ej: doble click, o refresh de la
  // página anterior que re-dispara el request), la 2da llamada intentaría
  // inicializar un nuevo cliente Puppeteer mientras el 1ro todavía está
  // levantando → "The browser is already running for /app/whatsapp-session/session".
  if (isResetting) {
    console.log(`[${timestamp()}] ⏭️ /reset ya está en curso — ignorando llamada duplicada`);
    return res.send(`
<!DOCTYPE html>
<html>
  <head>
    <title>Reset en curso - REP WhatsApp Bot</title>
    <meta http-equiv="refresh" content="5;url=/qr">
  </head>
  <body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0f2f5;margin:0;">
    <div style="background:white;padding:40px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);display:inline-block;">
      <h2 style="color:#3b82f6;margin-top:0;">⏳ Reset en curso</h2>
      <p style="color:#64748b;">Ya hay un reset en progreso. Redirigiendo a /qr en 5 segundos...</p>
      <p style="color:#94a3b8;font-size:12px;">Si no se redirige automáticamente, <a href="/qr" style="color:#3b82f6;">hacé clic acá</a>.</p>
    </div>
  </body>
</html>`);
  }

  isResetting = true;
  try {
    console.log(`[${timestamp()}] 🔄 Reset solicitado — limpiando sesión y reiniciando cliente...`);

    // Resetear estado global
    clientReady = false;
    lastQR = null;
    isInitializing = false; // Permitir que initWhatsAppClient() vuelva a correr

    // 1. Destruir el cliente actual de Puppeteer (cierra el browser headless)
    if (client) {
      try {
        console.log(`[${timestamp()}]   ⏳ Destruyendo cliente...`);
        await client.destroy();
        console.log(`[${timestamp()}]   ✓ Cliente destruido`);
      } catch (e) {
        console.log(`[${timestamp()}]   ⚠️ Error destruyendo cliente (no bloqueante): ${e.message}`);
      }
      client = null;
    }

    // 2. Esperar 2 segundos a que Chromium libere el lock del userDataDir.
    // Sin este delay, fs.rmSync puede fallar con EBUSY o el próximo
    // initialize() puede fallar con "browser is already running".
    console.log(`[${timestamp()}]   ⏳ Esperando 2s a que Chromium libere el lock...`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 3. Eliminar la carpeta de sesión persistente para borrar la sesión trunca
    const sessionPath = "./whatsapp-session";
    if (fs.existsSync(sessionPath)) {
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(`[${timestamp()}]   🗑️ Carpeta de sesión eliminada correctamente`);
      } catch (rmErr) {
        console.log(`[${timestamp()}]   ⚠️ No se pudo eliminar la carpeta (no bloqueante): ${rmErr.message}`);
        console.log(`[${timestamp()}]      Continuando igual — el nuevo cliente usará la sesión existente.`);
      }
    } else {
      console.log(`[${timestamp()}]   ℹ️ No había carpeta de sesión previa`);
    }

    // 4. Volver a inicializar el cliente de WhatsApp desde cero.
    // initWhatsAppClient() es síncrono en su llamada (los eventos son async),
    // así que devuelve inmediatamente pero el cliente sigue inicializando en background.
    initWhatsAppClient();

    // 5. Responder con HTML que redirige a /qr en 8 segundos (tiempo prudencial
    // para que el cliente termine de inicializar y genere el primer QR).
    // Aumenté de 5s a 8s porque la inicialización con webVersionCache remoto
    // puede tardar más en el primer arranque (descarga la versión de GitHub).
    res.send(`
<!DOCTYPE html>
<html>
  <head>
    <title>Reseteando sesión - REP WhatsApp Bot</title>
    <meta http-equiv="refresh" content="8;url=/qr">
  </head>
  <body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0f2f5;margin:0;">
    <div style="background:white;padding:40px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);display:inline-block;">
      <h2 style="color:#059669;margin-top:0;">🔄 Sesión reseteada con éxito</h2>
      <p style="color:#64748b;">Redirigiendo a la página del QR en 8 segundos...</p>
      <p style="color:#94a3b8;font-size:12px;">Si no se redirige automáticamente, <a href="/qr" style="color:#059669;">hacé clic acá</a>.</p>
    </div>
  </body>
</html>`);
  } catch (err) {
    console.error(`[${timestamp()}] ❌ Error reseteando sesión:`, err?.message || err);
    res.status(500).send("Error reseteando sesión: " + (err?.message || err));
  } finally {
    // Liberar el lock después de 15s para que initWhatsAppClient() tenga
    // tiempo de completar la inicialización (incluyendo descarga de
    // webVersionCache remoto si es la primera vez).
    setTimeout(() => {
      isResetting = false;
    }, 15000);
  }
});

const server = app.listen(PORT, () => {
  console.log(`[${timestamp()}] 🌐 Servidor HTTP escuchando en puerto ${PORT}`);
  console.log(`[${timestamp()}]   Health check: http://localhost:${PORT}/health`);
  console.log(`[${timestamp()}]   Status:        http://localhost:${PORT}/status`);
  console.log(`[${timestamp()}]   QR (imagen):   http://localhost:${PORT}/qr`);
  console.log(`[${timestamp()}]   Reset sesión:  http://localhost:${PORT}/reset`);
});

// === Helper: timestamp con hora Argentina para logs ===
function timestamp() {
  return formatInTimeZone(new Date(), ARG_TZ, "yyyy-MM-dd HH:mm:ss");
}

// === Helper: ¿estamos en horario de guardia nocturna? ===
// Guardia activa: 20:00 a 07:59 (si GUARD_START > GUARD_END, cruza medianoche)
function isGuardActive() {
  const argHour = parseInt(
    formatInTimeZone(new Date(), ARG_TZ, "HH"),
    10
  );
  if (GUARD_START_HOUR > GUARD_END_HOUR) {
    // Caso cruce de medianoche: ej. 20 → 8 (activo de 20 a 23 y de 0 a 7)
    return argHour >= GUARD_START_HOUR || argHour < GUARD_END_HOUR;
  }
  // Caso mismo día: ej. 22 → 23 (activo de 22 a 22:59)
  return argHour >= GUARD_START_HOUR && argHour < GUARD_END_HOUR;
}

// === Helper: rate limiting por usuario ===
function isRateLimited(phoneNumber) {
  const now = Date.now();
  const last = lastMessageByUser.get(phoneNumber);
  if (last && now - last < RATE_LIMIT_SECONDS * 1000) {
    return true;
  }
  lastMessageByUser.set(phoneNumber, now);
  // Limpiar entries viejas cada 1000 mensajes para evitar memory leak
  if (lastMessageByUser.size > 1000) {
    for (const [key, value] of lastMessageByUser) {
      if (now - value > 5 * 60 * 1000) {
        lastMessageByUser.delete(key);
      }
    }
  }
  return false;
}

// === Helper: extraer número de teléfono del JID de WhatsApp ===
// msg.from viene como "5491176683429@c.us" → devuelve "5491176683429"
function extractPhoneNumber(from) {
  return from.split("@")[0];
}

// === Inicializar cliente de WhatsApp Web ===
// Protegido con lock `isInitializing` para evitar que 2 llamadas
// concurrentes (ej: /reset spammeado, o evento 'disconnected' que
// reintenta mientras un /reset está en curso) lancen 2 instancias
// de Puppeteer con el mismo userDataDir → "browser is already running".
function initWhatsAppClient() {
  // === Lock anti-concurrencia ===
  if (isInitializing) {
    console.log(`[${timestamp()}] ⏭️ initWhatsAppClient() ya está en curso — ignorando llamada duplicada`);
    return;
  }
  isInitializing = true;

  console.log(`[${timestamp()}] 🚀 Inicializando cliente de WhatsApp Web...`);

  // === Configuración de Puppeteer EXTREMADAMENTE optimizada para bajo consumo de RAM ===
  // Target: < 450MB total (Node + Chromium) para caber en 512MB de Render Free.
  //
  // Estrategia:
  // 1. --single-process: junta renderer + browser + GPU en un solo proceso
  //    (ahorra ~80MB de overhead de process separation)
  // 2. --disable-features=site-per-process: no aislar cada site en proceso propio
  // 3. --js-flags=--max-old-space-size=192: limitar V8 heap a 192MB (en vez de 256)
  // 4. --disable-background-networking: no hacer requests en background
  // 5. --disable-renderer-backgrounding: no pausar renderer en background
  // 6. --disable-background-timer-throttling: no throttle timers
  // 7. --disable-sync: no sync de Chrome
  // 8. --disable-translate: no translate
  // 9. --disable-ipc-flooding-protection: no protection contra IPC flood
  // 10. --mute-audio: silenciar audio (no lo necesitamos)
  // 11. --blink-settings=imagesEnabled=false: NO cargar imágenes (ahorra RAM y ancho de banda)
  const puppeteerConfig = {
    headless: true, // headless: true = modo nuevo de Puppeteer (sin 'new')
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: [
      // === Sandbox / seguridad ===
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // OBLIGATORIO para Docker/Render
      // === Procesos ===
      "--no-zygote", // No proceso zygote (ahorra ~50MB)
      "--single-process", // TODO en un solo proceso (ahorra ~80MB)
      "--disable-features=site-per-process,IsolateOrigins",
      "--disable-site-isolation-trials",
      "--no-experiments",
      // === GPU / rendering ===
      "--disable-gpu",
      "--disable-accelerated-2d-canvas",
      "--disable-software-rasterizer",
      // === Network / background ===
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-component-update",
      "--disable-component-extensions-with-background-pages",
      // === Features que no necesitamos ===
      "--disable-translate",
      "--disable-ipc-flooding-protection",
      "--disable-notifications",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-domain-reliability",
      "--disable-hang-monitor",
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      // === Memoria V8 (lo más agresivo) ===
      "--js-flags=--max-old-space-size=192 --max-semi-space-size=8 --max-old-space-size=192",
      // === No cargar imágenes (ahorra RAM y bandwidth) ===
      "--blink-settings=imagesEnabled=false",
      // === Certificados ===
      "--ignore-certificate-errors",
      "--ignore-certificate-errors-spki-list",
      "--allow-running-insecure-content",
      // === Web security off (más rápido) ===
      "--disable-web-security",
    ],
  };

  client = new Client({
    authStrategy: new LocalAuth({
      // Guarda la sesión en ./whatsapp-session/ para no pedir QR en cada restart
      dataPath: "./whatsapp-session",
    }),
    // === webVersionCache REMOVIDO ===
    // Antes apuntábamos a una versión alpha del mirror wppconnect-team
    // (2.3000.1040310160-alpha.html). Esa versión NO era compatible con
    // whatsapp-web.js 1.23.0 y causaba LOGOUT inmediato al escanear el QR.
    //
    // Sin webVersionCache, whatsapp-web.js carga la versión LIVE de
    // web.whatsapp.com. Esto es lo más estable porque siempre usa la
    // versión actual que WhatsApp sirve oficialmente.
    //
    // Si en el futuro WhatsApp rompe compatibilidad con whatsapp-web.js,
    // podemos volver a habilitar webVersionCache apuntando a una versión
    // estable NO-alpha del mirror. Ver:
    //   https://github.com/wppconnect-team/wa-version/tree/main/html
    puppeteer: puppeteerConfig,
  });

  // === Evento: QR generado (escanear desde el celular) ===
  client.on("qr", (qr) => {
    console.log(`\n[${timestamp()}] 📱 Escaneá este QR con tu WhatsApp:\n`);
    qrcode.generate(qr, { small: true });
    console.log(`[${timestamp()}] 📱 También podés ver el QR en: http://localhost:${PORT}/qr\n`);
    lastQR = qr;
  });

  // === Evento: pantalla de carga de WhatsApp Web ===
  // Útil para diagnóstico: nos dice si WhatsApp Web está cargando.
  client.on("loading_screen", (percent, message) => {
    console.log(`[${timestamp()}] ⏳ Cargando WhatsApp Web: ${percent}% - ${message}`);
  });

  // === Evento: cliente autenticado (vinculación aceptada en el celular) ===
  client.on("authenticated", () => {
    console.log(`[${timestamp()}] 🔑 AUTENTICADO: Vinculación aceptada en WhatsApp`);
    console.log(`[${timestamp()}]    (esperando que la interfaz termine de cargar para disparar 'ready'...)`);
    lastQR = null; // Ya no necesitamos el QR
  });

  // === Evento: cliente listo para recibir mensajes ===
  // CRÍTICO: este evento es el que dispara clientReady=true. Si nunca se
  // dispara, el bot queda en estado 'autenticado pero no listo' y no
  // responde mensajes. El webVersionCache de arriba es lo que garantiza
  // que este evento se dispare correctamente.
  client.on("ready", () => {
    clientReady = true;
    isInitializing = false; // Liberar lock — la inicialización terminó OK
    console.log(`[${timestamp()}] 🚀 READY: Cliente de WhatsApp 100% activo (clientReady = true)`);
    const info = client.info || {};
    console.log(`[${timestamp()}]    Cuenta: ${info.pushname || "N/A"} (${info.wid?.user || "N/A"})`);
  });

  // === Evento: falla de autenticación ===
  client.on("auth_failure", (msg) => {
    clientReady = false;
    isInitializing = false; // Liberar lock para permitir reintento
    console.error(`[${timestamp()}] ❌ Error de autenticación: ${msg}`);
    console.error(`[${timestamp()}]    Llamá al endpoint /reset para borrar la sesión y volver a escanear el QR.`);
  });

  // === Evento: desconexión ===
  // Manejo diferenciado según el motivo:
  // - LOGOUT: WhatsApp invalidó la sesión (sesión corrupta o versión
  //   incompatible). Hay que borrar la carpeta de sesión antes de
  //   reinitializar, sino vuelve a LOGOUT en loop.
  // - Otros (TIMEOUT, NAVIGATION, etc.): la sesión sigue válida,
  //   solo reconectar sin borrar nada.
  client.on("disconnected", async (reason) => {
    clientReady = false;
    isInitializing = false; // Liberar lock para permitir reintento
    console.warn(`[${timestamp()}] 🔌 Cliente desconectado: ${reason}`);

    // Si es LOGOUT, borrar la sesión para que el próximo init pida QR nuevo
    if (reason === "LOGOUT") {
      console.warn(`[${timestamp()}]    ⚠️ LOGOUT detectado — borrando sesión corrupta...`);
      try {
        // Destruir el cliente async antes de borrar la carpeta
        if (client) {
          try { await client.destroy(); } catch (e) { /* ignore */ }
          client = null;
        }
        // Esperar 2s a que Chromium libere el lock
        await new Promise((r) => setTimeout(r, 2000));
        // Borrar carpeta de sesión
        const sessionPath = "./whatsapp-session";
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          console.warn(`[${timestamp()}]    🗑️ Sesión corrupta eliminada`);
        }
      } catch (e) {
        console.warn(`[${timestamp()}]    ⚠️ Error limpiando sesión: ${e.message}`);
      }
    }

    console.warn(`[${timestamp()}]    Reintentando en 10 segundos...`);
    setTimeout(() => {
      console.log(`[${timestamp()}] 🔄 Reinicializando cliente...`);
      initWhatsAppClient();
    }, 10000);
  });

  // === Evento: mensaje entrante ===
  // Log SIEMPRE que llega un mensaje, incluso si después lo vamos a filtrar.
  // Esto es clave para diagnóstico: si no vemos este log, el cliente no está
  // recibiendo mensajes de WhatsApp (problema de conexión).
  client.on("message", async (msg) => {
    console.log(`[${timestamp()}] 📨 Mensaje entrante de ${msg.from}: "${msg.body?.substring(0, 50) || '[sin texto]'}"`);
    try {
      await handleMessage(msg);
    } catch (err) {
      console.error(`[${timestamp()}] ❌ Error procesando mensaje de ${msg.from}:`, err?.message || err);
    }
  });

  // === Evento: cualquier evento de cambio de estado ===
  // Útil para ver si WhatsApp nos manda eventos que no estamos escuchando.
  client.on("change_state", (state) => {
    console.log(`[${timestamp()}] 🔄 Estado del cliente cambió: ${state}`);
  });

  // === Evento: cambio de batería (solo para diagnóstico de conexión) ===
  client.on("change_battery", (batteryInfo) => {
    console.log(`[${timestamp()}] 🔋 Battería: ${JSON.stringify(batteryInfo)}`);
  });

  // === Inicializar con manejo de errores ===
  // Si initialize() falla (ej: "browser is already running"), liberar el lock
  // para que un próximo /reset pueda intentar de nuevo.
  client.initialize().catch((err) => {
    isInitializing = false;
    console.error(`[${timestamp()}] ❌ Error en client.initialize(): ${err?.message || err}`);
    console.error(`[${timestamp()}]    Llamá a /reset para limpiar y reintentar.`);
  });
}

// === Manejo principal de mensajes entrantes ===
async function handleMessage(msg) {
  // 1. Ignorar mensajes de grupos
  if (msg.from.endsWith("@g.us")) {
    return;
  }

  // 2. Ignorar mensajes de status/broadcast
  if (msg.from === "status@broadcast") {
    return;
  }

  // 3. Ignorar mensajes propios
  if (msg.fromMe) {
    return;
  }

  // 4. Ignorar mensajes sin texto (media, audio, stickers, etc.)
  //    Por ahora el bot solo procesa texto. Si querés procesar media,
  //    habría que descargarla y mandarla a un modelo multimodal.
  if (!msg.body || msg.body.trim().length === 0) {
    return;
  }

  const phoneNumber = extractPhoneNumber(msg.from);

  // 5. Verificar horario de guardia nocturna
  if (!isGuardActive()) {
    console.log(`[${timestamp()}] 🌞 Guardia INACTIVA — mensaje de ${phoneNumber} ignorado (responderá un humano)`);
    return;
  }

  console.log(`[${timestamp()}] 🌙 Guardia ACTIVA — mensaje de ${phoneNumber}: ${msg.body.length} chars`);

  // 6. Rate limiting: si el usuario mandó otro mensaje hace menos de 30s, ignorar
  if (isRateLimited(phoneNumber)) {
    console.log(`[${timestamp()}] ⏭️ Rate limited: ${phoneNumber} ya mandó un mensaje hace menos de ${RATE_LIMIT_SECONDS}s`);
    return;
  }

  // 7. Validar que el secret esté configurado
  if (!WHATSAPP_BOT_SECRET) {
    console.error(`[${timestamp()}] ❌ WHATSAPP_BOT_SECRET no está configurado. No se puede derivar a Vercel.`);
    return;
  }

  // 8. Enviar mensaje al endpoint de IA en Vercel
  const startTime = Date.now();
  let reply;
  try {
    const response = await axios.post(
      VERCEL_API_URL,
      {
        sender: msg.from,
        message: msg.body,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-secret": WHATSAPP_BOT_SECRET,
        },
        timeout: 30000, // 30s — si Vercel tarda más, algo salió mal
      }
    );

    reply = response.data?.reply;
    const elapsed = Date.now() - startTime;
    console.log(`[${timestamp()}] ⚡ Vercel respondió en ${elapsed}ms — reply: ${reply?.length || 0} chars`);

    if (!reply) {
      throw new Error("Vercel no devolvió campo 'reply' en la respuesta");
    }
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[${timestamp()}] ❌ Error llamando a Vercel (${elapsed}ms):`, err?.message || err);

    // Fallback graceful: si Vercel falla, igual responderle algo al paciente
    // para que no se quede sin respuesta en la guardia nocturna.
    reply =
      "Hola 👋 En este momento estoy teniendo dificultades técnicas para procesar tu mensaje. " +
      "Un coordinador humano te va a contactar a la brevedad. " +
      "Si es una urgencia, llamá al 0800-345-1435 (Salud Mental, las 24 hs).";
  }

  // 9. Enviar la respuesta al paciente por WhatsApp
  try {
    await msg.reply(reply);
    console.log(`[${timestamp()}] ✅ Respuesta enviada a ${phoneNumber}`);
  } catch (err) {
    console.error(`[${timestamp()}] ❌ Error enviando respuesta a ${phoneNumber}:`, err?.message || err);
  }
}

// === Inicializar todo ===
if (!WHATSAPP_BOT_SECRET) {
  console.warn(`[${timestamp()}] ⚠️ WHATSAPP_BOT_SECRET no está configurado. El bot no podrá derivar mensajes a Vercel.`);
  console.warn(`[${timestamp()}]   Copiá .env.example a .env y configurá las variables.`);
}

// === Delay inicial de 3s antes de arrancar Puppeteer ===
// Render puede enviar SIGTERM durante los primeros segundos si el contenedor
// parece no responder (Puppeteer consume mucha CPU/RAM durante el arranque).
// Este delay le da tiempo a Render a estabilizar el contenedor y al servidor
// HTTP a empezar a responder /health antes de que Chromium empiece a chupar RAM.
setTimeout(() => {
  initWhatsAppClient();
}, 3000);

// === Graceful shutdown ===
process.on("SIGTERM", () => {
  console.log(`[${timestamp()}] 🛑 SIGTERM recibido — cerrando servidor...`);
  server.close(() => {
    if (client) {
      client.destroy();
    }
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log(`[${timestamp()}] 🛑 SIGINT recibido — cerrando servidor...`);
  server.close(() => {
    if (client) {
      client.destroy();
    }
    process.exit(0);
  });
});

// === Manejo de errores no capturados (no romper el proceso) ===
process.on("unhandledRejection", (reason) => {
  console.error(`[${timestamp()}] ❌ Unhandled Rejection:`, reason);
});

process.on("uncaughtException", (err) => {
  console.error(`[${timestamp()}] ❌ Uncaught Exception:`, err);
  // No salir del proceso — el bot debe seguir corriendo aunque un mensaje falle
});

console.log(`[${timestamp()}] 📍 Zona horaria: ${ARG_TZ}`);
console.log(`[${timestamp()}] 📍 Guardia nocturna: ${GUARD_START_HOUR}:00 - ${GUARD_END_HOUR}:00 hs Argentina`);
console.log(`[${timestamp()}] 📍 Vercel API: ${VERCEL_API_URL}`);
console.log(`[${timestamp()}] 📍 Rate limit: ${RATE_LIMIT_SECONDS}s por usuario`);
