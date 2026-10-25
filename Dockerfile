# 1. builds the interface (React, with Vite) into dist/
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY client ./client
RUN npm run build

# 2. the server, with the built interface only: the build tools stay in the first stage
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js auth.js backup.js bambu.js bambu-live.js push.js ./
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
RUN mkdir /data && chown node:node /data
ENV DATA_DIR=/data PORT=3000
VOLUME /data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
