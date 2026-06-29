FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install Playwright properly
RUN npx playwright install --with-deps
RUN npx playwright install chromium

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
