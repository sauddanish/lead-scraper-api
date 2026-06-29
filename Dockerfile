FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Install Playwright AFTER full project is available
RUN npx playwright install --with-deps
RUN npx playwright install chromium

EXPOSE 3000

CMD ["npm", "start"]
