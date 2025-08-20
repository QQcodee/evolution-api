# Webhook Message Buffering

This feature allows the Evolution API to buffer multiple consecutive messages from the same sender before sending them to the webhook endpoint. This can significantly reduce the number of HTTP requests when a user sends many messages in a short period of time.

## Configuration

You can enable and configure message buffering in the webhook settings for each instance:

```json
{
  "webhook": {
    "enabled": true,
    "url": "https://your-webhook-url.com",
    "events": ["MESSAGES_UPSERT", "SEND_MESSAGE"],
    "buffer": {
      "enabled": true,       // Enable message buffering
      "timeout": 3000,       // Wait time in milliseconds before sending buffered messages
      "maxSize": 10          // Maximum number of messages to buffer before sending
    }
  }
}
```

## How it Works

1. When buffering is enabled, messages from the same sender and with the same event type are collected into a buffer.
2. The buffer is sent to the webhook endpoint when:
   - The buffer timeout expires (default: 3 seconds)
   - The buffer reaches the maximum size (default: 10 messages)
   - The application is shutting down

3. When messages are buffered, the webhook payload format changes slightly:

```json
{
  "event": "messages.upsert",
  "instance": "instance-name",
  "data": [
    // Array of messages instead of a single message
    { /* message 1 */ },
    { /* message 2 */ },
    { /* message 3 */ }
  ],
  "count": 3,           // Number of messages in this batch
  "isBuffered": true,   // Indicates this is a buffered webhook call
  "date_time": "2025-08-19T18:00:00.000Z"
}
```

## Events That Can Be Buffered

Currently, only the following events can be buffered:
- MESSAGES_UPSERT
- SEND_MESSAGE
- MESSAGES_UPDATE

Other events like connection updates, status changes, etc. are always sent immediately.

## Benefits

- Reduced number of HTTP requests when a user sends multiple consecutive messages
- Lower processing overhead for your webhook server
- More efficient network usage
