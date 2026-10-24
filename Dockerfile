FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js auth.js backup.js bambu.js ./
COPY public ./public
COPY scripts ./scripts
RUN mkdir /data && chown node:node /data
ENV DATA_DIR=/data PORT=3000
VOLUME /data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
