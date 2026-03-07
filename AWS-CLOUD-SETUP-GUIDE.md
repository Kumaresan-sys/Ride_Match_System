# GoApp Ride Match System — AWS Cloud Architecture Setup Guide

Complete guide for deploying the GoApp Ride Match System on AWS with production-grade infrastructure.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [AWS Services Required](#2-aws-services-required)
3. [Prerequisites](#3-prerequisites)
4. [Phase 1 — Networking (VPC & Subnets)](#4-phase-1--networking-vpc--subnets)
5. [Phase 2 — Database Layer (Aurora PostgreSQL)](#5-phase-2--database-layer-aurora-postgresql)
6. [Phase 3 — Caching Layer (ElastiCache Redis)](#6-phase-3--caching-layer-elasticache-redis)
7. [Phase 4 — Event Streaming (Amazon MSK / Kafka)](#7-phase-4--event-streaming-amazon-msk--kafka)
8. [Phase 5 — Object Storage (S3)](#8-phase-5--object-storage-s3)
9. [Phase 6 — Container Deployment (ECS Fargate)](#9-phase-6--container-deployment-ecs-fargate)
10. [Phase 7 — Load Balancer & DNS](#10-phase-7--load-balancer--dns)
11. [Phase 8 — CDN (CloudFront)](#11-phase-8--cdn-cloudfront)
12. [Phase 9 — Security & WAF](#12-phase-9--security--waf)
13. [Phase 10 — Observability](#13-phase-10--observability)
14. [Phase 11 — CI/CD Pipeline](#14-phase-11--cicd-pipeline)
15. [Environment Variables for AWS](#15-environment-variables-for-aws)
16. [Cost Estimation](#16-cost-estimation)
17. [Architecture Diagram](#17-architecture-diagram)

---

## 1. Architecture Overview

The GoApp Ride Match System is a microservice-based ride-hailing platform designed for AWS deployment in the **ap-south-1 (Mumbai)** region. The architecture uses:

- **ECS Fargate** for serverless container orchestration
- **Aurora PostgreSQL 16** with PostGIS for geospatial ride data
- **ElastiCache Redis 7** for real-time location tracking, caching, and distributed locks
- **Amazon MSK (Kafka)** for event streaming across microservices
- **S3** for driver document storage
- **ALB** for load balancing with WebSocket support
- **CloudFront** for CDN and mobile client delivery
- **CloudWatch + X-Ray** for observability

### Microservices

| Service | Port | Responsibility |
|---------|------|----------------|
| API Gateway | 3000 | Request routing, auth, rate limiting |
| Location Service | 3011 | Real-time GPS tracking (Redis GEO) |
| Matching Engine | 3012 | Driver-rider matching (multi-stage) |
| Pricing Service | 3013 | Fare calculation, surge pricing |
| Ride Service | 3014 | Ride lifecycle state machine |
| Event Service | 3015 | Event bus, Kafka producers/consumers |
| WebSocket Gateway | 3001 | Real-time push to clients |

---

## 2. AWS Services Required

| Category | Service | Purpose | Estimated Monthly Cost |
|----------|---------|---------|----------------------|
| **Compute** | ECS Fargate | Container hosting | $150–500 |
| **Database** | Aurora PostgreSQL | Primary OLTP (248 tables) | $200–800 |
| **Cache** | ElastiCache Redis | GEO, locks, session cache | $100–300 |
| **Streaming** | Amazon MSK | Kafka event streaming | $200–600 |
| **Storage** | S3 | Driver documents, media | $10–50 |
| **Networking** | ALB | HTTP/WebSocket load balancing | $30–100 |
| **CDN** | CloudFront | Static asset delivery | $20–100 |
| **DNS** | Route 53 | Domain management | $1–5 |
| **Security** | WAF, ACM | Firewall, SSL certificates | $10–50 |
| **Monitoring** | CloudWatch, X-Ray | Logs, metrics, traces | $30–100 |
| **Secrets** | Secrets Manager | API keys, DB credentials | $5–10 |
| **Container Registry** | ECR | Docker image storage | $5–20 |

---

## 3. Prerequisites

### 3.1 AWS Account Setup

1. Create an AWS account at [https://aws.amazon.com](https://aws.amazon.com).
2. Enable MFA on the root account.
3. Create an IAM user with **AdministratorAccess** for initial setup.
4. Install and configure AWS CLI:
   ```bash
   # macOS
   brew install awscli

   # Windows
   # Download from https://aws.amazon.com/cli/

   # Configure credentials
   aws configure
   # AWS Access Key ID: <your-key>
   # AWS Secret Access Key: <your-secret>
   # Default region: ap-south-1
   # Default output format: json
   ```

### 3.2 Tools to Install

| Tool | Install Command | Purpose |
|------|----------------|---------|
| AWS CLI v2 | See above | AWS resource management |
| Docker | `brew install docker` | Container builds |
| Terraform (optional) | `brew install terraform` | Infrastructure as Code |
| psql client | `brew install postgresql` | Database access |
| redis-cli | `brew install redis` | Cache inspection |

### 3.3 Domain Name

Register a domain or use an existing one. You'll need it for:
- API endpoint: `api.yourdomain.com`
- WebSocket endpoint: `ws.yourdomain.com`
- CDN: `cdn.yourdomain.com`

---

## 4. Phase 1 — Networking (VPC & Subnets)

### 4.1 Create VPC

```bash
aws ec2 create-vpc \
  --cidr-block 10.0.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=goapp-vpc}]' \
  --region ap-south-1
```

### 4.2 Create Subnets

Create subnets across 2 availability zones for high availability:

**Public Subnets** (for ALB):
```bash
# Public Subnet AZ-a
aws ec2 create-subnet \
  --vpc-id <vpc-id> \
  --cidr-block 10.0.1.0/24 \
  --availability-zone ap-south-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=goapp-public-1a}]'

# Public Subnet AZ-b
aws ec2 create-subnet \
  --vpc-id <vpc-id> \
  --cidr-block 10.0.2.0/24 \
  --availability-zone ap-south-1b \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=goapp-public-1b}]'
```

**Private Subnets** (for ECS, Aurora, Redis, MSK):
```bash
# Private Subnet AZ-a
aws ec2 create-subnet \
  --vpc-id <vpc-id> \
  --cidr-block 10.0.10.0/24 \
  --availability-zone ap-south-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=goapp-private-1a}]'

# Private Subnet AZ-b
aws ec2 create-subnet \
  --vpc-id <vpc-id> \
  --cidr-block 10.0.11.0/24 \
  --availability-zone ap-south-1b \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=goapp-private-1b}]'
```

### 4.3 Internet Gateway & NAT Gateway

```bash
# Internet Gateway (for public subnets)
aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=goapp-igw}]'

aws ec2 attach-internet-gateway --internet-gateway-id <igw-id> --vpc-id <vpc-id>

# Elastic IP for NAT Gateway
aws ec2 allocate-address --domain vpc

# NAT Gateway (for private subnet internet access)
aws ec2 create-nat-gateway \
  --subnet-id <public-subnet-1a-id> \
  --allocation-id <eip-alloc-id> \
  --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=goapp-nat}]'
```

### 4.4 Route Tables

```bash
# Public route table → Internet Gateway
aws ec2 create-route-table --vpc-id <vpc-id> \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=goapp-public-rt}]'
aws ec2 create-route --route-table-id <public-rt-id> \
  --destination-cidr-block 0.0.0.0/0 --gateway-id <igw-id>

# Private route table → NAT Gateway
aws ec2 create-route-table --vpc-id <vpc-id> \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=goapp-private-rt}]'
aws ec2 create-route --route-table-id <private-rt-id> \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id <nat-id>
```

### 4.5 Security Groups

```bash
# ALB Security Group (public-facing)
aws ec2 create-security-group \
  --group-name goapp-alb-sg \
  --description "GoApp ALB - HTTP/HTTPS" \
  --vpc-id <vpc-id>
aws ec2 authorize-security-group-ingress --group-id <alb-sg-id> \
  --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id <alb-sg-id> \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

# ECS Security Group (private — only ALB can reach)
aws ec2 create-security-group \
  --group-name goapp-ecs-sg \
  --description "GoApp ECS Tasks" \
  --vpc-id <vpc-id>
aws ec2 authorize-security-group-ingress --group-id <ecs-sg-id> \
  --protocol tcp --port 3000-3015 --source-group <alb-sg-id>

# Database Security Group (private — only ECS can reach)
aws ec2 create-security-group \
  --group-name goapp-db-sg \
  --description "GoApp Aurora PostgreSQL" \
  --vpc-id <vpc-id>
aws ec2 authorize-security-group-ingress --group-id <db-sg-id> \
  --protocol tcp --port 5432 --source-group <ecs-sg-id>

# Redis Security Group (private — only ECS can reach)
aws ec2 create-security-group \
  --group-name goapp-redis-sg \
  --description "GoApp ElastiCache Redis" \
  --vpc-id <vpc-id>
aws ec2 authorize-security-group-ingress --group-id <redis-sg-id> \
  --protocol tcp --port 6379 --source-group <ecs-sg-id>

# MSK Security Group (private — only ECS can reach)
aws ec2 create-security-group \
  --group-name goapp-msk-sg \
  --description "GoApp MSK Kafka" \
  --vpc-id <vpc-id>
aws ec2 authorize-security-group-ingress --group-id <msk-sg-id> \
  --protocol tcp --port 9092 --source-group <ecs-sg-id>
```

---

## 5. Phase 2 — Database Layer (Aurora PostgreSQL)

### 5.1 Create Aurora Subnet Group

```bash
aws rds create-db-subnet-group \
  --db-subnet-group-name goapp-db-subnets \
  --db-subnet-group-description "GoApp Aurora subnets" \
  --subnet-ids <private-subnet-1a-id> <private-subnet-1b-id>
```

### 5.2 Create Aurora PostgreSQL Cluster

```bash
aws rds create-db-cluster \
  --db-cluster-identifier goapp-aurora-cluster \
  --engine aurora-postgresql \
  --engine-version 16.1 \
  --master-username goapp \
  --master-user-password <strong-password> \
  --db-subnet-group-name goapp-db-subnets \
  --vpc-security-group-ids <db-sg-id> \
  --database-name goapp_enterprise \
  --backup-retention-period 7 \
  --preferred-backup-window "03:00-04:00" \
  --storage-encrypted \
  --region ap-south-1
```

### 5.3 Create Aurora Instances

```bash
# Writer instance
aws rds create-db-instance \
  --db-instance-identifier goapp-aurora-writer \
  --db-cluster-identifier goapp-aurora-cluster \
  --engine aurora-postgresql \
  --db-instance-class db.r6g.large \
  --region ap-south-1

# Reader instance (for read replicas)
aws rds create-db-instance \
  --db-instance-identifier goapp-aurora-reader \
  --db-cluster-identifier goapp-aurora-cluster \
  --engine aurora-postgresql \
  --db-instance-class db.r6g.large \
  --region ap-south-1
```

### 5.4 Enable PostGIS Extension

Connect to the database and enable required extensions:

```bash
psql -h <aurora-writer-endpoint> -U goapp -d goapp_enterprise
```

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

### 5.5 Run Schema Migrations

From your local machine (or a bastion host with VPC access):

```bash
cd goapp-server/enterprise-setup/sql

# Set environment variables for the migration script
export DB_HOST=<aurora-writer-endpoint>
export DB_PORT=5432
export DB_NAME=goapp_enterprise
export DB_USER=goapp
export DB_PASS=<your-password>

./run-migrations.sh
```

This creates all **248 core tables** across 20 service domains plus extension tables.

---

## 6. Phase 3 — Caching Layer (ElastiCache Redis)

### 6.1 Create Redis Subnet Group

```bash
aws elasticache create-cache-subnet-group \
  --cache-subnet-group-name goapp-redis-subnets \
  --cache-subnet-group-description "GoApp Redis subnets" \
  --subnet-ids <private-subnet-1a-id> <private-subnet-1b-id>
```

### 6.2 Create Redis Cluster

```bash
aws elasticache create-replication-group \
  --replication-group-id goapp-redis \
  --replication-group-description "GoApp Redis - location, locks, cache" \
  --engine redis \
  --engine-version 7.0 \
  --cache-node-type cache.r6g.large \
  --num-cache-clusters 2 \
  --cache-subnet-group-name goapp-redis-subnets \
  --security-group-ids <redis-sg-id> \
  --at-rest-encryption-enabled \
  --transit-encryption-enabled \
  --automatic-failover-enabled \
  --region ap-south-1
```

Redis is used for:
- **GEO commands** — Real-time driver location tracking
- **SETNX** — Distributed locks for ride matching
- **Pub/Sub** — Real-time event broadcasting
- **TTL keys** — Session caching, OTP storage

---

## 7. Phase 4 — Event Streaming (Amazon MSK / Kafka)

### 7.1 Create MSK Cluster

```bash
aws kafka create-cluster \
  --cluster-name goapp-msk \
  --kafka-version 3.7.x \
  --number-of-broker-nodes 2 \
  --broker-node-group-info '{
    "InstanceType": "kafka.m5.large",
    "ClientSubnets": ["<private-subnet-1a-id>", "<private-subnet-1b-id>"],
    "SecurityGroups": ["<msk-sg-id>"],
    "StorageInfo": {"EbsStorageInfo": {"VolumeSize": 100}}
  }' \
  --encryption-info '{
    "EncryptionInTransit": {"ClientBroker": "TLS_PLAINTEXT", "InCluster": true}
  }' \
  --region ap-south-1
```

### 7.2 Create Kafka Topics

Once MSK is active, connect from an ECS task or bastion host and create topics:

```bash
# Key topics for the GoApp event system
kafka-topics.sh --create --bootstrap-server <msk-broker-endpoint>:9092 \
  --topic ride.requested --partitions 6 --replication-factor 2

kafka-topics.sh --create --bootstrap-server <msk-broker-endpoint>:9092 \
  --topic ride.matched --partitions 6 --replication-factor 2

kafka-topics.sh --create --bootstrap-server <msk-broker-endpoint>:9092 \
  --topic ride.completed --partitions 6 --replication-factor 2

kafka-topics.sh --create --bootstrap-server <msk-broker-endpoint>:9092 \
  --topic driver.location --partitions 12 --replication-factor 2

kafka-topics.sh --create --bootstrap-server <msk-broker-endpoint>:9092 \
  --topic payment.events --partitions 6 --replication-factor 2

kafka-topics.sh --create --bootstrap-server <msk-broker-endpoint>:9092 \
  --topic notification.events --partitions 3 --replication-factor 2
```

---

## 8. Phase 5 — Object Storage (S3)

### 8.1 Create S3 Buckets

```bash
# Driver documents (license, vehicle RC, insurance)
aws s3 mb s3://goapp-driver-documents-prod --region ap-south-1

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket goapp-driver-documents-prod \
  --versioning-configuration Status=Enabled

# Enable server-side encryption
aws s3api put-bucket-encryption \
  --bucket goapp-driver-documents-prod \
  --server-side-encryption-configuration '{
    "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "aws:kms"}}]
  }'

# Block public access
aws s3api put-public-access-block \
  --bucket goapp-driver-documents-prod \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

---

## 9. Phase 6 — Container Deployment (ECS Fargate)

### 9.1 Create ECR Repository

```bash
aws ecr create-repository \
  --repository-name goapp-server \
  --image-scanning-configuration scanOnPush=true \
  --region ap-south-1
```

### 9.2 Build and Push Docker Image

Create a `Dockerfile` in `goapp-server/`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/v1/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "server.js"]
```

Build and push:

```bash
# Login to ECR
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin <account-id>.dkr.ecr.ap-south-1.amazonaws.com

# Build
docker build -t goapp-server .

# Tag
docker tag goapp-server:latest \
  <account-id>.dkr.ecr.ap-south-1.amazonaws.com/goapp-server:latest

# Push
docker push <account-id>.dkr.ecr.ap-south-1.amazonaws.com/goapp-server:latest
```

### 9.3 Create ECS Cluster

```bash
aws ecs create-cluster \
  --cluster-name goapp-cluster \
  --capacity-providers FARGATE FARGATE_SPOT \
  --default-capacity-provider-strategy \
    capacityProvider=FARGATE,weight=1 \
    capacityProvider=FARGATE_SPOT,weight=3 \
  --region ap-south-1
```

### 9.4 Create Task Execution Role

```bash
# Create IAM role for ECS tasks
aws iam create-role \
  --role-name goapp-ecs-task-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach policies
aws iam attach-role-policy --role-name goapp-ecs-task-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam attach-role-policy --role-name goapp-ecs-task-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess

aws iam attach-role-policy --role-name goapp-ecs-task-role \
  --policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite
```

### 9.5 Store Secrets in AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name goapp/production \
  --description "GoApp production secrets" \
  --secret-string '{
    "POSTGRES_PASSWORD": "<aurora-password>",
    "GOAPP_ADMIN_TOKEN": "<strong-admin-token>",
    "RAZORPAY_KEY_ID": "<razorpay-key>",
    "RAZORPAY_KEY_SECRET": "<razorpay-secret>",
    "RAZORPAY_WEBHOOK_SECRET": "<webhook-secret>",
    "FIREBASE_PRIVATE_KEY": "<firebase-key>",
    "TWILIO_AUTH_TOKEN": "<twilio-token>"
  }' \
  --region ap-south-1
```

### 9.6 Create Task Definition

Save as `task-definition.json`:

```json
{
  "family": "goapp-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::<account-id>:role/goapp-ecs-task-role",
  "taskRoleArn": "arn:aws:iam::<account-id>:role/goapp-ecs-task-role",
  "containerDefinitions": [
    {
      "name": "goapp-server",
      "image": "<account-id>.dkr.ecr.ap-south-1.amazonaws.com/goapp-server:latest",
      "portMappings": [
        {"containerPort": 3000, "protocol": "tcp"},
        {"containerPort": 3001, "protocol": "tcp"}
      ],
      "environment": [
        {"name": "NODE_ENV", "value": "production"},
        {"name": "PORT", "value": "3000"},
        {"name": "WS_PORT", "value": "3001"},
        {"name": "DB_BACKEND", "value": "pg"},
        {"name": "REDIS_BACKEND", "value": "real"},
        {"name": "STORAGE_BACKEND", "value": "s3"},
        {"name": "POSTGRES_HOST", "value": "<aurora-writer-endpoint>"},
        {"name": "POSTGRES_PORT", "value": "5432"},
        {"name": "POSTGRES_USER", "value": "goapp"},
        {"name": "POSTGRES_DB", "value": "goapp_enterprise"},
        {"name": "POSTGRES_SSL", "value": "true"},
        {"name": "POSTGRES_POOL_MAX", "value": "20"},
        {"name": "REDIS_HOST", "value": "<elasticache-endpoint>"},
        {"name": "REDIS_PORT", "value": "6379"},
        {"name": "KAFKA_BROKERS", "value": "<msk-broker-endpoint>:9092"},
        {"name": "AWS_REGION", "value": "ap-south-1"},
        {"name": "CORS_ORIGIN", "value": "https://yourdomain.com"},
        {"name": "SMS_PROVIDER", "value": "twilio"}
      ],
      "secrets": [
        {"name": "POSTGRES_PASSWORD", "valueFrom": "arn:aws:secretsmanager:ap-south-1:<account-id>:secret:goapp/production:POSTGRES_PASSWORD::"},
        {"name": "GOAPP_ADMIN_TOKEN", "valueFrom": "arn:aws:secretsmanager:ap-south-1:<account-id>:secret:goapp/production:GOAPP_ADMIN_TOKEN::"},
        {"name": "RAZORPAY_KEY_ID", "valueFrom": "arn:aws:secretsmanager:ap-south-1:<account-id>:secret:goapp/production:RAZORPAY_KEY_ID::"},
        {"name": "RAZORPAY_KEY_SECRET", "valueFrom": "arn:aws:secretsmanager:ap-south-1:<account-id>:secret:goapp/production:RAZORPAY_KEY_SECRET::"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/goapp-api",
          "awslogs-region": "ap-south-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "node -e \"require('http').get('http://localhost:3000/api/v1/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))\""],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 15
      }
    }
  ]
}
```

Register the task definition:

```bash
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

### 9.7 Create ECS Service

```bash
aws ecs create-service \
  --cluster goapp-cluster \
  --service-name goapp-api \
  --task-definition goapp-api \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration '{
    "awsvpcConfiguration": {
      "subnets": ["<private-subnet-1a-id>", "<private-subnet-1b-id>"],
      "securityGroups": ["<ecs-sg-id>"],
      "assignPublicIp": "DISABLED"
    }
  }' \
  --load-balancers '[{
    "targetGroupArn": "<target-group-arn>",
    "containerName": "goapp-server",
    "containerPort": 3000
  }]' \
  --health-check-grace-period-seconds 60 \
  --region ap-south-1
```

---

## 10. Phase 7 — Load Balancer & DNS

### 10.1 Create Application Load Balancer

```bash
aws elbv2 create-load-balancer \
  --name goapp-alb \
  --subnets <public-subnet-1a-id> <public-subnet-1b-id> \
  --security-groups <alb-sg-id> \
  --scheme internet-facing \
  --type application \
  --region ap-south-1
```

### 10.2 Create Target Groups

```bash
# HTTP API target group
aws elbv2 create-target-group \
  --name goapp-api-tg \
  --protocol HTTP \
  --port 3000 \
  --vpc-id <vpc-id> \
  --target-type ip \
  --health-check-path /api/v1/health \
  --health-check-interval-seconds 30

# WebSocket target group
aws elbv2 create-target-group \
  --name goapp-ws-tg \
  --protocol HTTP \
  --port 3001 \
  --vpc-id <vpc-id> \
  --target-type ip \
  --health-check-path /
```

### 10.3 Request SSL Certificate

```bash
aws acm request-certificate \
  --domain-name api.yourdomain.com \
  --subject-alternative-names ws.yourdomain.com \
  --validation-method DNS \
  --region ap-south-1
```

### 10.4 Create HTTPS Listener

```bash
aws elbv2 create-listener \
  --load-balancer-arn <alb-arn> \
  --protocol HTTPS \
  --port 443 \
  --certificates CertificateArn=<acm-cert-arn> \
  --default-actions Type=forward,TargetGroupArn=<api-tg-arn>
```

### 10.5 Add WebSocket Routing Rule

```bash
aws elbv2 create-rule \
  --listener-arn <https-listener-arn> \
  --conditions '[{"Field": "host-header", "Values": ["ws.yourdomain.com"]}]' \
  --actions '[{"Type": "forward", "TargetGroupArn": "<ws-tg-arn>"}]' \
  --priority 10
```

### 10.6 Route 53 DNS Records

```bash
# API endpoint
aws route53 change-resource-record-sets \
  --hosted-zone-id <zone-id> \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.yourdomain.com",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "<alb-hosted-zone-id>",
          "DNSName": "<alb-dns-name>",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

---

## 11. Phase 8 — CDN (CloudFront)

### 11.1 Create CloudFront Distribution

```bash
aws cloudfront create-distribution \
  --distribution-config '{
    "CallerReference": "goapp-cdn-1",
    "Origins": {
      "Quantity": 1,
      "Items": [{
        "Id": "goapp-alb",
        "DomainName": "<alb-dns-name>",
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only"
        }
      }]
    },
    "DefaultCacheBehavior": {
      "TargetOriginId": "goapp-alb",
      "ViewerProtocolPolicy": "redirect-to-https",
      "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
      "AllowedMethods": {"Quantity": 7, "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"]},
      "Compress": true
    },
    "Enabled": true,
    "Comment": "GoApp CDN"
  }'
```

---

## 12. Phase 9 — Security & WAF

### 12.1 Create WAF Web ACL

```bash
aws wafv2 create-web-acl \
  --name goapp-waf \
  --scope REGIONAL \
  --default-action '{"Allow": {}}' \
  --rules '[
    {
      "Name": "RateLimit",
      "Priority": 1,
      "Statement": {"RateBasedStatement": {"Limit": 2000, "AggregateKeyType": "IP"}},
      "Action": {"Block": {}},
      "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "RateLimit"}
    },
    {
      "Name": "AWSManagedRulesCommonRuleSet",
      "Priority": 2,
      "Statement": {"ManagedRuleGroupStatement": {"VendorName": "AWS", "Name": "AWSManagedRulesCommonRuleSet"}},
      "OverrideAction": {"None": {}},
      "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "CommonRules"}
    },
    {
      "Name": "AWSManagedRulesSQLiRuleSet",
      "Priority": 3,
      "Statement": {"ManagedRuleGroupStatement": {"VendorName": "AWS", "Name": "AWSManagedRulesSQLiRuleSet"}},
      "OverrideAction": {"None": {}},
      "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "SQLiRules"}
    }
  ]' \
  --visibility-config '{"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "goapp-waf"}' \
  --region ap-south-1
```

### 12.2 Associate WAF with ALB

```bash
aws wafv2 associate-web-acl \
  --web-acl-arn <waf-acl-arn> \
  --resource-arn <alb-arn> \
  --region ap-south-1
```

---

## 13. Phase 10 — Observability

### 13.1 CloudWatch Log Group

```bash
aws logs create-log-group \
  --log-group-name /ecs/goapp-api \
  --retention-in-days 30 \
  --region ap-south-1
```

### 13.2 CloudWatch Alarms

```bash
# High CPU alarm
aws cloudwatch put-metric-alarm \
  --alarm-name goapp-cpu-high \
  --metric-name CPUUtilization \
  --namespace AWS/ECS \
  --statistic Average \
  --period 300 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --dimensions Name=ClusterName,Value=goapp-cluster Name=ServiceName,Value=goapp-api \
  --alarm-actions <sns-topic-arn>

# Database connections alarm
aws cloudwatch put-metric-alarm \
  --alarm-name goapp-db-connections-high \
  --metric-name DatabaseConnections \
  --namespace AWS/RDS \
  --statistic Average \
  --period 300 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --dimensions Name=DBClusterIdentifier,Value=goapp-aurora-cluster \
  --alarm-actions <sns-topic-arn>
```

### 13.3 Auto Scaling

```bash
# Register scalable target
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/goapp-cluster/goapp-api \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 \
  --max-capacity 10

# CPU-based scaling policy
aws application-autoscaling put-scaling-policy \
  --policy-name goapp-cpu-scaling \
  --service-namespace ecs \
  --resource-id service/goapp-cluster/goapp-api \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 70,
    "PredefinedMetricSpecification": {"PredefinedMetricType": "ECSServiceAverageCPUUtilization"},
    "ScaleInCooldown": 300,
    "ScaleOutCooldown": 60
  }'
```

---

## 14. Phase 11 — CI/CD Pipeline

### 14.1 GitHub Actions Workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to AWS ECS

on:
  push:
    branches: [main]

env:
  AWS_REGION: ap-south-1
  ECR_REPOSITORY: goapp-server
  ECS_CLUSTER: goapp-cluster
  ECS_SERVICE: goapp-api

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          cd goapp-server
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:latest .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
          docker push $ECR_REGISTRY/$ECR_REPOSITORY:latest

      - name: Run tests
        run: |
          cd goapp-server
          npm ci
          npm test

      - name: Deploy to ECS
        run: |
          aws ecs update-service \
            --cluster $ECS_CLUSTER \
            --service $ECS_SERVICE \
            --force-new-deployment \
            --region $AWS_REGION
```

---

## 15. Environment Variables for AWS

Set these in the ECS task definition or Secrets Manager:

| Variable | Value | Source |
|----------|-------|--------|
| `NODE_ENV` | `production` | Task definition |
| `PORT` | `3000` | Task definition |
| `WS_PORT` | `3001` | Task definition |
| `DB_BACKEND` | `pg` | Task definition |
| `REDIS_BACKEND` | `real` | Task definition |
| `STORAGE_BACKEND` | `s3` | Task definition |
| `POSTGRES_HOST` | Aurora writer endpoint | Task definition |
| `POSTGRES_PORT` | `5432` | Task definition |
| `POSTGRES_USER` | `goapp` | Task definition |
| `POSTGRES_PASSWORD` | Aurora password | Secrets Manager |
| `POSTGRES_DB` | `goapp_enterprise` | Task definition |
| `POSTGRES_SSL` | `true` | Task definition |
| `POSTGRES_POOL_MAX` | `20` | Task definition |
| `REDIS_HOST` | ElastiCache endpoint | Task definition |
| `REDIS_PORT` | `6379` | Task definition |
| `KAFKA_BROKERS` | MSK broker endpoints | Task definition |
| `AWS_REGION` | `ap-south-1` | Task definition |
| `CORS_ORIGIN` | `https://yourdomain.com` | Task definition |
| `GOAPP_ADMIN_TOKEN` | Strong random token | Secrets Manager |
| `SMS_PROVIDER` | `twilio` | Task definition |
| `TWILIO_ACCOUNT_SID` | Twilio SID | Secrets Manager |
| `TWILIO_AUTH_TOKEN` | Twilio token | Secrets Manager |
| `FIREBASE_PROJECT_ID` | Firebase project ID | Task definition |
| `FIREBASE_CLIENT_EMAIL` | Firebase email | Task definition |
| `FIREBASE_PRIVATE_KEY` | Firebase key | Secrets Manager |
| `RAZORPAY_KEY_ID` | Razorpay key | Secrets Manager |
| `RAZORPAY_KEY_SECRET` | Razorpay secret | Secrets Manager |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook secret | Secrets Manager |

---

## 16. Cost Estimation

### Minimum Production Setup (Low Traffic)

| Service | Config | Monthly Cost (USD) |
|---------|--------|-------------------|
| ECS Fargate | 2 tasks, 1 vCPU, 2 GB | ~$60 |
| Aurora PostgreSQL | db.r6g.large, 1 writer + 1 reader | ~$400 |
| ElastiCache Redis | cache.r6g.large, 2 nodes | ~$250 |
| Amazon MSK | kafka.m5.large, 2 brokers | ~$350 |
| ALB | Base + traffic | ~$30 |
| S3 | 10 GB storage | ~$1 |
| CloudWatch | Logs + metrics | ~$30 |
| NAT Gateway | 1 gateway + data transfer | ~$40 |
| Route 53 | 1 hosted zone | ~$1 |
| **Total** | | **~$1,162** |

### Scaling Considerations

- ECS tasks auto-scale 2–10 based on CPU (70% target)
- Aurora supports up to 15 read replicas
- ElastiCache can add shards for horizontal scaling
- MSK broker count and storage can be increased independently

---

## 17. Architecture Diagram

```
                                    ┌──────────────────┐
                                    │   CloudFront     │
                                    │   (CDN)          │
                                    └────────┬─────────┘
                                             │
                                    ┌────────▼─────────┐
                                    │   WAF            │
                                    │   (Firewall)     │
                                    └────────┬─────────┘
                                             │
                          ┌──────────────────▼──────────────────┐
                          │     Application Load Balancer       │
                          │     (HTTPS :443)                    │
                          └──────┬────────────────────┬─────────┘
                                 │                    │
                    ┌────────────▼──────┐  ┌──────────▼──────────┐
                    │  Public Subnet    │  │  Public Subnet      │
                    │  10.0.1.0/24      │  │  10.0.2.0/24        │
                    │  (AZ-a)           │  │  (AZ-b)             │
                    └────────┬──────────┘  └──────────┬──────────┘
                             │   NAT GW               │
                    ┌────────▼────────────────────────▼──────────┐
                    │            Private Subnets                  │
                    │                                             │
                    │  ┌─────────────────────────────────────┐   │
                    │  │         ECS Fargate Cluster          │   │
                    │  │                                      │   │
                    │  │  ┌──────────┐  ┌──────────────────┐ │   │
                    │  │  │API GW    │  │Location Service  │ │   │
                    │  │  │:3000     │  │:3011             │ │   │
                    │  │  └──────────┘  └──────────────────┘ │   │
                    │  │  ┌──────────┐  ┌──────────────────┐ │   │
                    │  │  │Matching  │  │Pricing Service   │ │   │
                    │  │  │:3012     │  │:3013             │ │   │
                    │  │  └──────────┘  └──────────────────┘ │   │
                    │  │  ┌──────────┐  ┌──────────────────┐ │   │
                    │  │  │Ride Svc  │  │WebSocket GW      │ │   │
                    │  │  │:3014     │  │:3001             │ │   │
                    │  │  └──────────┘  └──────────────────┘ │   │
                    │  └─────────────────────────────────────┘   │
                    │                                             │
                    │  ┌──────────┐  ┌────────┐  ┌───────────┐  │
                    │  │Aurora PG │  │Elasti- │  │Amazon MSK │  │
                    │  │(PostGIS) │  │Cache   │  │(Kafka)    │  │
                    │  │:5432     │  │Redis   │  │:9092      │  │
                    │  │248 tables│  │:6379   │  │           │  │
                    │  └──────────┘  └────────┘  └───────────┘  │
                    └────────────────────────────────────────────┘

                    ┌──────────────────┐  ┌──────────────────┐
                    │  S3 Bucket       │  │  Secrets Manager │
                    │  (Driver Docs)   │  │  (Credentials)   │
                    └──────────────────┘  └──────────────────┘

                    ┌──────────────────┐  ┌──────────────────┐
                    │  CloudWatch      │  │  X-Ray           │
                    │  (Logs/Metrics)  │  │  (Tracing)       │
                    └──────────────────┘  └──────────────────┘
```
