FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/

# Expose orchestrator + worker ports
EXPOSE 8080 8081 8082 8083 8084 8085 8086 8087

# Start the orchestrator (spawns all workers)
CMD ["bun", "src/server.ts"]
