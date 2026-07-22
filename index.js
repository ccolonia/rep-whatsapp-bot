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
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
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

// GET /qr — devuelve el último QR como texto plano (útil si no tenés
// acceso a los logs de Render/Railway y necesitás escanear desde el browser)
app.get("/qr", (req, res) => {
  if (!lastQR) {
    return res
      .status(404)
      .send("No hay QR disponible. El cliente ya está autenticado o todavía no se generó.");
  }
  res.type("text/plain").send(lastQR);
});

const server = app.listen(PORT, () => {
  console.log(`[${timestamp()}] 🌐 Servidor HTTP escuchando en puerto ${PORT}`);
  console.log(`[${timestamp()}]   Health check: http://localhost:${PORT}/health`);
  console.log(`[${timestamp()}]   Status:        http://localhost:${PORT}/status`);
  console.log(`[${timestamp()}]   QR (texto):    http://localhost:${PORT}/qr`);
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
function initWhatsAppClient() {
  console.log(`[${timestamp()}] 🚀 Inicializando cliente de WhatsApp Web...`);

  client = new Client({
    authStrategy: new LocalAuth({
      // Guarda la sesión en ./whatsapp-session/ para no pedir QR en cada restart
      dataPath: "./whatsapp-session",
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1920x1080",
      ],
    },
  });

  // === Evento: QR generado (escanear desde el celular) ===
  client.on("qr", (qr) => {
    console.log(`\n[${timestamp()}] 📱 Escaneá este QR con tu WhatsApp:\n`);
    qrcode.generate(qr, { small: true });
    console.log(`[${timestamp()}] 📱 También podés ver el QR en: http://localhost:${PORT}/qr\n`);
    lastQR = qr;
  });

  // === Evento: cliente autenticado ===
  client.on("authenticated", () => {
    console.log(`[${timestamp()}] ✅ WhatsApp autenticado correctamente`);
    lastQR = null; // Ya no necesitamos el QR
  });

  // === Evento: cliente listo para recibir mensajes ===
  client.on("ready", () => {
    console.log(`[${timestamp()}] ✅ Cliente de WhatsApp listo y conectado`);
    const info = client.info || {};
    console.log(`[${timestamp()}]   Cuenta: ${info.pushname || "N/A"} (${info.wid?.user || "N/A"})`);
    clientReady = true;
  });

  // === Evento: falla de autenticación ===
  client.on("auth_failure", (msg) => {
    console.error(`[${timestamp()}] ❌ Falló la autenticación de WhatsApp: ${msg}`);
    console.error(`[${timestamp()}]   Eliminá la carpeta whatsapp-session/ y reiniciá para volver a escanear el QR.`);
  });

  // === Evento: desconexión ===
  client.on("disconnected", (reason) => {
    console.warn(`[${timestamp()}] ⚠️ Cliente desconectado: ${reason}`);
    console.warn(`[${timestamp()}]   Reintentando en 10 segundos...`);
    clientReady = false;
    setTimeout(() => {
      console.log(`[${timestamp()}] 🔄 Reinicializando cliente...`);
      client.initialize();
    }, 10000);
  });

  // === Evento: mensaje entrante ===
  client.on("message", async (msg) => {
    try {
      await handleMessage(msg);
    } catch (err) {
      console.error(`[${timestamp()}] ❌ Error procesando mensaje de ${msg.from}:`, err?.message || err);
    }
  });

  client.initialize();
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

initWhatsAppClient();

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
