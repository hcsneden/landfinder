#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# LandFinder — AWS CDK deploy script
# Uses the "landfinder-admin" AWS CLI profile (created here from .env creds).
# Run from the repo root: ./deploy.sh
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$REPO_ROOT/infrastructure"
ENV_FILE="$REPO_ROOT/.env"
AWS_PROFILE="landfinder-admin"
AWS_REGION="us-west-2"

# ── 1. Load credentials from .env ──────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. It must contain KEY= and SECRET= lines." >&2
  exit 1
fi

AWS_ACCESS_KEY_ID="$(grep -E '^KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
AWS_SECRET_ACCESS_KEY="$(grep -E '^SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"

if [[ -z "$AWS_ACCESS_KEY_ID" || -z "$AWS_SECRET_ACCESS_KEY" ]]; then
  echo "ERROR: Could not read KEY or SECRET from $ENV_FILE." >&2
  exit 1
fi

# ── 2. Write the admin profile to ~/.aws credentials ───────────────────────
echo "Configuring AWS profile '$AWS_PROFILE'..."
aws configure set aws_access_key_id     "$AWS_ACCESS_KEY_ID"     --profile "$AWS_PROFILE"
aws configure set aws_secret_access_key "$AWS_SECRET_ACCESS_KEY" --profile "$AWS_PROFILE"
aws configure set region                "$AWS_REGION"             --profile "$AWS_PROFILE"

# ── 3. Verify identity ─────────────────────────────────────────────────────
echo "Verifying AWS identity..."
IDENTITY="$(AWS_PROFILE="$AWS_PROFILE" aws sts get-caller-identity --output json)"
ACCOUNT_ID="$(echo "$IDENTITY" | grep -o '"Account": "[^"]*"' | grep -o '[0-9]*')"
echo "  Account : $ACCOUNT_ID"
echo "  ARN     : $(echo "$IDENTITY" | grep -o '"Arn": "[^"]*"' | cut -d'"' -f4)"

# ── 4. Install CDK dependencies ────────────────────────────────────────────
echo "Installing infrastructure dependencies..."
cd "$INFRA_DIR"
npm install --silent

# ── 5. Bootstrap CDK (safe to re-run — skips if already bootstrapped) ──────
echo "Bootstrapping CDK for account $ACCOUNT_ID / $AWS_REGION..."
AWS_PROFILE="$AWS_PROFILE" npx cdk bootstrap "aws://$ACCOUNT_ID/$AWS_REGION"

# ── 6. Deploy all stacks ───────────────────────────────────────────────────
echo "Deploying all stacks..."
AWS_PROFILE="$AWS_PROFILE" npx cdk deploy --all --require-approval never

echo ""
echo "Deployment complete. Save the output values above to configure the mobile app."
