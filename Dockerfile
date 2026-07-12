# Build Stage
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build && cp src/dashboard/dashboard.html dist/dashboard/

# Remove development dependencies
RUN npm prune --omit=dev

# Production Stage
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

# Set Node environment to production
ENV NODE_ENV=production

# Copy built resources and production dependencies from builder
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist

# Create user and set permission
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /usr/src/app

USER appuser

CMD ["npm", "run", "start"]
