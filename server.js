import express from "express";
import cors from "cors";
import { PlaywrightCrawler, ProxyConfiguration } from "crawlee";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

// Activate open-source stealth patches
chromium.use(stealthPlugin());

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -------------------- BUILD SEARCH URL --------------------
function buildTargetUrl({ query, country, city, industry, jobTitle }) {
  const searchParts = [query, industry, jobTitle, city, country]
    .filter(Boolean)
    .join(" ");

  return `https://www.google.com/search?q=${encodeURIComponent(searchParts)}&num=10`;
}

// -------------------- BLOCKED DOMAINS --------------------
function isValidBusinessLink(url) {
  const blocked = [
    "google.com", "facebook.com", "linkedin.com", "instagram.com",
    "twitter.com", "x.com", "youtube.com", "maps.google", "support.google",
    "accounts.google"
  ];
  return !blocked.some((d) => url.includes(d));
}

function extractBusinessLinks(html) {
  const links = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
  return links.filter(
    (link) => isValidBusinessLink(link) && !link.includes("search?") && !link.includes("sorry/")
  );
}

// -------------------- REGEX EXTRACTIONS --------------------
function extractEmails(text) {
  return [...new Set(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])];
}

function extractPhones(text) {
  return [...new Set(text.match(/(\+?\d[\d\s().-]{7,}\d)/g) || [])];
}

// -------------------- SCRAPER ENGINE --------------------
async function scrapeLeadWebsite(startUrl, maxPages = 3) {
  const safeMaxPages = Math.max(Number(maxPages) || 3, 5);
  const visited = new Set();
  const queued = new Set();

  const pages = [];
  const emailsSet = new Set();
  const phonesSet = new Set();
  const businessLinksSet = new Set();

  // Premium authenticated Webshare proxy pool strings
  const proxyConfiguration = new ProxyConfiguration({
    proxyUrls: [
      "http://amrztcmk:o4zemvlhwcgy@31.59.20.176:6754",
      "http://amrztcmk:o4zemvlhwcgy@31.56.127.193:7684",
      "http://amrztcmk:o4zemvlhwcgy@45.38.107.97:6014",
      "http://amrztcmk:o4zemvlhwcgy@38.154.203.95:5863",
      "http://amrztcmk:o4zemvlhwcgy@198.105.121.200:6462",
      "http://amrztcmk:o4zemvlhwcgy@64.137.96.74:6641",
      "http://amrztcmk:o4zemvlhwcgy@198.23.243.226:6361",
      "http://amrztcmk:o4zemvlhwcgy@38.154.185.97:6370",
      "http://amrztcmk:o4zemvlhwcgy@142.111.67.146:5611",
      "http://amrztcmk:o4zemvlhwcgy@191.96.254.138:6185"
    ],
  });

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: safeMaxPages,
    minConcurrency: 1,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60000,
    proxyConfiguration, 

    // ✅ ENABLE SESSION CONTROL: Keeps unique cookies per session layer
    useSessionPool: true,
    sessionPoolOptions: {
      maxPoolSize: 20,
    },

    launchContext: {
      launcher: chromium,
      launchOptions: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled"
        ],
      },
    },

    // ✅ FIXED PRE-NAV: Simulates natural human thinking pauses + proper HTTP contexts
    preNavigationHooks: [
      async ({ page }) => {
        const preWait = Math.floor(Math.random() * 3000) + 2000;
        console.log(`🕒 Simulating human thinking path: Waiting ${preWait}ms...`);
        await page.waitForTimeout(preWait);

        await page.context().setExtraHTTPHeaders({
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        });
      },
    ],

    // ✅ REQUEST HANDLER: Exposes session states to cycle out flagged proxy links
    async requestHandler({ request, page, session }) {
      const currentUrl = request.url;
      if (visited.has(currentUrl)) return;
      visited.add(currentUrl);

      console.log(`🔎 Navigating browser to: ${currentUrl}`);

      // Run navigation handling rules
      const response = await page.goto(currentUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      }).catch(() => null);

      // Random human post-load pacing break
      await page.waitForTimeout(Math.floor(Math.random() * 2000) + 1500);

      // ✅ DETECT 429 LIMIT BLOCKS: Retire proxy session immediately and retry
      if (response && (response.status() === 429 || page.url().includes("sorry/index"))) {
        console.error(`⚠️ Proxy IP flagged with a 429 rate-limit by Google. Discarding session proxy...`);
        if (session) session.retire(); 
        throw new Error("Rate limit block hit. Retrying request with a fresh proxy instance.");
      }

      if (await page.$('iframe[src*="recaptcha"]')) {
        console.error("⚠️ Caught by Google Recaptcha Shield on: " + currentUrl);
        if (session) session.retire();
        return;
      }

      // ✅ ROUTE A: Parse Google Search results layout cleanly using explicit DOM elements
      if (currentUrl.includes("google.com/search")) {
        console.log("Analyzing Google search results layout...");
        
        // Wait safely for the primary results block to populate
        await page.waitForSelector("#search", { timeout: 8000 }).catch(() => null);
        
        // Isolate organic result anchor nodes away from tracking domains
        const discoveredLinks = await page.$$eval("#search a[href]", (elements) => {
          return elements
            .map((el) => el.href)
            .filter((href) => {
              if (!href) return false;
              const blocked = [
                "google.com", "facebook.com", "linkedin.com", "instagram.com",
                "twitter.com", "x.com", "youtube.com", "maps.google", "support.google",
                "accounts.google", "search?"
              ];
              return !blocked.some((d) => href.includes(d));
            });
        }).catch(() => []);

        // Fallback robust string matching if dynamic selector changes unexpectedly
        let finalLinks = [...new Set(discoveredLinks)];
        if (finalLinks.length === 0) {
          console.log("⚠️ DOM targeting returned 0, running regex string fallback sequence...");
          const htmlContent = await page.content().catch(() => "");
          finalLinks = extractBusinessLinks(htmlContent);
        }

        console.log(`✅ Successfully extracted ${finalLinks.length} target business domains from Google Search!`);

        const targetRequests = [];
        for (const link of finalLinks.slice(0, 5)) {
          const cleanLink = link.split("#")[0];
          if (!visited.has(cleanLink) && !queued.has(cleanLink)) {
            queued.add(cleanLink);
            businessLinksSet.add(cleanLink);
            targetRequests.push({ url: cleanLink });
          }
        }

        if (targetRequests.length > 0) {
          console.log(`Adding ${targetRequests.length} business targets to deep crawler queue...`);
          await crawler.addRequests(targetRequests);
        }
        return; 
      }

      // -------------------- ROUTE B: Target Business Domain Scraping --------------------
      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const html = await page.content().catch(() => "");

      const emails = extractEmails(bodyText + " " + html);
      emails.forEach((e) => emailsSet.add(e));

      const phones = extractPhones(bodyText + " " + html);
      phones.forEach((p) => phonesSet.add(p));

      pages.push({ url: currentUrl, title, emails, phones });

      const subLinks = await page.$$eval("a[href]", (elements) => elements.map((el) => el.href)).catch(() => []);
      const currentOrigin = new URL(currentUrl).origin;
      const internalRequests = [];

      for (const link of subLinks) {
        try {
          const cleanSub = link.split("#")[0];
          if (cleanSub.startsWith(currentOrigin) && !visited.has(cleanSub) && !queued.has(cleanSub)) {
            const lowerPath = cleanSub.toLowerCase();
            if (lowerPath.includes("contact") || lowerPath.includes("about") || lowerPath.includes("info")) {
              queued.add(cleanSub);
              internalRequests.push({ url: cleanSub });
            }
          }
        } catch {}
      }

      if (internalRequests.length > 0) {
        await crawler.addRequests(internalRequests.slice(0, 2));
      }
    },
  });

  // Target direct clean initialization array inputs
  await crawler.addRequests([{ url: startUrl }]);
  await crawler.run();

  return {
    scrapedDomain: startUrl.includes("google.com") ? "https://www.google.com" : new URL(startUrl).origin,
    totalPagesScraped: pages.length,
    emails: [...emailsSet],
    phones: [...phonesSet],
    businessLinks: [...businessLinksSet],
    pages,
  };
}

// -------------------- MAIN API --------------------
app.post("/scrape", async (req, res) => {
  try {
    const { url, query, country, city, industry, jobTitle, maxPages } = req.body;

    let targetUrl = url;
    if (!targetUrl) {
      targetUrl = buildTargetUrl({ query, country, city, industry, jobTitle });
    }

    console.log(`🚀 Triggering scraper engine sequence for target: ${targetUrl}`);
    const result = await scrapeLeadWebsite(targetUrl, maxPages || 3);

    res.json({
      success: true,
      filtersUsed: { url, query, country, city, industry, jobTitle },
      meta: {
        emailsFound: result.emails.length,
        phonesFound: result.phones.length,
        businessLinksFound: result.businessLinks.length,
        pagesScraped: result.totalPagesScraped,
      },
      data: result,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------- HEALTH ROUTES --------------------
app.get("/", (req, res) => res.json({ success: true, message: "API running" }));
app.get("/health", (req, res) => res.json({ success: true, status: "healthy" }));

// -------------------- START SERVER --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Scraper running on port ${PORT}`);
});
