# Build stage
FROM node:26-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source code
COPY . .

# Build-time base path for Vite. When deploying behind a reverse-proxy subpath
# (e.g. /toolbox), pass `--build-arg VITE_BASE=/toolbox/` so all asset URLs
# in the generated index.html are prefixed. Default `/` keeps the standalone
# root-mounted layout working.
ARG VITE_BASE=/
ENV VITE_BASE=${VITE_BASE}

# Build the application
RUN npm run build

# Production stage
FROM node:26-slim AS production

WORKDIR /app

# Create non-root user
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --create-home nodejs

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built assets from builder
COPY --from=builder /app/dist ./dist

# Set ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Health check — respects URL_BASE_PATH so it works under subpath deployments.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000' + (process.env.URL_BASE_PATH || '') + '/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the application
CMD ["node", "dist/server/index.js"]
