FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy application source
COPY . .

# Create data directory for SQLite and set ownership
RUN mkdir -p /data && chown 1000:1000 /data

# Run as non-root user
USER 1000

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "server.js"]
