FROM node:18-bullseye-slim

# Instalar Chromium y sus dependencias automáticas de Debian
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Configurar Puppeteer para usar el Chromium instalado del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

# Usar 'npm start' para que aplique --max-old-space-size=128 (límite V8 del proceso Node)
# Esto sumado al --max-old-space-size=192 de Chromium = ~320MB max de V8 heap total,
# dejando ~190MB libres para el resto del sistema dentro de los 512MB de Render Free.
CMD ["npm", "start"]
