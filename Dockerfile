# scout-mcp — Multi-source search MCP server (stdio)
# Lists on Glama: glama.ai/mcp/servers/bartonguestier1725-collab/scout-mcp

FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies after build
RUN npm prune --omit=dev

ENV NODE_ENV=production

CMD ["node", "build/index.js"]
