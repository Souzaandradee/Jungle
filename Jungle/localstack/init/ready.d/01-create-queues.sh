#!/bin/sh
set -eu

DLQ_URL="$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}' \
  --query QueueUrl --output text)"

DLQ_ARN="$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)"

REDRIVE_POLICY="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$DLQ_ARN")"
REDRIVE_POLICY_ESCAPED="$(printf '%s' "$REDRIVE_POLICY" | sed 's/\\/\\\\/g; s/"/\\"/g')"

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"true\",\"RedrivePolicy\":\"$REDRIVE_POLICY_ESCAPED\"}" \
  >/dev/null

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}' \
  >/dev/null

echo "SQS queues ready: wager-transactions.fifo, wager-transactions-dlq.fifo, wager-events.fifo"
