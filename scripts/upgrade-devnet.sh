#!/usr/bin/env bash
# Upgrades the devnet program to target/deploy/sealed_auction.so and checks
# that the deployed bytes match the local build. The full CLI output goes to
# upgrade-devnet.log (git-ignored): if a deploy is interrupted it can include a
# one-time recovery phrase for the temporary buffer, so it is never printed.
set -euo pipefail

PROGRAM_ID=CjUVaVK3jF9o4EehHWtB13TGg9SPXBWKGBepmZHwyLK2
KEYPAIR=${KEYPAIR:-$HOME/.config/solana/devnet-test.json}
RPC=${RPC:-https://api.devnet.solana.com}
SO=target/deploy/sealed_auction.so

echo "Local build: $(shasum -a 256 "$SO" | cut -d' ' -f1) ($(wc -c < "$SO" | tr -d ' ') bytes)"
echo "Deployer balance: $(solana balance -u "$RPC" -k "$KEYPAIR")"

# The program account must be able to hold the build. The loader extends it
# by at least 10 KiB at a time (or to its maximum size), which the CLI's own
# extension does not ask for, so extend it here first when needed.
: > upgrade-devnet.log
CURRENT=$(solana program show "$PROGRAM_ID" -u "$RPC" | awk '/^Data Length:/ {print $3}')
NEEDED=$(wc -c < "$SO" | tr -d ' ')
if [ "$NEEDED" -gt "$CURRENT" ]; then
  EXTRA=$((NEEDED - CURRENT))
  [ "$EXTRA" -lt 10240 ] && EXTRA=10240
  echo "Extending the program account by $EXTRA bytes"
  if ! solana program extend "$PROGRAM_ID" "$EXTRA" -u "$RPC" -k "$KEYPAIR" >> upgrade-devnet.log 2>&1; then
    echo "Extending failed:"
    grep -iE "error|insufficient|failed|requires" upgrade-devnet.log | head -5
    exit 1
  fi
fi

# The public devnet RPC rate-limits the buffer writes, so allow many tries.
if ! solana program deploy "$SO" --program-id "$PROGRAM_ID" -u "$RPC" -k "$KEYPAIR" \
  --upgrade-authority "$KEYPAIR" --max-sign-attempts 60 >> upgrade-devnet.log 2>&1; then
  echo "Deploy failed. Reason (recovery phrases filtered out):"
  grep -iE "error|insufficient|failed|requires" upgrade-devnet.log | grep -viE "seed phrase|recover" | head -5
  echo "Close any leftover buffer to get its SOL back: solana program close --buffers -u devnet -k <keypair>"
  exit 1
fi
grep -E "^(Program Id|Signature)" upgrade-devnet.log || true

# The program account may be larger than the build, so only the build's length
# is compared. RPC nodes can lag a few seconds behind the upgrade.
LEN=$(wc -c < "$SO" | tr -d ' ')
LOCAL=$(shasum -a 256 "$SO" | cut -d' ' -f1)
for attempt in 1 2 3 4 5 6; do
  solana program dump "$PROGRAM_ID" /tmp/sealed_auction-deployed.so -u "$RPC" > /dev/null
  DEPLOYED=$(head -c "$LEN" /tmp/sealed_auction-deployed.so | shasum -a 256 | cut -d' ' -f1)
  [ "$DEPLOYED" = "$LOCAL" ] && break
  sleep 10
done
if [ "$DEPLOYED" = "$LOCAL" ]; then
  echo "Deployed bytes match the local build."
else
  echo "Deployed bytes differ from the local build!" >&2
  exit 1
fi
echo "Deployer balance: $(solana balance -u "$RPC" -k "$KEYPAIR")"
