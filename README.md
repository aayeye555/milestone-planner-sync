# ☁️ Cloudflare Worker + GitHub Sync Guide

This directory contains the ready-to-deploy Cloudflare Worker that connects your **Milestone Planner** to a GitHub repository for self-hosted, secure, and authenticated offline persistence.

## Architecture

```
Milestone Planner (Browser/Offline PC)
       ↓ (GET/POST with CORS)
Cloudflare Worker API
       ↓ (Authenticated REST API with Secret Token)
GitHub Repository (e.g. project.json)
```

---

## 🛠️ Setup Instructions

### 1. Create a GitHub Repository
1. Create a new repository on GitHub (it can be **Private** or **Public**).
2. Create or commit an empty `project.json` file, or let the planner create it automatically on your first save.
3. Generate a **GitHub Personal Access Token (PAT)**:
   - Go to **Settings** > **Developer settings** > **Personal access tokens** > **Tokens (classic)**.
   - Click **Generate new token (classic)**.
   - Give it a name (e.g. `Milestone Planner Sync`).
   - Select the **`repo`** scope (full control of private repositories) or **`public_repo`** (if your repo is public).
   - Generate and copy the token safely.

---

### 2. Deploy the Worker to Cloudflare
Make sure you have Node.js/npm installed on your PC, then follow these commands in your local terminal:

```bash
# Navigate to the cloudflare-worker folder
cd cloudflare-worker

# Login to your Cloudflare account
npx wrangler login

# Deploy the Worker (this creates the Worker in your Cloudflare dashboard)
npx wrangler deploy
```

---

### 3. Configure Worker Variables & Secrets
Now, you need to configure the credentials in Cloudflare so the browser never sees them:

#### A. Set GitHub Repository Config (Public Variables)
You can set these in your `wrangler.toml` before deploying, or set them directly via the Cloudflare Dashboard (**Worker** > **Settings** > **Variables**):
- `GITHUB_REPO`: `your-github-username/your-repository-name`
- `GITHUB_PATH`: `project.json` (or any path you prefer, e.g. `milestone-planner/project.json`)
- `GITHUB_BRANCH`: `main` (your default branch name)

#### B. Set the GitHub Token (Secret Variable)
Set your GitHub Personal Access Token as a secure secret:
```bash
npx wrangler secret put GITHUB_TOKEN
```
*When prompted, paste your GitHub PAT copied from Step 1.*

---

### 4. Link the Worker to your Milestone Planner
Once deployed, Cloudflare will provide you with a unique worker URL (e.g., `https://milestone-planner-sync.your-subdomain.workers.dev`).

You can use this URL in three ways:

1. **Vite Build Config (Recommended for Offline HTML Build)**:
   Add this to your `.env` file before building the applet:
   ```env
   VITE_WORKER_API_URL="https://milestone-planner-sync.your-subdomain.workers.dev"
   ```
   *Any build created after this (including `MilestonePlanner.html`) will have this URL hardcoded as its default.*

2. **URL Query Parameter**:
   You can bookmark the Milestone Planner (or your local `MilestonePlanner.html` file) with the worker URL as a query parameter:
   ```
   file:///C:/path/to/MilestonePlanner.html?workerUrl=https://milestone-planner-sync.your-subdomain.workers.dev
   ```
   *The applet automatically detects this parameter on load and connects immediately!*

3. **In-App Cloud Connection Panel**:
   Click the cloud status icon (e.g. **Offline** or **Synced**) in the top header of the planner to open the **Sync Configuration Panel**. You can paste your Worker URL there to connect and sync for your current session!
