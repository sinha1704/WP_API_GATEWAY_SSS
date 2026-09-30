# Production WhatsApp API Gateway

High-speed, self-hosted WhatsApp API Gateway built with **Node.js (TypeScript Strict)**, **Fastify**, and **@whiskeysockets/baileys** (WebSocket multi-device implementation). Designed for enterprise reliability, multi-tenancy, anti-ban protections, AI chatbot integration, and webhook dispatching.

---

## 🌟 Key Features

1. **Multi-Account & Multi-Device Sessions:** Run concurrent WhatsApp phone numbers isolated from each other.
2. **Anti-Ban Throttling & Presence Simulation:**
   - Realistic `composing` typing state emulation (1.5s – 3.0s configurable duration).
   - Per-session isolated FIFO queues with configurable delay between outbound messages (default 3s).
3. **Multi-Tenant & Scoped API Key Security:**
   - Master API Key with unrestricted administrative privileges.
   - Chat-restricted API Keys (tenant/agent can only send messages to specifically authorized phone numbers / JIDs).
4. **Real-Time Outbound Webhooks:**
   - Dispatches `message.received`, `message.status` (`sent`, `delivered`, `read`), and `session.status`.
   - Built-in HMAC-SHA256 signature verification.
   - 3-attempt exponential backoff retry on delivery failures.
5. **Pluggable AI Chatbot Bridge:**
   - Seamlessly connect incoming chats to OpenAI (GPT-4o / GPT-4o-mini), Gemini (1.5 Flash), Anthropic (Claude 3.5), or custom LLM endpoints.
   - Auto-pipes smart responses with customizable system prompts.
6. **OpenAPI / Swagger 3.0 Documentation:**
   - Interactive UI served directly at `http://localhost:3000/docs`.
7. **Production Ready:**
   - Multi-stage `Dockerfile` and `docker-compose.yml` for single-command deployment.

---

## 🚀 Quick Start

### 1. Local Development
```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment variables
cp .env.example .env

# 3. Build & Run
npm run build
npm start
# Or start in watch mode
npm run dev
```

### 2. Docker Deployment
```bash
docker compose up -d --build
```

---

## 📖 API Documentation & Endpoints

Interactive Swagger documentation is available at:
👉 **[http://localhost:3000/docs](http://localhost:3000/docs)**

### Authentication
Include your API Key in either:
- Header: `X-API-Key: <your_api_key>`
- Header: `Authorization: Bearer <your_api_key>`

---

### Feature 1: Multi-Account & Session Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/sessions/start` | Initialize session by `sessionId` |
| `GET` | `/api/sessions/:sessionId/qr` | Get pairing QR (supports `?format=html`, `svg`, `json`) |
| `GET` | `/api/sessions/:sessionId/status` | Get session connection health & user details |
| `GET` | `/api/sessions` | List all registered sessions and queue statuses |
| `POST` | `/api/sessions/:sessionId/logout` | Disconnect, logout and purge session credentials |

#### Starting a Session:
```bash
curl -X POST http://localhost:3000/api/sessions/start \
  -H "X-API-Key: master_secret_key_whatsapp_gateway_2026" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "sales-phone-1"}'
```

#### Viewing QR Code in Browser:
Open in browser:
```
http://localhost:3000/api/sessions/sales-phone-1/qr?format=html
```

---

### Feature 2: Message Sending Endpoints

#### 1. Send Text Message
```bash
curl -X POST http://localhost:3000/api/sales-phone-1/messages/text \
  -H "X-API-Key: master_secret_key_whatsapp_gateway_2026" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+1 (234) 567-890",
    "message": "Hello from WhatsApp Gateway!",
    "simulatePresence": true
  }'
```

#### 2. Send Media (Image / Document / Audio / Video)
Via JSON URL:
```bash
curl -X POST http://localhost:3000/api/sales-phone-1/messages/media \
  -H "X-API-Key: master_secret_key_whatsapp_gateway_2026" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "1234567890",
    "type": "image",
    "url": "https://example.com/invoice.jpg",
    "caption": "Your monthly invoice"
  }'
```

Via Multipart Form File Upload:
```bash
curl -X POST http://localhost:3000/api/sales-phone-1/messages/media \
  -H "X-API-Key: master_secret_key_whatsapp_gateway_2026" \
  -F "to=1234567890" \
  -F "type=document" \
  -F "file=@./contract.pdf"
```

#### 3. Send Reaction Emoji
```bash
curl -X POST http://localhost:3000/api/sales-phone-1/messages/reaction \
  -H "X-API-Key: master_secret_key_whatsapp_gateway_2026" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "1234567890",
    "messageId": "3EB0ABC123DEF456",
    "emoji": "👍"
  }'
```

---

### Feature 3: Webhooks & Signature Verification

When configured (`GLOBAL_WEBHOOK_URL` in `.env` or per-session `webhookUrl`), outbound HTTP POST requests will be signed with HMAC-SHA256:

- Headers sent:
  - `X-Gateway-Event`: `message.received` | `message.status` | `session.status`
  - `X-Gateway-Session`: `<sessionId>`
  - `X-Gateway-Signature`: `<HMAC-SHA256 hex>`
  - `X-Gateway-Timestamp`: `<Epoch milliseconds>`

---

### Feature 4: Scoped Chat Permissions

In your `.env` or container environment, configure granular permissions:
```env
SCOPED_API_KEYS={"support_agent_key": ["1234567890@s.whatsapp.net", "+1 (555) 019-2834"]}
```
Any request authenticated with `support_agent_key` trying to message an unauthorized number will be rejected with `403 Forbidden`.

---

### Feature 5: AI Chatbot Layer

Enable instant conversational answers on inbound messages by setting:
```env
AI_BRIDGE_ENABLED=true
AI_PROVIDER=openai # openai, gemini, anthropic
AI_API_KEY=your_key_here
AI_MODEL=gpt-4o-mini
```

---

---

## 🛡️ Anti-Ban Best Practices for Production

WhatsApp enforces strict automated heuristics to detect automated bots and spam blasts. To keep your numbers safe and prevent bans:

1. **Simulate Presence & Typing Delays:**
   - Never send messages instantaneously in 0ms.
   - The Gateway has built-in presence simulation (`composing` state) which emulates human typing for `PRESENCE_MIN_DELAY_MS` to `PRESENCE_MAX_DELAY_MS` (1.5s – 3.0s). Keep this enabled.

2. **Warm Up Fresh Numbers ("Number Seasoning"):**
   - **Week 1:** Max 10–20 messages/day. Send to friends or opt-in contacts who reply back.
   - **Week 2:** Increase gradually to 50 messages/day.
   - **Week 3+:** Gradually ramp up to higher volumes.
   - WhatsApp heavily weighs the **incoming-to-outgoing reply ratio**. If a number sends 100 messages and receives 0 replies, it will be flagged rapidly.

3. **Strict Queue Pacing (`QUEUE_MESSAGE_DELAY_MS`):**
   - The Gateway includes an isolated per-session FIFO queue with a default delay of `3000ms` (3 seconds) between consecutive outbound messages.
   - Avoid bursts of 10+ messages per second on a single phone line.

4. **Opt-in & Avoid Cold Outreach:**
   - WhatsApp gives recipients a prominent **"Block & Report Spam"** button. If more than 2–3% of recipients click Report, the number will be suspended automatically.
   - Always ensure users have consented or requested contact (e.g. 2FA codes, transactional notifications, customer support inquiries).

5. **Spin Content & Vary Templates:**
   - Avoid sending the exact identical text message to 500 people simultaneously. Vary wording, greetings, and dynamic variables.

---

## 🧪 Testing & Verification

Run the automated test suite verifying JID sanitization, Chat-restricted permissions, and Webhook HMAC generation:
```bash
npm test
```

Expected output:
```
▶ WhatsApp API Gateway Core Test Suite
  ▶ JID & Phone Number Formatting (4 tests passed)
  ▶ Multi-Tenant API Key & Chat Permissions (2 tests passed)
  ▶ Webhook Signature Verification (1 test passed)
✔ 7 tests passed (0 failures)
```

