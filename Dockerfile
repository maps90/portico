# syntax=docker/dockerfile:1

# --- build: compile the API to dist/ and the portal to web/dist/ ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

# --- deps: production node_modules only ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
# The portal is static once built, so its dependencies never reach the runtime image.
RUN npm ci --omit=dev --workspaces=false

# --- runtime ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORTICO_PORT=8080
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
EXPOSE 8080
USER node
CMD ["node", "dist/main.js"]
