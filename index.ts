export interface Env {
  // Secrets configured via Wrangler / Cloudflare Dashboard
  GITHUB_TOKEN: string; // GitHub Personal Access Token
  GITHUB_REPO: string;  // repository name (e.g. "owner/repo")
  GITHUB_PATH: string;  // path to the JSON file (e.g. "project.json")
  GITHUB_BRANCH: string; // branch (optional, defaults to "main")
}

const ALLOWED_PRODUCTION_DOMAINS = [
  'milestone-planner.vercel.app',
  'milestone-planner-sync.vercel.app',
  'milestone-planner-app.vercel.app',
];

const isOriginAllowed = (origin: string | null): boolean => {
  if (!origin) return false;
  // Allow localhost for local development & testing
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return true;
  // Allow AI Studio preview and shared links
  if (origin.includes('.run.app') || origin.includes('ai.studio') || origin.includes('googleusercontent.com')) return true;
  
  // Parse origin hostname to check if it's in the explicit vercel allowlist
  try {
    const url = new URL(origin);
    if (ALLOWED_PRODUCTION_DOMAINS.includes(url.hostname)) return true;
  } catch (e) {
    if (ALLOWED_PRODUCTION_DOMAINS.includes(origin)) return true;
  }

  // Allow other explicit production hosting domains
  if (origin.includes('.github.io') || origin.includes('github.com')) return true;
  
  return false;
};

function getTimestampString() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const origin = request.headers.get('Origin');
    
    if (origin && !isOriginAllowed(origin)) {
      return new Response(
        JSON.stringify({ error: 'Origin not allowed' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    const allowOrigin = origin || '*';
    
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    // CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const repo = env.GITHUB_REPO;
    const path = env.GITHUB_PATH || 'project.json';
    const branch = env.GITHUB_BRANCH || 'main';
    const token = env.GITHUB_TOKEN;

    if (!token || !repo) {
      return new Response(
        JSON.stringify({ error: 'Worker is missing configuration (GITHUB_TOKEN or GITHUB_REPO)' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const url = new URL(request.url);
    const pathName = url.pathname;

    // Helper to call GitHub API for a specific path
    const callGitHub = async (method: string, relativePath: string, body?: any) => {
      const headers: HeadersInit = {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Cloudflare-Worker-Milestone-Planner',
      };
      if (body) {
        headers['Content-Type'] = 'application/json';
      }

      return fetch(`https://api.github.com/repos/${repo}/contents/${relativePath}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    };

    // --- ENDPOINT: GET /project ---
    if (pathName === '/project' && request.method === 'GET') {
      try {
        const versionParam = url.searchParams.get('version');
        const targetPath = versionParam ? `data/versions/${versionParam}` : path;

        const response = await callGitHub('GET', targetPath);
        
        if (response.status === 404) {
          return new Response(
            JSON.stringify({ error: 'File not found on GitHub' }),
            { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }

        if (!response.ok) {
          const err = await response.text();
          return new Response(
            JSON.stringify({ error: `GitHub API error: ${err}` }),
            { status: response.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }

        const data: any = await response.json();
        const base64Clean = data.content.replace(/\s/g, '');
        const binString = atob(base64Clean);
        const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0) || 0);
        const decodedContent = new TextDecoder().decode(bytes);
        
        return new Response(decodedContent, {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err.message }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    }

    // --- ENDPOINT: POST /project ---
    if (pathName === '/project' && request.method === 'POST') {
      try {
        const payload = await request.json() as any;
        
        // 1. Get existing file details
        let sha: string | undefined = undefined;
        let existingProjectContent: string | null = null;
        let existingProject: any = null;
        
        const getResponse = await callGitHub('GET', path);
        if (getResponse.status === 200) {
          const getData: any = await getResponse.json();
          sha = getData.sha;
          try {
            const base64Clean = getData.content.replace(/\s/g, '');
            const binString = atob(base64Clean);
            const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0) || 0);
            existingProjectContent = new TextDecoder().decode(bytes);
            existingProject = JSON.parse(existingProjectContent);
          } catch (e) {
            console.error('Failed to parse existing project', e);
          }
        }

        // Conflict Protection: Latest timestamp wins
        if (existingProject && existingProject.lastModified && payload.lastModified) {
          const existingTime = new Date(existingProject.lastModified).getTime();
          const payloadTime = new Date(payload.lastModified).getTime();
          
          if (existingTime > payloadTime) {
            // Overwriting is blocked because GitHub has a newer modification. Return 409 Conflict.
            return new Response(
              JSON.stringify({
                conflict: true,
                message: 'Conflict detected: A newer plan has already been saved on GitHub.',
                project: existingProject
              }),
              { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
          }
        }

        // 2. If existing project exists, save it as a version snapshot first
        if (existingProjectContent) {
          const timestamp = getTimestampString();
          const snapshotPath = `data/versions/${timestamp}.json`;
          const snapshotBytes = new TextEncoder().encode(existingProjectContent);
          const snapshotBinString = Array.from(snapshotBytes, (byte) => String.fromCodePoint(byte)).join('');
          const snapshotBase64 = btoa(snapshotBinString);

          await callGitHub('PUT', snapshotPath, {
            message: `Snapshot auto-save version: ${timestamp}`,
            content: snapshotBase64,
            branch,
          });

          // 3. Keep maximum 50 versions. Delete the oldest ones automatically.
          const listResponse = await callGitHub('GET', 'data/versions');
          if (listResponse.status === 200) {
            const files: any = await listResponse.json();
            if (Array.isArray(files)) {
              const jsonFiles = files
                .filter((f: any) => f.name.endsWith('.json'))
                .sort((a: any, b: any) => a.name.localeCompare(b.name));

              if (jsonFiles.length > 50) {
                const filesToDeleteCount = jsonFiles.length - 50;
                for (let i = 0; i < filesToDeleteCount; i++) {
                  const fileToDelete = jsonFiles[i];
                  await callGitHub('DELETE', fileToDelete.path, {
                    message: `Pruning oldest snapshot version: ${fileToDelete.name}`,
                    sha: fileToDelete.sha,
                    branch,
                  });
                }
              }
            }
          }
        }

        // 4. Save the new project configuration payload
        const contentStr = JSON.stringify(payload, null, 2);
        const bytes = new TextEncoder().encode(contentStr);
        const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('');
        const base64Content = btoa(binString);

        const putBody = {
          message: 'Update milestone planner configuration via Cloudflare Worker API',
          content: base64Content,
          sha,
          branch,
        };

        const putResponse = await callGitHub('PUT', path, putBody);

        if (!putResponse.ok) {
          const err = await putResponse.text();
          return new Response(
            JSON.stringify({ error: `Failed to commit to GitHub: ${err}` }),
            { status: putResponse.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }

        return new Response(
          JSON.stringify({ success: true, message: 'Saved successfully to GitHub repository!' }),
          { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err.message }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    }

    // --- ENDPOINT: GET /versions ---
    if (pathName === '/versions' && request.method === 'GET') {
      try {
        const response = await callGitHub('GET', 'data/versions');
        
        if (response.status === 404) {
          // No versions directory yet, return empty list
          return new Response(JSON.stringify([]), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        if (!response.ok) {
          const err = await response.text();
          return new Response(
            JSON.stringify({ error: `GitHub API error: ${err}` }),
            { status: response.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }

        const files: any = await response.json();
        if (Array.isArray(files)) {
          const jsonFiles = files
            .filter((f: any) => f.name.endsWith('.json'))
            .map((f: any) => ({
              name: f.name,
              sha: f.sha,
              size: f.size,
              path: f.path,
            }))
            .sort((a: any, b: any) => b.name.localeCompare(a.name)); // Newest first for UI convenience
          
          return new Response(JSON.stringify(jsonFiles), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        return new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err.message }),
          { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
    }

    return new Response(
      JSON.stringify({ error: 'Endpoint or method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  },
};
