# PokéSurvivor MCP relay: remote MCP for agents + SSE/POST endpoints for the game page.
# Runs behind the web container's nginx (/mcp, /agent/); no port is published.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
