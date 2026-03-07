# GoApp Ride Match System — Local Development Setup Guide

Complete guide to set up, run, and test the GoApp Ride Match System on **Windows** and **macOS**.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Install Required Software](#2-install-required-software)
3. [Clone the Repository](#3-clone-the-repository)
4. [Environment Configuration](#4-environment-configuration)
5. [Running in Development Mode](#5-running-in-development-mode)
6. [Running in Test Mode](#6-running-in-test-mode)
7. [Running in Production (Local) Mode](#7-running-in-production-local-mode)
8. [Running Tests](#8-running-tests)
9. [API Verification](#9-api-verification)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites

| Requirement | Minimum Version | Purpose |
|-------------|-----------------|---------|
| Node.js | 18.x or later | Runtime for the application |
| npm | 9.x or later (bundled with Node.js) | Package manager |
| Git | 2.30+ | Version control |
| Docker Desktop | 4.x+ | Run PostgreSQL, Redis, Kafka containers |
| A code editor | VS Code recommended | Development |

### Optional (for full enterprise features)

| Requirement | Purpose |
|-------------|---------|
| PostgreSQL 16 client (`psql`) | Direct database access and debugging |
| Redis CLI (`redis-cli`) | Direct Redis inspection |
| cURL or Postman | API testing |
| Google Maps API Key | Real distance/ETA calculations (falls back to Haversine) |
| Firebase project credentials | Push notifications |
| Twilio / MSG91 / 2Factor account | SMS OTP delivery (defaults to console logging) |
| Razorpay test credentials | Payment gateway testing |

---

## 2. Install Required Software

### Windows

#### Node.js (v18+)

1. Download the Windows installer from [https://nodejs.org](https://nodejs.org) (LTS recommended).
2. Run the `.msi` installer — check **"Automatically install the necessary tools"** when prompted.
3. Open **PowerShell** or **Command Prompt** and verify:
   ```powershell
   node --version
   npm --version
   ```

#### Git

1. Download from [https://git-scm.com/download/win](https://git-scm.com/download/win).
2. Run the installer. Use default settings. Select **"Git from the command line and also from 3rd-party software"**.
3. Verify:
   ```powershell
   git --version
   ```

#### Docker Desktop

1. Download from [https://www.docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop).
2. Install and restart your machine if prompted.
3. Ensure **WSL 2 backend** is enabled (Settings → General → Use the WSL 2 based engine).
4. Verify:
   ```powershell
   docker --version
   docker compose version
   ```

---

### macOS

#### Node.js (v18+)

**Option A — Homebrew (recommended):**
```bash
brew install node@18
```

**Option B — Installer:**
1. Download the macOS installer from [https://nodejs.org](https://nodejs.org).
2. Run the `.pkg` installer.

Verify:
```bash
node --version
npm --version
```

#### Git

Git is pre-installed on macOS. If missing:
```bash
xcode-select --install
# or
brew install git
```

Verify:
```bash
git --version
```

#### Docker Desktop

1. Download from [https://www.docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop).
   - Choose **Apple Silicon** (M1/M2/M3/M4) or **Intel** based on your Mac.
2. Install by dragging to Applications.
3. Open Docker Desktop and wait for it to start.
4. Verify:
   ```bash
   docker --version
   docker compose version
   ```

---

## 3. Clone the Repository

```bash
git clone https://github.com/Kumaresan-sys/Ride_Match_System.git
cd Ride_Match_System/goapp-server
```

---

## 4. Environment Configuration

### 4.1 Install Node.js Dependencies

```bash
npm install
```

This installs the following dependencies:
- `dotenv` — Environment variable loader
- `pg` — PostgreSQL client
- `redis` — Redis client
- `firebase-admin` — Firebase push notifications
- `@googlemaps/google-maps-services-js` — Google Maps API

### 4.2 Create Environment File

```bash
cp .env.example .env
```

### 4.3 Environment Settings by Mode

The application supports three run modes. Edit `.env` to match your target mode:

#### Development Mode (default — zero external setup)

```env
NODE_ENV=development
DB_BACKEND=mock
REDIS_BACKEND=mock
SMS_PROVIDER=console
STORAGE_BACKEND=local
```

This mode uses **in-memory mocks** for the database, Redis, and Kafka. No external services needed — ideal for getting started quickly.

#### Test Mode (requires Docker infrastructure)

```env
NODE_ENV=test
DB_BACKEND=pg
REDIS_BACKEND=real
SMS_PROVIDER=console
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=goapp
POSTGRES_PASSWORD=goapp
POSTGRES_DB=goapp_enterprise
REDIS_HOST=localhost
REDIS_PORT=6379
```

#### Production Mode (full infrastructure)

```env
NODE_ENV=production
DB_BACKEND=pg
REDIS_BACKEND=real
SMS_PROVIDER=twilio
STORAGE_BACKEND=s3
POSTGRES_HOST=your-rds-endpoint
POSTGRES_SSL=true
POSTGRES_POOL_MAX=20
CORS_ORIGIN=https://your-domain.com
GOAPP_ADMIN_TOKEN=<strong-random-token>
```

---

## 5. Running in Development Mode

Development mode requires **no external services** — everything runs in-memory.

```bash
# Start the server
npm run start:dev
```

The server starts on:
- **HTTP API**: `http://localhost:3000`
- **WebSocket**: `ws://localhost:3001`

### Available Start Scripts

| Command | Description |
|---------|-------------|
| `npm run start:dev` | Development server (in-memory mocks) |
| `npm run api` | API-only mode (no simulation) |
| `npm run sim` | Simulation-only mode |
| `npm start` | Default start |

---

## 6. Running in Test Mode

Test mode uses **real PostgreSQL and Redis** via Docker.

### 6.1 Start Infrastructure with Docker Compose

```bash
cd enterprise-setup
docker compose up -d
```

This starts:
- **PostgreSQL 16 + PostGIS** on `localhost:5432`
- **Redis 7** on `localhost:6379`
- **Kafka 3.7** on `localhost:9092`
- **Zookeeper 3.9** on `localhost:2181`

### 6.2 Verify Infrastructure is Running

```bash
docker compose ps
```

All containers should show `healthy` or `running` status.

### 6.3 Database Schema

On first startup, PostgreSQL automatically loads all 248+ tables from the `sql/` directory. The schema covers 20 service domains:

| Domain | Tables |
|--------|--------|
| Identity & OTP | 17 |
| Driver Service | 22 |
| Rider Service | 10 |
| Ride Core | 28 |
| Dispatch/Matching | 18 |
| Location (PostGIS) | 12 |
| Pricing & Surge | 14 |
| Payment + Wallet | 20 |
| Driver Incentives | 12 |
| Notifications | 8 |
| Fraud & Risk | 12 |
| Promotions & Referrals | 12 |
| Safety / SOS | 8 |
| Scheduling | 5 |
| Corporate B2B | 6 |
| Support | 8 |
| Compliance | 6 |
| Saga Orchestration | 4 |
| Event System | 4 |
| Analytics / DW | 22 |
| **Total** | **248** |

### 6.4 Initialize Kafka Topics

```bash
cd sql
./init-topics.sh
```

**Windows note:** Run this inside WSL or Git Bash, as it is a shell script.

### 6.5 Start the Server in Test Mode

```bash
cd ..  # back to goapp-server/
npm run start:test
```

### 6.6 Reset Database (if needed)

To wipe and recreate all tables:
```bash
cd enterprise-setup
docker compose down -v
docker compose up -d
```

---

## 7. Running in Production (Local) Mode

For a production-like local environment:

1. Ensure Docker infrastructure is running (Section 6.1).
2. Set environment variables in `.env`:
   ```env
   NODE_ENV=production
   DB_BACKEND=pg
   REDIS_BACKEND=real
   GOAPP_ADMIN_TOKEN=<generate-a-strong-secret>
   CORS_ORIGIN=http://localhost:3000
   ```
3. Start the server:
   ```bash
   npm run start:prod
   ```

---

## 8. Running Tests

The project uses Node.js built-in test runner (no additional test framework required).

### Run All Tests

```bash
npm test
```

### Run Unit Tests Only

```bash
npm run test:unit
```

### Run Integration Tests Only

Integration tests require the Docker infrastructure to be running (Section 6.1).

```bash
npm run test:integration
```

### Test File Locations

```
goapp-server/tests/
├── contract-flows.test.js         # Contract and flow tests
├── helpers/                       # Test utilities
└── integration/                   # Integration tests (require DB)
```

---

## 9. API Verification

Once the server is running, verify with these endpoints:

### Health Check

```bash
curl http://localhost:3000/api/v1/health
```

### Microservices Status

```bash
curl http://localhost:3000/api/v1/microservices
```

### AWS Readiness Check

```bash
curl http://localhost:3000/api/v1/aws/readiness
```

### Request OTP (Test)

```bash
curl -X POST http://localhost:3000/api/v1/auth/otp/request \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+919876543210", "otpType": "login"}'
```

**Windows PowerShell equivalent:**
```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/health" -Method GET
```

---

## 10. Troubleshooting

### Port Already in Use

```bash
# Find the process using port 3000
# macOS/Linux:
lsof -i :3000
# Windows:
netstat -ano | findstr :3000
```

Kill the process or change `PORT` in `.env`.

### Docker Containers Not Starting

```bash
# Check container logs
docker compose -f enterprise-setup/docker-compose.yml logs

# Check specific container
docker logs goapp-postgres
docker logs goapp-redis
```

### PostgreSQL Connection Refused

- Ensure the container is running: `docker compose ps`
- Wait for the health check to pass (can take 10-30 seconds on first start)
- Verify credentials match between `.env` and `docker-compose.yml`

### npm install Fails

```bash
# Clear npm cache and retry
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

**Windows:**
```powershell
npm cache clean --force
Remove-Item -Recurse -Force node_modules, package-lock.json
npm install
```

### WSL 2 Issues (Windows)

If Docker containers cannot bind ports:
1. Open PowerShell as Administrator.
2. Run: `wsl --update`
3. Restart Docker Desktop.

### macOS Apple Silicon — Docker Performance

For M1/M2/M3/M4 Macs, ensure Docker Desktop has **"Use Rosetta for x86_64/amd64 emulation"** enabled in Settings → General for better compatibility with x86 container images.

---

## Quick Reference — Command Summary

| Task | Command |
|------|---------|
| Install dependencies | `npm install` |
| Start (development) | `npm run start:dev` |
| Start (test) | `npm run start:test` |
| Start (production) | `npm run start:prod` |
| Start infrastructure | `cd enterprise-setup && docker compose up -d` |
| Stop infrastructure | `cd enterprise-setup && docker compose down` |
| Reset database | `cd enterprise-setup && docker compose down -v && docker compose up -d` |
| Run all tests | `npm test` |
| Run unit tests | `npm run test:unit` |
| Run integration tests | `npm run test:integration` |
| Check container status | `docker compose ps` |
| View logs | `docker compose logs -f` |
