# Kolkata Job Hub Backend (Node.js)

Express API for Kolkata Job Hub - auth, jobs, applications, AI (OpenAI), portfolio, messages, payments.

## Setup

```bash
npm install
```

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Required minimum:

```env
MONGO_URL=mongodb+srv://...
DB_NAME=kolkata_job_hub_app
MPIN_SALT=your-salt
JWT_SECRET=your-jwt-secret
PORT=8000
```

**Twilio (Phone OTP):** For send/verify OTP via SMS, set in `.env`:

- `TWILIO_ACCOUNT_SID` – from Twilio Console  
- `TWILIO_AUTH_TOKEN` – from Twilio Console  
- `TWILIO_VERIFY_SID` – Verify service SID (Dashboard → Verify → Create Service)  

**Razorpay + Billing:**  
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`  
- `ALLOW_DEMO_PAYMENTS=true` (dev/demo only)  
- `FREE_JOB_TRIAL_LIMIT` (free posts for new employers)  
- `PAYMENT_SINGLE_JOB_AMOUNT_PAISE`, `PAYMENT_CREDITS_5_AMOUNT_PAISE`, `PAYMENT_CREDITS_20_AMOUNT_PAISE`  
- `PAYMENT_SUBSCRIPTION_MONTHLY_AMOUNT_PAISE`, `SUBSCRIPTION_DEFAULT_DAYS`

**AI Cost Controls:**  
- `AI_MAX_INPUT_CHARS_PER_CALL`  
- `AI_MAX_OUTPUT_TOKENS_PER_CALL`  
- `AI_MAX_EST_TOKENS_PER_USER_PER_DAY`  
- `AI_MAX_EST_TOKENS_GLOBAL_PER_DAY`  
- `AI_BUDGET_DISABLED=false`  

## Run

```bash
npm start       # production
npm run dev     # dev with watch
```

## API

- `POST /api/auth/send-otp` - Send OTP via Twilio Verify (body: `{ phone, purpose }`, purpose: `register|reset_mpin`)
- `POST /api/auth/verify-otp` - Verify OTP (body: `{ phone, otp, purpose }`)
- `POST /api/auth/login` - Login with MPIN
- `POST /api/auth/set-mpin` - Set MPIN
- `POST /api/users` - Create user
- `GET /api/users/:id` - Get user
- `PUT /api/users/:id` - Update user
- `POST /api/jobs` - Create job (auth: employer token)
- `GET /api/jobs` - List jobs
- `GET /api/jobs/:id` - Get job
- `GET /api/jobs/employer/:id` - Employer's jobs
- `PUT /api/jobs/:id/status?status=` - Update job status
- `POST /api/applications?seeker_id=` - Apply
- `GET /api/applications/job/:id` - Job applications
- `GET /api/applications/seeker/:id` - Seeker applications
- `PUT /api/applications/:id/status?status=&employer_id=` - Update application
- `POST /api/ai/process-command` - Voice command → jobs
- `POST /api/ai/analyze-portfolio?seeker_id=` - Analyze resume
- `POST /api/ai/match` - AI match (seeker→jobs or job→candidates)
- `POST /api/ai/create-job` - Text → job draft
- `POST /api/ai/transcribe` - Audio → text (Whisper)
- `GET /api/portfolios/seeker/:id` - Get portfolio
- `POST /api/portfolios?seeker_id=` - Save portfolio
- `POST /api/messages?sender_id=` - Send message
- `GET /api/messages/:userId?other_user_id=` - Chat history
- `GET /api/messages/conversations/:userId` - Conversations list
- `POST /api/payments/create-order` - Create order (auth: employer token)
- `POST /api/payments/verify` - Verify payment (auth: employer token)
- `GET /api/payments/catalog` - Available credit/subscription offerings
- `GET /api/payments/entitlements` - Current free/paid/subscription posting entitlements
- `GET /api/health` - Health check

WebSocket: `ws://host/ws/:userId` for real-time messages.
