FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/

# Data directory for SQLite databases
RUN mkdir -p /data && chown -R bun:bun /data
ENV A2A_MEMORY_DB=/data/a2a-memory.db
ENV OBSIDIAN_VAULT=/data/knowledge

# Run as non-root user for least-privilege execution
USER bun

# Expose orchestrator + all worker ports
EXPOSE 8080 8081 8082 8083 8084 8085 8086 8087 8088 8089 8090 8091 8092 8093 8094

# Start the orchestrator (spawns all workers)
CMD ["bun", "src/server.ts"]
