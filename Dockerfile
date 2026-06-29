FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install ALL system dependencies (IMPORTANT FIX)
RUN apt-get update && apt-get install -y \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  libpangocairo-1.0-0 \
  libgtk-3-0 \
  libx11-xcb1 \
  libdrm2

COPY . .

# Install Playwright AFTER system deps
RUN npx playwright install --with-deps
RUN npx playwright install chromium

EXPOSE 3000

CMD ["npm", "start"]
ENV NODE_OPTIONS=--max-old-space-size=1024
