#!/bin/bash
# ============================================================
# CSR Intelligence — VPS Deployment Script
# Run this once on your VPS after cloning the repo
# Tested on Ubuntu 22.04 / Debian 12
# ============================================================

set -e  # Exit on any error

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  CSR Intelligence DB — VPS Setup         ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. System dependencies ────────────────────────────────────────────────────
echo "[1/7] Installing system dependencies..."
apt-get update -q
apt-get install -y nodejs npm postgresql postgresql-contrib

# Install Node.js 20 if not already installed
if ! node --version | grep -q "v20"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Install PM2 globally (process manager — keeps scheduler alive)
npm install -g pm2 ts-node typescript
echo "     ✓ Node $(node --version) | PM2 $(pm2 --version)"

# ── 2. PostgreSQL setup ───────────────────────────────────────────────────────
echo "[2/7] Setting up PostgreSQL..."
systemctl start postgresql
systemctl enable postgresql

# Create DB user and database
sudo -u postgres psql <<EOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'csr_user') THEN
    CREATE ROLE csr_user WITH LOGIN PASSWORD 'changeme_strong_password';
  END IF;
END
\$\$;

CREATE DATABASE csr_intelligence OWNER csr_user;
GRANT ALL PRIVILEGES ON DATABASE csr_intelligence TO csr_user;
EOF

echo "     ✓ PostgreSQL ready: csr_intelligence database created"
echo "     ⚠  Change the password in .env and above before production!"

# ── 3. App setup ──────────────────────────────────────────────────────────────
echo "[3/7] Installing Node.js dependencies..."
cd /opt/csr-intelligence  # adjust path to where you cloned the repo
npm install
echo "     ✓ Dependencies installed"

# ── 4. Environment config ─────────────────────────────────────────────────────
echo "[4/7] Setting up environment config..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "     ⚠  .env created from template. Edit it now:"
  echo "     nano /opt/csr-intelligence/.env"
  echo ""
  echo "     Required values to fill in:"
  echo "     - ANTHROPIC_API_KEY"
  echo "     - DATABASE_URL (update password)"
  echo "     - REVIEW_WEBHOOK_URL (optional Slack webhook)"
  echo ""
  read -p "Press Enter after editing .env to continue..."
fi

# ── 5. Database migration ─────────────────────────────────────────────────────
echo "[5/7] Running database migrations..."
npm run db:migrate
echo "     ✓ Tables created"

# ── 6. First-run: seed + full pipeline ───────────────────────────────────────
echo "[6/7] Running initial full pipeline (first ingestion)..."
echo "     This takes 2–4 hours for 200 entities. Running in background."
npm run ingest:discovery &
DISCOVERY_PID=$!
wait $DISCOVERY_PID
echo "     ✓ Discovery complete — stubs seeded"

# Start enrichment + verification in background via PM2
pm2 start npm --name "csr-enrichment" -- run ingest:enrich
pm2 start npm --name "csr-verification" -- run ingest:verify
echo "     ✓ Enrichment + verification running in background via PM2"

# ── 7. PM2 scheduler setup ────────────────────────────────────────────────────
echo "[7/7] Setting up PM2 scheduler (not 24/7 — cron-triggered only)..."

# ecosystem.config.js tells PM2 how to manage each process
cat > /opt/csr-intelligence/ecosystem.config.js << 'ECOSYSTEM'
module.exports = {
  apps: [
    {
      // Scheduler: runs continuously, wakes on cron triggers
      // NOT CPU-intensive between triggers
      name: 'csr-scheduler',
      script: 'src/scheduler/cron.ts',
      interpreter: 'ts-node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: { NODE_ENV: 'production' },
      log_file: './logs/scheduler.log',
      error_file: './logs/scheduler-error.log',
      time: true,
    },
    // One-shot agents are launched by coordinator/cron, not persistent
    // They start, do work, and exit — PM2 does NOT autorestart them
    {
      name: 'csr-enrichment',
      script: 'src/agents/enrichment.agent.ts',
      interpreter: 'ts-node',
      watch: false,
      autorestart: false,   // <-- exits when queue is empty
      env: { NODE_ENV: 'production' },
      log_file: './logs/enrichment.log',
    },
  ],
};
ECOSYSTEM

pm2 start ecosystem.config.js
pm2 save
pm2 startup  # register PM2 to start on VPS reboot

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  DEPLOYMENT COMPLETE                                 ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  pm2 status          — view running processes        ║"
echo "║  pm2 logs            — tail all logs                 ║"
echo "║  pm2 logs csr-scheduler — scheduler logs only        ║"
echo "║                                                      ║"
echo "║  Manual triggers (from /opt/csr-intelligence):      ║"
echo "║  npm run ingest:discovery                            ║"
echo "║  npm run ingest:enrich                               ║"
echo "║  npm run ingest:verify                               ║"
echo "║  npm run ingest:drift                                ║"
echo "║                                                      ║"
echo "║  Scheduler auto-runs:                                ║"
echo "║  • Discovery      — daily 6am IST                   ║"
echo "║  • Enrichment     — daily 7am IST                   ║"
echo "║  • Refresh        — daily 10am IST                  ║"
echo "║  • Drift recompute — Sunday 2am IST                 ║"
echo "║  • QA report      — Monday 8am IST                  ║"
echo "╚══════════════════════════════════════════════════════╝"
