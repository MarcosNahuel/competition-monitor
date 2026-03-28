FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY src/ ./src/

EXPOSE 3100

CMD ["npx", "tsx", "src/server.ts"]
