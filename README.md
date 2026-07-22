# REP WhatsApp Bot 🌙🤖

Microservicio **WhatsApp Web 24/7** con **Guardia Nocturna** para la Red de Escucha Psicológica (REP).

Conecta con WhatsApp Business vía QR, filtra mensajes por horario de guardia nocturna (20:00 - 08:00 hs Argentina), y deriva los mensajes al endpoint de IA en Vercel (Groq + Llama 3.3) para generar respuestas automáticas.

## 🏗️ Arquitectura

```
WhatsApp Web (Puppeteer)
        ↓
Este microservicio (Node.js + Express)
        ↓
   ¿Es guardia nocturna? (20:00 - 08:00 AR)
        ↓ Sí
POST a Vercel /api/whatsapp/process
        ↓
IA (Groq + Llama 3.3) + Prisma (slots disponibles)
        ↓
Respuesta → msg.reply() → paciente
```

## 📋 Prerequisitos

- Node.js 18+ (para local)
- Docker (para deploy en Render/Railway)
- Un teléfono con WhatsApp para escanear el QR la primera vez
- El endpoint de Vercel ya configurado (Paso 1 ✅)

## 🚀 Deploy en Render

### 1. Crear repo en GitHub
```bash
cd rep-whatsapp-bot
git init
git add .
git commit -m "feat: REP WhatsApp Bot — microservicio de guardia nocturna"
git branch -M main
git remote add origin https://github.com/ccolonia/rep-whatsapp-bot.git
git push -u origin main
```

### 2. Crear Web Service en Render
1. Andá a https://dashboard.render.com → **New +** → **Web Service**
2. Conectá el repo `ccolonia/rep-whatsapp-bot`
3. Configuración:
   - **Name**: `rep-whatsapp-bot`
   - **Environment**: `Docker` (usa el Dockerfile del repo)
   - **Region**: `Oregon` (o la más cercana a Argentina)
   - **Instance Type**: `Free` o `Starter` (1 GB RAM mínimo por Puppeteer)
4. **Environment Variables**:
   ```
   WHATSAPP_BOT_SECRET=f07ec8dbf2f2c54971c2595babdc70b50231b74dee83e7f79cc978023507f0c6
   VERCEL_API_URL=https://www.redescuchapsicologica.com/api/whatsapp/process
   ```
5. **Disk** (importante para persistencia de sesión WhatsApp):
   - Name: `whatsapp-session`
   - Mount Path: `/app/whatsapp-session`
   - Size: 1 GB
6. Click **Create Web Service**

### 3. Escanear QR
1. Abrí los logs de Render (tab "Logs" del servicio)
2. Esperá a que aparezca el QR en la consola
3. En tu celular: WhatsApp → Configuración → Dispositivos vinculados → Vincular dispositivo → Escanear
4. También podés ver el QR en `https://TU-APP.onrender.com/qr`

## 🚂 Deploy en Railway

1. Andá a https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Seleccioná `ccolonia/rep-whatsapp-bot`
3. Railway detecta el Dockerfile automáticamente
4. **Variables**:
   ```
   WHATSAPP_BOT_SECRET=f07ec8dbf2f2c54971c2595babdc70b50231b74dee83e7f79cc978023507f0c6
   VERCEL_API_URL=https://www.redescuchapsicologica.com/api/whatsapp/process
   ```
5. **Volume** (para persistencia): Settings → Volumes → Add Volume → Mount Path: `/app/whatsapp-session`
6. Deploy → ver logs → escanear QR

## 💻 Desarrollo local

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env si es necesario

# 3. Ejecutar
npm start

# 4. Escanear QR que aparece en la consola
```

## 🔧 Endpoints HTTP

| Endpoint | Método | Descripción |
|---|---|---|
| `/health` | GET | Health check para Render/Railway. Devuelve `{ status: "ok" }` |
| `/status` | GET | Estado del bot: WhatsApp conectado, hora AR, guardia activa, uptime |
| `/qr` | GET | Último QR generado como texto (útil si no tenés acceso a logs) |

## ⏰ Horario de Guardia Nocturna

El bot **SOLO** responde mensajes entre las **20:00 y las 08:00 hs** (Argentina). Fuera de ese rango, los mensajes se ignoran en silencio (responde un coordinador humano).

Configurable con variables de entorno:
```
GUARD_START_HOUR=20  # 8 PM
GUARD_END_HOUR=8     # 8 AM
```

## 🛡️ Características de seguridad

1. **Safety net de crisis**: si el mensaje contiene palabras clave (suicidio, matarme, etc.), el endpoint de Vercel responde inmediatamente con el protocolo de emergencia (Línea 135 + 0800-345-1435) **sin pasar por la IA**
2. **Rate limiting**: máximo 1 mensaje por usuario cada 30 segundos (configurable con `RATE_LIMIT_SECONDS`)
3. **Filtro de grupos**: ignora mensajes de grupos (`@g.us`)
4. **Filtro de broadcasts**: ignora `status@broadcast`
5. **Solo texto**: ignora media, audio, stickers (por ahora)
6. **Secret compartido**: el endpoint de Vercel solo acepta requests con `x-api-secret` correcto

## 🔄 Persistencia de sesión

El cliente usa `LocalAuth` que guarda la sesión en `./whatsapp-session/`. Esto permite que el bot se reinicie sin pedir QR de nuevo.

**Importante**: en Render/Railway, montar un **volumen persistente** en `/app/whatsapp-session` para que la sesión sobreviva restarts. Si no montás volumen, el bot pedirá QR en cada deploy.

## 🚨 Troubleshooting

### El bot no responde mensajes
1. Verificá `/status` → `whatsappReady: true` y `guardActive: true`
2. Si `guardActive: false`, el bot está en horario diurno (no responde)
3. Si `whatsappReady: false`, el cliente se desconectó — reiniciá el servicio

### El QR no aparece
1. Verificá los logs del servicio
2. Abrí `https://TU-APP.onrender.com/qr` en el navegador
3. Si ya está autenticado, no aparecerá QR (eso es correcto)

### Puppeteer falla con "No usable sandbox"
El Dockerfile ya incluye las flags `--no-sandbox --disable-setuid-sandbox`. Si usás otro runtime, asegurate de pasar esas flags en `puppeteer.args`.

### Sesión se pierde en cada restart
Montá un volumen persistente en `/app/whatsapp-session`. Sin volumen, Render/Railway borra el filesystem en cada deploy.

## 📞 Soporte

- Endpoint Vercel: `https://www.redescuchapsicologica.com/api/whatsapp/process`
- Repo principal REP: `https://github.com/ccolonia/red-escucha-psicologica`
- Este microservicio: `https://github.com/ccolonia/rep-whatsapp-bot`
