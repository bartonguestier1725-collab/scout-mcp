# Stage 1: Build (includes devDependencies for tsc)
FROM apify/actor-node:24 AS builder

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --include=dev

COPY --chown=myuser:myuser . ./
RUN npm run build

# Stage 2: Production (no devDependencies)
FROM apify/actor-node:24

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional

COPY --from=builder /usr/src/app/build ./build/

CMD ["node", "build/server.js"]
