import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 900;
const SCROLL_PAUSE_MS = 1500;
const LOAD_WAIT_MS = 3000;

export type ScreenshotResult = {
  files: string[];
  channelUrl: string;
};

/**
 * Resolve Discord test account credentials from environment variables.
 * Set DISCORD_E2E_EMAIL and DISCORD_E2E_PASSWORD before running.
 */
export function resolveDiscordTestAccount(): {
  email: string;
  password: string;
} {
  const email = process.env.DISCORD_E2E_EMAIL;
  const password = process.env.DISCORD_E2E_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Discord visual test credentials not found. Set " +
        "DISCORD_E2E_EMAIL and DISCORD_E2E_PASSWORD environment variables.",
    );
  }
  return { email, password };
}

/**
 * Launch Chrome with a persistent profile so Discord login cookies
 * survive across runs. Uses the system Chrome installation. Set
 * DISCORD_E2E_HEADLESS=1 for headless mode (default: headed).
 */
export async function launchDiscordBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
}> {
  const profileDir = path.join(os.homedir(), ".openclaw", "e2e", "discord-chrome-profile");
  fs.mkdirSync(profileDir, { recursive: true });

  const headless =
    process.env.DISCORD_E2E_HEADLESS === "1" || process.env.DISCORD_E2E_HEADLESS === "true";

  const browser = await chromium.launch({
    channel: "chrome",
    headless,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    storageState: getStorageStatePath(profileDir),
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36",
  });

  return { browser, context };
}

function getStorageStatePath(profileDir: string): string | undefined {
  const statePath = path.join(profileDir, "storage-state.json");
  if (fs.existsSync(statePath)) {
    return statePath;
  }
  return undefined;
}

/**
 * Save the browser context's storage state (cookies, localStorage)
 * to disk so subsequent runs skip the login flow.
 */
export async function saveStorageState(context: BrowserContext): Promise<void> {
  const profileDir = path.join(os.homedir(), ".openclaw", "e2e", "discord-chrome-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  const statePath = path.join(profileDir, "storage-state.json");
  await context.storageState({ path: statePath });
}

/**
 * Ensure the browser page is logged into Discord. If the app shell
 * loads (sidebar with guild list), login is already cached. Otherwise,
 * automate the login form using credentials from env vars.
 *
 * Throws if CAPTCHA is detected — log in manually once and the
 * persistent profile will cache the session for future runs.
 */
export async function ensureDiscordLogin(page: Page): Promise<void> {
  await page.goto("https://discord.com/channels/@me", {
    waitUntil: "networkidle",
    timeout: 30_000,
  });

  // Check if already logged in by looking for the guild sidebar.
  const loggedIn = await page
    .waitForSelector('[data-list-id="guildsnav"]', { timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (loggedIn) {
    return;
  }

  // Not logged in — navigate to login page.
  const { email, password } = resolveDiscordTestAccount();

  await page.goto("https://discord.com/login", {
    waitUntil: "networkidle",
    timeout: 30_000,
  });

  // Fill login form.
  const emailInput = await page.waitForSelector('input[name="email"]', {
    timeout: 10_000,
  });
  if (!emailInput) {
    throw new Error("Could not find Discord login email input");
  }
  await emailInput.fill(email);

  const passwordInput = await page.waitForSelector('input[name="password"]', { timeout: 5000 });
  if (!passwordInput) {
    throw new Error("Could not find Discord login password input");
  }
  await passwordInput.fill(password);

  // Submit.
  await page.click('button[type="submit"]');

  // Wait for either successful login or CAPTCHA.
  const result = await Promise.race([
    page
      .waitForSelector('[data-list-id="guildsnav"]', { timeout: 30_000 })
      .then(() => "logged_in" as const),
    page
      .waitForSelector('iframe[src*="captcha"]', { timeout: 30_000 })
      .then(() => "captcha" as const),
    page.waitForSelector('[class*="hCaptcha"]', { timeout: 30_000 }).then(() => "captcha" as const),
  ]);

  if (result === "captcha") {
    throw new Error(
      "Discord login requires CAPTCHA. Log in manually once in a " +
        "browser, then run saveStorageState() to cache the session.",
    );
  }
}

/**
 * Navigate to a Discord channel and take progressive screenshots
 * by scrolling through the message area. Returns the file paths
 * of all captured PNGs.
 */
export async function captureChannelScreenshots(
  page: Page,
  channelUrl: string,
  outputDir: string,
): Promise<ScreenshotResult> {
  fs.mkdirSync(outputDir, { recursive: true });

  await page.goto(channelUrl, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  await page.waitForTimeout(LOAD_WAIT_MS);

  // Wait for message content to appear.
  await page.waitForSelector('[class*="messageContent"]', { timeout: 10_000 }).catch(() => {
    // Channel might be empty or messages might use a different
    // class — continue anyway and capture whatever is visible.
  });

  // Scroll to the top of the message scroller.
  const scrollerSel = '[class*="scroller"][class*="messages"]';
  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = 0;
  }, scrollerSel);
  await page.waitForTimeout(SCROLL_PAUSE_MS);

  const files: string[] = [];
  let lastScrollTop = -1;
  let idx = 0;

  while (true) {
    const filename = `visual-${String(idx).padStart(2, "0")}.png`;
    const filepath = path.join(outputDir, filename);
    await page.screenshot({
      path: filepath,
      fullPage: false,
    });
    files.push(filepath);

    // Scroll down by 80% of viewport.
    const scrollInfo = await page.evaluate(
      (sel: string, amount: number) => {
        const el = document.querySelector(sel);
        if (!el) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
        el.scrollTop += amount;
        return {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        };
      },
      scrollerSel,
      Math.floor(VIEWPORT_HEIGHT * 0.8),
    );

    if (scrollInfo.scrollTop === lastScrollTop) {
      break;
    }
    lastScrollTop = scrollInfo.scrollTop;

    const atBottom = scrollInfo.scrollTop + scrollInfo.clientHeight >= scrollInfo.scrollHeight - 10;
    if (atBottom) {
      idx++;
      const lastFilename = `visual-${String(idx).padStart(2, "0")}.png`;
      const lastFilepath = path.join(outputDir, lastFilename);
      await page.waitForTimeout(SCROLL_PAUSE_MS);
      await page.screenshot({ path: lastFilepath, fullPage: false });
      files.push(lastFilepath);
      break;
    }

    await page.waitForTimeout(SCROLL_PAUSE_MS);
    idx++;
  }

  return { files, channelUrl };
}
