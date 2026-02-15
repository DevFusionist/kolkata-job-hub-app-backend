# Kolkata Job Hub Backend (Node.js)

Express API for Kolkata Job Hub - auth, jobs, applications, AI (OpenAI), portfolio, messages, payments.

## Setup

```bash
npm install
```

Create `.env`:

```
MONGO_URL=mongodb+srv://...
DB_NAME=kolkata_job_hub_app
OPENAI_API_KEY=sk-...
MPIN_SALT=your-salt
PORT=8000
```

## Run

```bash
npm start       # production
npm run dev     # dev with watch
```

## API

- `POST /api/auth/send-otp` - Mock OTP
- `POST /api/auth/verify-otp` - Verify phone
- `POST /api/auth/login` - Login with MPIN
- `POST /api/auth/set-mpin` - Set MPIN
- `POST /api/users` - Create user
- `GET /api/users/:id` - Get user
- `PUT /api/users/:id` - Update user
- `POST /api/jobs?employer_id=` - Create job
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
- `POST /api/payments/create-order?employer_id=` - Create order
- `POST /api/payments/verify?employer_id=` - Verify payment
- `GET /api/health` - Health check

WebSocket: `ws://host/ws/:userId` for real-time messages.
