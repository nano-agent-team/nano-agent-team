FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    apk del python3 make g++
COPY --from=builder /app/dist/ ./dist/

USER node
CMD ["node", "dist/index.js"]
