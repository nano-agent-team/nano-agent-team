#!/bin/bash
# Dispatcher: feeds pipeline tickets one at a time.
# Checks every 60s if pipeline is free (no agent busy), then transitions
# next "idea" ticket with label "pipeline" to "approved" via REST API,
# which triggers the NATS publish → architect picks it up.
#
# Usage: ./scripts/dispatch-tickets.sh
# Stop:  Ctrl+C

API="http://localhost:3002"
DB="/Users/rpridal/workspace/nano-agent-team-project/nano-agent-team/data/nano-agent-team.db"
INTERVAL=60

echo "=== Ticket Dispatcher ==="
echo "Checking every ${INTERVAL}s for free pipeline..."
echo ""

while true; do
  # Check if any agent is busy
  BUSY=$(curl -s "$API/api/health" 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    busy = [a['agentId'] for a in data.get('agents', []) if a.get('busy')]
    if busy:
        print(','.join(busy))
except:
    print('ERROR')
" 2>/dev/null)

  if [ "$BUSY" = "ERROR" ]; then
    echo "[$(date '+%H:%M:%S')] Cannot reach API — is stack running?"
    sleep "$INTERVAL"
    continue
  fi

  if [ -n "$BUSY" ]; then
    echo "[$(date '+%H:%M:%S')] Pipeline busy: $BUSY — waiting..."
    sleep "$INTERVAL"
    continue
  fi

  # Find next idea ticket with 'pipeline' label
  NEXT=$(sqlite3 "$DB" \
    "SELECT id FROM tickets WHERE status = 'idea' AND labels LIKE '%pipeline%' ORDER BY id LIMIT 1" 2>/dev/null)

  if [ -z "$NEXT" ]; then
    echo "[$(date '+%H:%M:%S')] No more pipeline tickets. Done!"
    break
  fi

  echo "[$(date '+%H:%M:%S')] Dispatching $NEXT → approved (triggers architect)..."

  # Transition to approved via REST API → fires topic.ticket.approved NATS event
  RESULT=$(curl -s -X PATCH "$API/api/tickets/$NEXT" \
    -H "Content-Type: application/json" \
    -d '{"status": "approved", "changed_by": "dispatcher"}')

  STATUS=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)

  if [ "$STATUS" = "approved" ]; then
    echo "[$(date '+%H:%M:%S')] ✓ $NEXT dispatched"
  else
    echo "[$(date '+%H:%M:%S')] ✗ Failed to dispatch $NEXT: $RESULT"
  fi

  # Wait before checking next
  sleep "$INTERVAL"
done
