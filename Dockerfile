FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8000
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
COPY . .
USER node
EXPOSE 8000
CMD ["node", "server.mjs"]
