# Build context is services/api-gateway/ (Railway: set this service's
# "Root Directory" to services/api-gateway).

FROM node:20-slim AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /build/dist ./dist

EXPOSE 8080
CMD ["node", "dist/index.js"]
