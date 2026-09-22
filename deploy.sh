#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# LandFinder AWS CDK deploy script
# Uses the "landfinder-admin" AWS CLI profile (created here from .env creds).
# Run from the repo root:
#   ./deploy.sh                                     # all stacks
#   ./deploy.sh LandFinderApiStack                  # named stacks plus their dependencies
#   ./deploy.sh --exclusively LandFinderApiStack    # named stacks only
#
# Anything starting with "-" is passed through to cdk deploy. Use --exclusively
# while the legacy landfinder-db instance is stopped: the database stack cannot
# update a stopped instance, so pulling it in as a dependency fails the deploy.
#
# API Gateway CORS needs ALLOWED_ORIGINS. If it is not set in the environment,
# the script builds it from the LandFinderWebStack CloudFront URL plus the
# local dev origins.
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$REPO_ROOT/infrastructure"
ENV_FILE="$REPO_ROOT/.env"
AWS_PROFILE="landfinder-admin"
AWS_REGION="us-west-2"
LOCAL_ORIGINS="http://localhost:5173,http://localhost:3001"

# Split arguments into stack names and flags passed through to cdk deploy.
STACKS=()
CDK_FLAGS=()
for arg in "$@"; do
  if [[ "$arg" == -* ]]; then
    CDK_FLAGS+=("$arg")
  else
    STACKS+=("$arg")
  fi
done

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

# ── 4. Resolve CORS origins ────────────────────────────────────────────────
# Without this, app.ts falls back to localhost only and the CloudFront site
# gets CORS errors from the API.
if [[ -n "${ALLOWED_ORIGINS:-}" ]]; then
  echo "Using ALLOWED_ORIGINS from the environment."
else
  echo "Looking up the CloudFront URL from LandFinderWebStack..."
  if WEB_URL="$(AWS_PROFILE="$AWS_PROFILE" aws cloudformation describe-stacks \
      --region "$AWS_REGION" --stack-name LandFinderWebStack \
      --query "Stacks[0].Outputs[?OutputKey=='WebUrl'].OutputValue" \
      --output text 2>&1)"; then
    if [[ -z "$WEB_URL" || "$WEB_URL" == "None" ]]; then
      echo "ERROR: LandFinderWebStack exists but has no WebUrl output. Set ALLOWED_ORIGINS and re-run." >&2
      exit 1
    fi
    ALLOWED_ORIGINS="$WEB_URL,$LOCAL_ORIGINS"
  elif [[ "$WEB_URL" == *"does not exist"* ]]; then
    # First deploy: the CloudFront URL does not exist yet.
    echo "WARNING: LandFinderWebStack not deployed yet, so CORS allows local origins only."
    echo "         Re-run ./deploy.sh LandFinderApiStack after this deploy finishes."
    ALLOWED_ORIGINS="$LOCAL_ORIGINS"
  else
    echo "ERROR: Could not read LandFinderWebStack outputs: $WEB_URL" >&2
    echo "       Set ALLOWED_ORIGINS and re-run." >&2
    exit 1
  fi
fi
export ALLOWED_ORIGINS
echo "  ALLOWED_ORIGINS : $ALLOWED_ORIGINS"

# ── 5. Build the web app when the web stack is being deployed ──────────────
# LandFinderWebStack uploads whatever is in apps/web/dist, so a stale build
# would overwrite the live site with old code.
if [[ ${#STACKS[@]} -eq 0 || " ${STACKS[*]} " == *" LandFinderWebStack "* ]]; then
  echo "Building web app..."
  (cd "$REPO_ROOT" && npm run web:build)
fi

# ── 6. Install CDK dependencies ────────────────────────────────────────────
echo "Installing infrastructure dependencies..."
cd "$INFRA_DIR"
npm install --silent

# ── 7. Bootstrap CDK (safe to re-run, skips if already bootstrapped) ───────
echo "Bootstrapping CDK for account $ACCOUNT_ID / $AWS_REGION..."
AWS_PROFILE="$AWS_PROFILE" npx cdk bootstrap "aws://$ACCOUNT_ID/$AWS_REGION"

# ── 8. Deploy ──────────────────────────────────────────────────────────────
# ${arr[@]+"${arr[@]}"} so an empty array does not trip "set -u" on bash 3.2 (macOS).
if [[ ${#STACKS[@]} -eq 0 ]]; then
  echo "Deploying all stacks..."
  AWS_PROFILE="$AWS_PROFILE" npx cdk deploy --all \
    ${CDK_FLAGS[@]+"${CDK_FLAGS[@]}"} --require-approval never
else
  echo "Deploying: ${STACKS[*]} ${CDK_FLAGS[*]-}"
  AWS_PROFILE="$AWS_PROFILE" npx cdk deploy "${STACKS[@]}" \
    ${CDK_FLAGS[@]+"${CDK_FLAGS[@]}"} --require-approval never
fi

echo ""
echo "Deployment complete. Save the output values above to configure the mobile app."
