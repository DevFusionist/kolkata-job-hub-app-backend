# Payment & Credits Flow – Kolkata Job Hub

This document explains **what** the different credits are, **where** they get used (deducted), and **how** payment and subscriptions fit in.

---

## 1. Two separate “currencies”

There are **two independent** systems:

| System | What it’s for | Who has it |
|--------|----------------|------------|
| **Job posting credits** | Posting job listings (employers only) | Employers only |
| **AI credits (tokens)** | Using AI features (Protibha chat, resume analysis, job/candidate matching) | All users (seekers + employers) |

They don’t share balance. Job credits don’t affect AI, and AI credits don’t affect job posting.

---

## 2. Job posting (employers only)

### 2.1 What gets deducted when you post a job

When an employer **posts one job**, exactly **one** “slot” is consumed. The order of use is:

1. **Active subscription**  
   If the employer has an active **monthly_unlimited** subscription:
   - **Nothing is deducted.**  
   - They can post as many jobs as they want until the subscription expires.

2. **Free job credits**  
   If no active subscription:
   - Use **free jobs remaining** first (capped at `FREE_JOB_TRIAL_LIMIT`, default 2).
   - One job post = **-1 freeJobsRemaining**.

3. **Paid job credits**  
   When free credits are 0:
   - Use **paid jobs remaining** (bought via payment).
   - One job post = **-1 paidJobsRemaining**.

If both free and paid are 0 and there’s no active subscription → **cannot post** → user sees “Payment required” / payment options.

### 2.2 Where this is enforced

- **Backend:**  
  - `src/lib/employerEntitlements.js`: `reserveJobPostingQuota()` (and rollback on failure).  
  - Used in:
    - `POST /api/jobs` (create job),
    - Protibha chat when employer confirms “post job” from the chat.

- **Frontend:**  
  - Post Job screen checks `canPost` / entitlements and shows payment modal when the user can’t post.

### 2.3 How job credits / subscription are increased

Only by **paying** (Razorpay):

- **Job credits:**  
  - Catalog items: `single_job` (1), `credits_5` (5), `credits_20` (20).  
  - On successful payment verification → **+N** to `paidJobsRemaining` (N = credits purchased).

- **Subscription:**  
  - Catalog item: `subscription_monthly`.  
  - On success → set `subscriptionPlan = "monthly_unlimited"` and extend `subscriptionExpiresAt` by the purchased days (e.g. 30).  
  - No change to `freeJobsRemaining` or `paidJobsRemaining`; subscription simply allows posting without deducting those.

**Summary (jobs):**

- **Deducted when:** One “slot” per job post (subscription → free → paid).  
- **Added when:** User buys job credits or subscription and payment is verified.

---

## 3. AI credits (all users)

### 3.1 What gets deducted when you use AI

Every AI use (Protibha message, resume analysis, AI match) **reserves** an estimated number of **tokens** (e.g. a few hundred per request). That reservation is taken from:

1. **Free AI tokens**  
   - `aiFreeTokensRemaining` (one-time grant, e.g. 6000 from `AI_FREE_TOKENS_LIFETIME`).  
   - Used first.

2. **Paid AI tokens**  
   - `aiPaidTokensRemaining` (bought via “AI credits” pack).  
   - Used when free is not enough for the request.

If **total available (free + paid) < estimated tokens** for that request → **no AI** → user sees “AI credits exhausted” / payment modal (e.g. to buy “5,000 AI Credits”).

### 3.2 Where this is enforced

- **Backend:**  
  - `src/lib/aiCredits.js`: `reserveAiCredits()` (and rollback on AI failure).  
  - Used in:
    - **Protibha chat:** every `aiJson` / `aiText` in `src/services/protibhaChat.js`.
    - **AI service:** `src/services/ai.js` (`analyzePortfolio`, `rankJobsForSeeker`, `rankCandidatesForJob`).
  - Routes return **402** or **payment_required** when reserve fails (e.g. `/api/ai/chat`, `/api/ai/analyze-portfolio`, `/api/ai/match`).

- **Frontend:**  
  - Protibha (and any AI screen) shows payment modal when backend says `action: "payment_required"` or 402.

### 3.3 How AI credits are increased

- **Free:**  
  - New users get `aiFreeTokensRemaining` from env (e.g. 6000).  
  - Not refilled automatically; once spent, only paid pack or new account.

- **Paid:**  
  - Catalog item: `ai_tokens_5k` (5,000 AI credits).  
  - On successful payment verification → **+5000** to `aiPaidTokensRemaining`.

**Summary (AI):**

- **Deducted when:** Every AI call reserves tokens (free first, then paid).  
- **Added when:** User buys “5,000 AI Credits” and payment is verified (and on signup for free grant).

---

## 4. End-to-end payment flow (Razorpay)

1. **User** chooses a product in the app (job credits, subscription, or AI credits).
2. **App** calls **Backend** `POST /api/payments/create-order` with `itemCode`:
   - Backend creates a **Razorpay Order** (with your test/live keys).
   - Backend stores a **Transaction** (status `created`) and returns `orderId`, `keyId`, `amount`, `currency` to the app.
3. **App** opens **Razorpay Checkout** (native SDK) with:
   - `key` = `keyId`,
   - `order_id` = `orderId`,
   - `amount`, `currency`, etc.
4. **User** pays in Razorpay’s UI (test cards in test mode).
5. **Razorpay** returns `razorpay_payment_id` and `razorpay_signature` to the app.
6. **App** calls **Backend** `POST /api/payments/verify` with:
   - `razorpayOrderId`, `razorpayPaymentId`, `razorpaySignature`.
7. **Backend**:
   - Verifies signature with `RAZORPAY_KEY_SECRET`.
   - Marks **Transaction** as `success`.
   - **Credits:**
     - **Job credits** → `paidJobsRemaining += N`.
     - **Subscription** → set plan and `subscriptionExpiresAt`.
     - **AI credits** → `aiPaidTokensRemaining += 5000` (for `ai_tokens_5k`).
8. Backend returns updated **entitlements**; app refreshes UI (e.g. “Add credits” / Protibha credits).

No demo/simulated payments: only real Razorpay orders and signature verification are accepted.

**Frontend:** The app uses `react-native-razorpay` to open Razorpay Checkout. Because it uses native modules, you need a **development build** (e.g. `expo run:ios` / `expo run:android` or EAS Build), not Expo Go.

---

## 5. Quick reference: “From where what gets deducted and why”

| Action | What is checked / deducted | Why |
|--------|----------------------------|-----|
| Employer posts a job | 1) Active subscription → no deduction<br>2) Else: free job credits (-1)<br>3) Else: paid job credits (-1) | One “slot” per job; subscription = unlimited posts |
| User sends a Protibha message / uses AI | 1) Free AI tokens (-estimated tokens)<br>2) Else: paid AI tokens (-estimated tokens) | Each AI call has a token cost; free then paid |
| User buys “Single Job Credit” | — | After payment: +1 paidJobsRemaining |
| User buys “5 Job Credits” | — | After payment: +5 paidJobsRemaining |
| User buys “Monthly Subscription” | — | After payment: subscription active for 30 days; no job-credit deduction when posting |
| User buys “5,000 AI Credits” | — | After payment: +5000 aiPaidTokensRemaining |

---

## 6. Env / config (backend)

- **Razorpay (real flow):**  
  - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (test or live).
- **Job trial:**  
  - `FREE_JOB_TRIAL_LIMIT` (default 2) = max free job credits per employer.
- **AI free grant:**  
  - `AI_FREE_TOKENS_LIFETIME` (default 6000) = free AI tokens for (e.g. new) users.
- **Subscription length:**  
  - `SUBSCRIPTION_DEFAULT_DAYS` (default 30) for monthly subscription.

Catalog amounts (paise) are in `src/routes/payments.js` (OFFERINGS) and can be overridden via env (e.g. `PAYMENT_AI_TOKENS_5K_PAISE`).
