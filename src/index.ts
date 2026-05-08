const PHPSESSID_KEY = "PHPSESSID";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Cloudflare-Worker-Scraper";

export interface Env {
  SCRAPER_STATE: KVNamespace;
  WP_LOGIN_URL: string;
  WP_TARGET_URL: string;
  WP_USERNAME: string;
  WP_PASSWORD: string;
  DISCORD_WEBHOOK_URL: string;
}

interface ShiftEntry {
  datum: string;
  den: string;
  truck: string;
  pozice: string;
  od: string;
  do: string;
  nabizejici: string;
  zajemce: string;
  free: boolean;
}

export default {
  async process(env: Env) {
    try {
      const timings: Record<string, number> = {};

      console.log("[scraper] Starting execution...");

      const html = await this.fetchTargetWithValidSession(env);
      if (!html) return;

      console.log("[scraper] Parsing target page for 'Burza směn' table data...");
      const parseStartedAt = performance.now();
      const currentRows = this.parseData(html);
      timings.parse = performance.now() - parseStartedAt;

      if (currentRows.length === 0) {
        console.log("[scraper] No entries found on the page.");
        console.log(`[scraper] CPU-relevant timings: parse=${timings.parse.toFixed(2)}ms`);
        return;
      } else {
        console.log(`[scraper] Data extracted successfully. Rows: ${currentRows.length}.`);
      }

      const previousDataString = await env.SCRAPER_STATE.get("PREVIOUS_DATA");
      let previousRows: ShiftEntry[] = [];
      if (previousDataString) {
        try {
          previousRows = JSON.parse(previousDataString);
        } catch (e) {
          console.error("[scraper] Failed to parse previous data JSON.");
        }
      }

      const diffStartedAt = performance.now();
      const changedRows = this.getShiftDiff(currentRows, previousRows);
      timings.diff = performance.now() - diffStartedAt;

      if (changedRows.length === 0) {
        console.log("[scraper] No changes detected. Finishing execution.");
        console.log(
          `[scraper] CPU-relevant timings: parse=${timings.parse.toFixed(2)}ms diff=${timings.diff.toFixed(2)}ms`,
        );
        return;
      } else {
        const changedRowIds = changedRows.map((row) => this.getShiftId(row));
        console.log(`[scraper] New row IDs: ${changedRowIds.join(", ")}`);
        console.log("[scraper] CHANGES DETECTED! Sending Discord notification...");
        await this.sendDiscordNotification(env, changedRows, env.WP_TARGET_URL);
      }

      await env.SCRAPER_STATE.put("PREVIOUS_DATA", JSON.stringify(currentRows));
      console.log("[scraper] New data saved to KV. Finished.");
      console.log(
        `[scraper] CPU-relevant timings: parse=${timings.parse.toFixed(2)}ms diff=${timings.diff.toFixed(2)}ms`,
      );
    } catch (error) {
      console.error("[scraper] Unhandled execution error:", error);
      throw error;
    }
  },

  maskSessionId(sessionId: string): string {
    return `${sessionId.substring(0, 5)}...`;
  },

  extractSessionId(setCookieHeader: string | null): string | null {
    return setCookieHeader?.match(/PHPSESSID=([^;]+)/)?.[1] ?? null;
  },

  async loginAndStoreSession(env: Env, reason: string): Promise<string | null> {
    console.log(reason);

    const sessionId = await this.login(env);
    if (!sessionId) {
      return null;
    }

    await env.SCRAPER_STATE.put(PHPSESSID_KEY, sessionId);
    return sessionId;
  },

  async fetchTargetWithValidSession(env: Env): Promise<string | null> {
    let sessionId = await env.SCRAPER_STATE.get(PHPSESSID_KEY);

    if (!sessionId) {
      sessionId = await this.loginAndStoreSession(env, "[scraper] No PHPSESSID found in KV. Attempting to log in...");

      if (!sessionId) {
        console.error("[scraper] ERROR: Failed to acquire PHPSESSID during login.");
        return null;
      }

      console.log(`[scraper] Successfully logged in. Session ID: ${this.maskSessionId(sessionId)}`);
    } else {
      console.log(`[scraper] Found existing PHPSESSID in KV: ${this.maskSessionId(sessionId)}`);
    }

    let html = await this.fetchTarget(env, sessionId);
    if (!this.isSessionExpired(html)) {
      console.log(`[scraper] Session is valid. Fetched HTML size: ${html.length} chars`);
      return html;
    }

    sessionId = await this.loginAndStoreSession(
      env,
      "[scraper] WARNING: Session expired or invalid (login form detected). Logging in again...",
    );

    if (!sessionId) {
      console.error("[scraper] ERROR: Failed to re-authenticate.");
      return null;
    }

    console.log(`[scraper] Successfully re-authenticated. New Session ID: ${this.maskSessionId(sessionId)}`);
    return this.fetchTarget(env, sessionId);
  },

  async login(env: Env): Promise<string | null> {
    const formData = new URLSearchParams({
      login: env.WP_USERNAME,
      heslo: env.WP_PASSWORD,
      ok: "Přihlásit se",
    });

    console.log(`[scraper/login] Attempting login to ${env.WP_LOGIN_URL} as ${env.WP_USERNAME}`);

    const response = await fetch(env.WP_LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: formData.toString(),
      redirect: "manual",
    });

    console.log(`[scraper/login] Login Response Status: ${response.status}`);
    return this.extractSessionId(response.headers.get("set-cookie"));
  },

  async fetchTarget(env: Env, sessionId: string): Promise<string> {
    console.log(`[scraper/fetch] Fetching target page: ${env.WP_TARGET_URL}`);
    const response = await fetch(env.WP_TARGET_URL, {
      method: "GET",
      headers: {
        Cookie: `PHPSESSID=${sessionId}`,
        "User-Agent": USER_AGENT,
      },
      redirect: "follow",
    });

    return await response.text();
  },

  isSessionExpired(html: string): boolean {
    return html.includes('name="login"') && html.includes('value="Přihlásit se"');
  },

  decodeHtmlEntities(value: string): string {
    const namedEntities: Record<string, string> = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: '"',
    };

    return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const codePoint = Number.parseInt(entity.slice(2), 16);
        return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
      }

      if (entity.startsWith("#")) {
        const codePoint = Number.parseInt(entity.slice(1), 10);
        return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
      }

      return namedEntities[entity] ?? match;
    });
  },

  normalizeText(value: string): string {
    return this.decodeHtmlEntities(value)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  extractCurrentUser(html: string): string {
    const dnesMatch = html.match(/<div[^>]*id=["']dnes["'][^>]*>([\s\S]*?)<\/div>/i);
    if (!dnesMatch) {
      return "";
    }

    const strongMatches = [...dnesMatch[1].matchAll(/<strong[^>]*>([\s\S]*?)<\/strong>/gi)];
    return this.normalizeText(strongMatches[2]?.[1] ?? "");
  },

  extractBurzaSmenTable(html: string): string | null {
    const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) ?? [];

    for (const table of tables) {
      if (/<caption\b[^>]*>\s*Burza směn\s*<\/caption>/i.test(table)) {
        return table;
      }
    }

    return null;
  },

  extractRowCells(rowHtml: string): string[] {
    return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)(?=<td\b|<form\b|<\/tr>)/gi)].map((match) =>
      this.normalizeText(match[1]),
    );
  },

  extractSubmitAction(rowHtml: string): { value: string; disabled: boolean } {
    const inputMatch = rowHtml.match(/<input\b[^>]*type=["']submit["'][^>]*>/i);
    if (!inputMatch) {
      return { value: "", disabled: false };
    }

    const inputHtml = inputMatch[0];
    const valueMatch = inputHtml.match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const rawValue = valueMatch?.[1] ?? valueMatch?.[2] ?? valueMatch?.[3] ?? "";

    return {
      value: this.normalizeText(rawValue),
      disabled: /\bdisabled\b/i.test(inputHtml),
    };
  },

  parseData(html: string): ShiftEntry[] {
    const rows: ShiftEntry[] = [];
    const currentUser = this.extractCurrentUser(html);
    const shiftsTableHtml = this.extractBurzaSmenTable(html);

    if (!shiftsTableHtml) {
      return rows;
    }

    const tableRows = [...shiftsTableHtml.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((match) => match[0]);

    for (const rowHtml of tableRows.slice(1)) {
      const cells = this.extractRowCells(rowHtml);
      if (cells.length < 8) {
        continue;
      }

      const action = this.extractSubmitAction(rowHtml);
      const [datum, den, truck, pozice, od, doba, nabizejici, zajemce] = cells;
      const free = action.value === "Beru" && !action.disabled && zajemce === "Žádný";
      const alreadyTakenByMe = action.value === "Už nechci" || (currentUser !== "" && zajemce === currentUser);
      const postedByMe = currentUser !== "" && nabizejici === currentUser;

      if (!free || alreadyTakenByMe || postedByMe) {
        continue;
      }

      rows.push({
        datum,
        den,
        truck,
        pozice,
        od,
        do: doba,
        nabizejici,
        zajemce,
        free,
      });
    }

    return rows;
  },

  getShiftId(row: ShiftEntry): string {
    return [
      row.datum,
      row.den,
      row.truck,
      row.pozice,
      row.od,
      row.do,
      row.nabizejici,
      row.zajemce,
      String(row.free),
    ].join("|");
  },

  getShiftDiff(sourceRows: ShiftEntry[], rowsToSubtract: ShiftEntry[]): ShiftEntry[] {
    const counts = new Map<string, number>();

    for (const row of rowsToSubtract) {
      const id = this.getShiftId(row);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const diff: ShiftEntry[] = [];

    for (const row of sourceRows) {
      const id = this.getShiftId(row);
      const remaining = counts.get(id);

      if (!remaining) {
        diff.push(row);
        continue;
      }

      if (remaining === 1) {
        counts.delete(id);
      } else {
        counts.set(id, remaining - 1);
      }
    }

    return diff;
  },

  formatDiscordMessage(row: ShiftEntry, targetUrl: string): string {
    return [`${row.truck}, ${row.pozice}`, `${row.den} ${row.datum}, ${row.od}-${row.do}`, targetUrl].join("\n");
  },

  async sendDiscordNotification(env: Env, changedRows: ShiftEntry[], targetUrl: string) {
    if (changedRows.length === 0) {
      console.log("[scraper/discord] Data changed structurally but no distinct row changes detected to send.");
      return;
    }

    for (const row of changedRows) {
      const payload = {
        content: this.formatDiscordMessage(row, targetUrl),
      };

      const response = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(`[scraper/discord] Failed to send webhook. Status: ${response.status} ${await response.text()}`);
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(this.process(env));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await this.process(env);
    return new Response("Scraper executed.", { status: 200 });
  },
};
